import fs from 'node:fs/promises';
import { constants, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fail, type Config } from './config.js';
import type { ResolvedSecret } from '../shared/types.js';

const signals: NodeJS.Signals[] = ['SIGINT','SIGTERM','SIGHUP'];
async function ownedDirectory(path: string): Promise<void> {
  const info = await fs.lstat(path); if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) fail('unsafe_temp_directory');
}
async function removeDirectory(path: string): Promise<void> {
  await ownedDirectory(path);
  const names = await fs.readdir(path);
  for (const name of names) {
    const info = await fs.lstat(join(path,name));
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) fail('unsafe_temp_directory');
  }
  for (const name of names) await fs.unlink(join(path,name)); await fs.rmdir(path);
}
function rootPath(): string {
  if (!process.getuid || !['darwin','linux'].includes(process.platform)) fail('unsupported_platform');
  return join(tmpdir(),`psm-${process.getuid()}`);
}
function exists(pid: number): boolean {
  try { process.kill(pid,0); return true; } catch(error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export async function cleanupStaleRuns(): Promise<void> {
  const root=rootPath();
  try { await ownedDirectory(root); } catch(error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of await fs.readdir(root)) {
    const match = /^run-([1-9][0-9]*)-[0-9a-f]{16}$/.exec(name); if (!match) continue;
    if (exists(Number(match[1]))) continue;
    try {
      const path = join(root,name); await ownedDirectory(path); const entries = await fs.readdir(path);
      const children = entries.filter(entry => /^\.child-[1-9][0-9]*$/.test(entry));
      const groups=entries.filter(entry => /^\.group-[1-9][0-9]*$/.test(entry));
      if (entries.includes('.launching') || groups.length>1 || entries.some(entry=>entry.startsWith('.group-')&&!groups.includes(entry))) continue;
      // Legacy child-only markers cannot exclude descendants after their leader exits.
      if (children.length && !groups.length) continue;
      if (!groups.length && !entries.includes('.preparing')) continue;
      if (!children.some(entry=>exists(Number(entry.slice(7)))) && !groups.some(entry=>exists(-Number(entry.slice(7))))) await removeDirectory(path);
    } catch { /* Ambiguous entries belong to neither this run nor cleanup. */ }
  }
}
async function tempRoot(): Promise<string> {
  const root=rootPath();
  try { await fs.mkdir(root,{mode:0o700}); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await ownedDirectory(root); return root;
}
const inspectProcesses=promisify(execFile);
async function groupRunning(group: number): Promise<boolean> {
  // Exited Linux orphans may remain zombies; they cannot use a secret file.
  const {stdout}=await inspectProcesses('/bin/ps',['-eo','pgid=,stat='],{maxBuffer:4*1024*1024});
  return stdout.split('\n').some(line=>{const [id,state]=line.trim().split(/\s+/);return Number(id)===group && state && !state.startsWith('Z');});
}
export interface RunResult { code: number | null; signal: NodeJS.Signals | null }
export async function runCommand(config: Config, secrets: ResolvedSecret[], command: string[]): Promise<RunResult> {
  let child: ChildProcess | undefined, group: number | undefined, directory: string | undefined, received: NodeJS.Signals | null = null;
  let safeToRemove=true;
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) { const listener = () => { received ??= signal; if (group) { try { process.kill(-group,signal); } catch(error) { if ((error as NodeJS.ErrnoException).code==='ESRCH') group=undefined; } } }; listeners.set(signal,listener); process.on(signal,listener); }
  const interrupted = () => { if (received) fail('interrupted'); };
  try {
    rootPath();
    const env = {...process.env}; const values = new Map(secrets.map(item => [item.name,item.value]));
    const files = Object.entries(config.secrets).filter(([,item]) => item.kind === 'file');
    if (files.length) { const root = await tempRoot(); interrupted(); directory = join(root,`run-${process.pid}-${randomBytes(8).toString('hex')}`); await fs.mkdir(directory,{mode:0o700}); await ownedDirectory(directory); await fs.writeFile(join(directory,'.preparing'),'',{flag:'wx',mode:0o600}); }
    for (const [destination,item] of Object.entries(config.secrets)) {
      interrupted(); const value = values.get(item.name)!;
      if (item.kind === 'env') env[destination] = value;
      else {
        const path = join(directory!,destination); const handle = await fs.open(path,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
        try { await handle.writeFile(value,'utf8'); } finally { await handle.close(); }
        interrupted(); env[destination] = path;
      }
    }
    interrupted();
    if (directory) await fs.writeFile(join(directory,'.launching'),'',{flag:'wx',mode:0o600});
    interrupted();
    const result = await new Promise<RunResult>((resolve,reject) => {
      child = spawn(command[0]!,command.slice(1),{env,stdio:'inherit',shell:false,detached:true});
      group=child.pid; safeToRemove=!group;
      let markerError = false;
      if (directory && child.pid) {
        try { writeFileSync(join(directory,`.group-${child.pid}`),'',{flag:'wx',mode:0o600}); unlinkSync(join(directory,'.launching')); }
        catch { markerError = true; if (group) process.kill(-group,'SIGTERM'); }
      }
      child.once('error',() => {group=undefined;safeToRemove=true;reject(new Error('child_failed'));});
      child.once('exit',(code,signal) => {
        void (async()=>{
          while (group && await groupRunning(group)) await new Promise(done=>setTimeout(done,25));
          group=undefined;safeToRemove=true;
          if (markerError) reject(new Error('preparation_failed')); else resolve({code,signal});
        })().catch(()=>reject(new Error('process_state_unknown')));
      });
    });
    return {code:result.code,signal:received ?? result.signal};
  } catch(error) { if (received) return {code:null,signal:received}; throw error; }
  finally {
    try { if (directory && safeToRemove) await removeDirectory(directory); }
    finally { for (const [signal,listener] of listeners) process.removeListener(signal,listener); }
  }
}
