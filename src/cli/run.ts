import fs from 'node:fs/promises';
import { constants, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
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
async function tempRoot(): Promise<string> {
  if (!process.getuid) fail('unsupported_platform'); const root = join(tmpdir(),`psm-${process.getuid()}`);
  try { await fs.mkdir(root,{mode:0o700}); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await ownedDirectory(root);
  for (const name of await fs.readdir(root)) {
    const match = /^run-([1-9][0-9]*)-[0-9a-f]{16}$/.exec(name); if (!match) continue;
    try { process.kill(Number(match[1]),0); continue; } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
    try {
      const path = join(root,name); await ownedDirectory(path); const entries = await fs.readdir(path);
      const children = entries.filter(entry => /^\.child-[1-9][0-9]*$/.test(entry));
      if (!children.length && (!entries.includes('.preparing') || entries.includes('.launching'))) continue;
      let live = false;
      for (const entry of children) { try { process.kill(Number(entry.slice(7)),0); live = true; } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') live = true; } }
      if (!live) await removeDirectory(path);
    } catch { /* Ambiguous entries belong to neither this run nor cleanup. */ }
  }
  return root;
}
export interface RunResult { code: number | null; signal: NodeJS.Signals | null }
export async function runCommand(config: Config, secrets: ResolvedSecret[], command: string[]): Promise<RunResult> {
  let child: ChildProcess | undefined, directory: string | undefined, received: NodeJS.Signals | null = null;
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) { const listener = () => { received ??= signal; child?.kill(signal); }; listeners.set(signal,listener); process.on(signal,listener); }
  const interrupted = () => { if (received) fail('interrupted'); };
  try {
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
      child = spawn(command[0]!,command.slice(1),{env,stdio:'inherit',shell:false});
      let markerError = false;
      if (directory && child.pid) {
        try { writeFileSync(join(directory,`.child-${child.pid}`),'',{flag:'wx',mode:0o600}); unlinkSync(join(directory,'.launching')); }
        catch { markerError = true; child.kill('SIGTERM'); }
      }
      child.once('error',() => reject(new Error('child_failed')));
      child.once('exit',(code,signal) => markerError ? reject(new Error('preparation_failed')) : resolve({code,signal}));
    });
    return {code:result.code,signal:received ?? result.signal};
  } catch(error) { if (received) return {code:null,signal:received}; throw error; }
  finally {
    try { if (directory) await removeDirectory(directory); }
    finally { for (const [signal,listener] of listeners) process.removeListener(signal,listener); }
  }
}
