import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { AdminClient, confirmation, id, secretMetadata } from './admin.js';
import { fail, object, safeName, settingsPath, strictJson } from './config.js';
import { readSecretInput } from './input.js';
import { parseDotenv } from '../shared/imports.js';
import type { Project, Environment, ImportEntry, Secret, SecretKind } from '../shared/types.js';

interface Entry { name: string; exists: boolean; deleted: boolean; kindBefore: SecretKind | null; kindAfter: 'env'; expectedVersionId?: string }
interface Plan { version: 2; adminUrl: string; projectId: string; environmentId: string; sourceTag: string; entries: Entry[] }
interface ImportOptions { file: string; plan?: string; names?: string; confirmed: boolean }
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
async function sourceTag(source: string, create = false): Promise<string> {
  const directory = dirname(settingsPath()), path = join(directory,'import.key');
  try {
    if (create) await fs.mkdir(directory,{recursive:true,mode:0o700});
    const root = await fs.lstat(directory);
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o777) !== 0o700) fail('invalid_import_key');
    if (create) {
      try { await fs.writeFile(path,randomBytes(32),{flag:'wx',mode:0o600}); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const handle = await fs.open(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size !== 32) fail('invalid_import_key');
      const key = await handle.readFile(); if (key.length !== 32) fail('invalid_import_key');
      // An unkeyed digest in agent-visible output permits guessing short secrets offline.
      return createHmac('sha256',key).update(source,'utf8').digest('hex');
    } finally { await handle.close(); }
  } catch { fail('invalid_import_key'); }
}
function fields(value: Record<string,unknown>, keys: string[], code: string): void { if (Object.keys(value).some(key=>!keys.includes(key))) fail(code); }

async function preview(admin: AdminClient, project: Project, environment: Environment, source: string): Promise<Plan> {
  const local = parseDotenv(source); if (local.some(entry=>entry.value.includes('\0'))) fail('invalid_input');
  const result = await admin.request('POST','/api/imports/preview',{environmentId:environment.id,source});
  if (!object(result) || !Array.isArray(result.entries) || result.entries.length!==local.length) fail('invalid_response');
  const metadata = new Map((await admin.secrets(environment.id)).map(secret=>[secret.name,secret]));
  const seen = new Set<string>();
  const entries: Entry[] = result.entries.map((raw: unknown)=>{
    if (!object(raw) || !safeName(raw.name) || seen.has(raw.name) || typeof raw.exists!=='boolean' || typeof raw.deleted!=='boolean') fail('invalid_response');
    seen.add(raw.name); const input=local.find(entry=>entry.name===raw.name); if (!input || raw.value!==input.value) fail('invalid_response');
    if (raw.exists) id(raw.expectedVersionId); else if (raw.expectedVersionId!==undefined || raw.deleted) fail('invalid_response');
    const active=metadata.get(raw.name);
    if (raw.exists && !raw.deleted && (!active || active.currentVersionId!==raw.expectedVersionId)) fail('conflict');
    if (!raw.exists && active) fail('conflict');
    return {name:raw.name,exists:raw.exists,deleted:raw.deleted,kindBefore:active?.kind??null,kindAfter:'env',...(raw.exists?{expectedVersionId:raw.expectedVersionId as string}:{})};
  });
  return {version:2,adminUrl:admin.adminUrl,projectId:project.id,environmentId:environment.id,sourceTag:await sourceTag(source,true),entries};
}
function parsePlan(raw: unknown): Plan {
  if (!object(raw)) fail('invalid_plan');
  fields(raw,['version','adminUrl','projectId','environmentId','sourceTag','entries'],'invalid_plan');
  if (raw.version!==2 || typeof raw.adminUrl!=='string' || typeof raw.sourceTag!=='string' || !/^[a-f0-9]{64}$/.test(raw.sourceTag) || !Array.isArray(raw.entries) || !raw.entries.length || raw.entries.length>100) fail('invalid_plan');
  id(raw.projectId); id(raw.environmentId); const seen=new Set<string>();
  const entries: Entry[]=raw.entries.map((value:unknown)=>{
    if (!object(value)) fail('invalid_plan');
    fields(value,['name','exists','deleted','kindBefore','kindAfter','expectedVersionId'],'invalid_plan');
    if (!safeName(value.name) || seen.has(value.name) || typeof value.exists!=='boolean' || typeof value.deleted!=='boolean' || ![null,'env','file'].includes(value.kindBefore as string|null) || value.kindAfter!=='env') fail('invalid_plan');
    seen.add(value.name);
    if (value.exists) id(value.expectedVersionId); else if (value.expectedVersionId!==undefined || value.deleted || value.kindBefore!==null) fail('invalid_plan');
    return {name:value.name,exists:value.exists,deleted:value.deleted,kindBefore:value.kindBefore as SecretKind|null,kindAfter:'env',...(value.exists?{expectedVersionId:value.expectedVersionId as string}:{})};
  });
  return {version:2,adminUrl:raw.adminUrl,projectId:raw.projectId as string,environmentId:raw.environmentId as string,sourceTag:raw.sourceTag,entries};
}
function sameEntry(a: Entry,b: Entry): boolean { return a.name===b.name && a.exists===b.exists && a.deleted===b.deleted && a.kindBefore===b.kindBefore && a.kindAfter===b.kindAfter && a.expectedVersionId===b.expectedVersionId; }
function importResult(raw: unknown, names: string[]): {secrets: Secret[]} {
  if (!object(raw) || !Array.isArray(raw.secrets)) fail('invalid_response');
  const secrets=raw.secrets.map(secretMetadata);
  if (secrets.length!==names.length || new Set(secrets.map(secret=>secret.name)).size!==names.length || secrets.some(secret=>!names.includes(secret.name) || secret.kind!=='env' || secret.deletedAt!==null)) fail('invalid_response');
  return {secrets};
}
export async function importSecrets(admin: AdminClient, project: Project, environment: Environment, verb: string, options: ImportOptions): Promise<unknown> {
  const source = await readSecretInput({file:options.file},131072);
  if (verb==='preview') return preview(admin,project,environment,source);
  if (!options.plan) fail('invalid_usage');
  const plan=parsePlan(strictJson(await readSecretInput({file:options.plan},131072)));
  if (plan.adminUrl!==admin.adminUrl || plan.projectId!==project.id || plan.environmentId!==environment.id || plan.sourceTag!==await sourceTag(source)) fail('plan_mismatch');
  const names=options.names===undefined?plan.entries.map(entry=>entry.name):options.names.split(',');
  if (!names.length || new Set(names).size!==names.length || names.some(name=>!safeName(name) || !plan.entries.some(entry=>entry.name===name))) fail('invalid_usage');
  const selected=plan.entries.filter(entry=>names.includes(entry.name));
  if (selected.some(entry=>entry.deleted)) fail('conflict');
  if (selected.some(entry=>entry.exists)) confirmation(options.confirmed);
  const current=await preview(admin,project,environment,source);
  if (plan.entries.length!==current.entries.length || selected.some(entry=>{const actual=current.entries.find(item=>item.name===entry.name);return !actual || !sameEntry(entry,actual);})) fail('conflict');
  const values=new Map(parseDotenv(source).map(entry=>[entry.name,entry.value]));
  const entries:ImportEntry[]=selected.map(entry=>({name:entry.name,value:values.get(entry.name)!,...(entry.expectedVersionId?{expectedVersionId:entry.expectedVersionId}:{})}));
  if (bytes(entries)>131072) fail('input_too_large');
  if (entries.length<=10 && entries.reduce((sum,entry)=>sum+Buffer.byteLength(entry.value),0)<=65536) return importResult(await admin.request('POST','/api/imports/apply',{environmentId:environment.id,entries}),names);
  const operation=await admin.request('POST','/api/operations',{kind:'import',environmentId:environment.id,counts:{imports:entries.length}});
  if (!object(operation)) fail('invalid_response'); const operationId=id(operation.id);
  let chunk:ImportEntry[]=[],valueBytes=0,index=0;
  const upload=async()=>{
    const result=await admin.request('POST',`/api/operations/${operationId}/chunks`,{index,table:'imports',rows:chunk});
    if (!object(result) || result.ok!==true) fail('invalid_response'); index++;chunk=[];valueBytes=0;
  };
  for (const entry of entries) {
    const size=Buffer.byteLength(entry.value); if (chunk.length && (chunk.length===10 || valueBytes+size>65536)) await upload();
    chunk.push(entry);valueBytes+=size;
  }
  if (chunk.length) await upload();
  const result=await admin.request('POST',`/api/operations/${operationId}/commit`,{});
  if (!object(result) || result.ok!==true) fail('invalid_response');
  return importResult({secrets:(await admin.secrets(environment.id)).filter(secret=>names.includes(secret.name))},names);
}
