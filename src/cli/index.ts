#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { configure, loadSettings, fail } from './config.js';
import { login, resolveSecrets } from './client.js';
import { runCommand, cleanupStaleRuns } from './run.js';
import { manage, option, required, selectedTarget, type Options } from './manage.js';
import { AdminClient } from './admin.js';
import { AppError } from '../shared/errors.js';

const usage = `Usage:
  psm configure --admin-url ORIGIN
  psm login [--admin-url ORIGIN] [--config FILE]
  psm init [--project SLUG] [--env dev] [--confirm]
  psm project list|create|update|delete
  psm environment list|create|update|delete
  psm secret list|create|update|delete
  psm bind --name KEY --to VARIABLE [--confirm]
  psm import preview --file DOTENV > PLAN.json
  psm import apply --file DOTENV --plan PLAN.json [--names A,B] [--confirm]
  psm run [--project SLUG --env NAME] [--ci] -- COMMAND ARGS

Management options:
  --config FILE       Project config (default: ./psm.json)
  --admin-url ORIGIN  Override project/user server address
  --project SLUG      Project selector (default: saved connection)
  --env NAME          Environment selector (default: saved connection)
  --name NAME         Resource name; --slug SLUG for project create/update
  --id UUID          Exact resource to update/delete
  --kind env|file     Secret kind (create default: env)
  --file FILE | --from-env NAME | --stdin   Secret input, never a literal value
  --confirm          Required after user confirmation for existing changes/deletes
  --expected-version UUID   Version observed before confirming secret change/delete

Management stdout is JSON metadata only. Errors are JSON codes on stderr.
Use init before bind; run requires nonempty mappings and inherits child stdio.
HTTPS origins are required; local loopback HTTP is supported.
`;
const stringOptions = ['config','admin-url','project','env','name','slug','id','kind','file','from-env','expected-version','to','plan','names'];
const booleanOptions = ['confirm','stdin','ci'];
const common = ['config','admin-url'];
const target = [...common,'project','env'];
const input = ['file','from-env','stdin'];
function allowed(action: string, verb?: string): string[] {
  if (action==='configure') return ['admin-url'];
  if (action==='login') return common;
  if (action==='init') return [...target,'confirm'];
  if (action==='bind') return [...common,'name','to','confirm'];
  if (action==='run') return [...target,'ci'];
  if (action==='project') return [...common,...(verb==='list'?[]:verb==='create'?['name','slug']:verb==='update'?['id','name','slug','confirm']:['id','confirm'])];
  if (action==='environment') return [...common,...(verb==='list'?['project']:verb==='create'?['project','name']:verb==='update'?['id','name','confirm']:['id','confirm'])];
  if (action==='secret') return [...target,...(verb==='list'?[]:verb==='create'?['name','kind',...input]:verb==='update'?['id','expected-version','confirm','name','kind',...input]:['id','expected-version','confirm'])];
  if (action==='import') return [...target,'file',...(verb==='apply'?['plan','names','confirm']:[])];
  fail('invalid_usage');
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length===1 && ['--help','-h','help'].includes(args[0]!)) { process.stdout.write(usage); return; }
  const action = args.shift()!;
  const separator = args.indexOf('--');
  const command = separator<0?[]:args.slice(separator+1);
  if (separator>=0 && action!=='run') fail('invalid_usage');
  const ownArgs = separator<0?args:args.slice(0,separator);
  if (ownArgs.includes('--help') || ownArgs.includes('-h')) { process.stdout.write(usage); return; }
  let options: Options, positions: string[];
  try {
    const parsed = parseArgs({args:ownArgs,allowPositionals:true,tokens:true,options:Object.fromEntries([...stringOptions.map(key=>[key,{type:'string' as const}]),...booleanOptions.map(key=>[key,{type:'boolean' as const}])])});
    options={}; positions=parsed.positionals;
    for (const [key,value] of Object.entries(parsed.values)) { if (typeof value!=='string' && typeof value!=='boolean' && value!==undefined) fail('invalid_usage'); options[key]=value; }
    const seen = new Set<string>(); for (const token of parsed.tokens) if (token.kind==='option') { if (seen.has(token.name)) fail('invalid_usage'); seen.add(token.name); }
  } catch { fail('invalid_usage'); }
  const grouped = ['project','environment','secret','import'].includes(action);
  if (positions.length !== (grouped?1:0) || (grouped && !(action==='import'?['preview','apply']:['list','create','update','delete']).includes(positions[0]!))) fail('invalid_usage');
  const verb = positions[0], keys = allowed(action,verb);
  if (Object.keys(options).some(key=>!keys.includes(key))) fail('invalid_usage');
  if (action==='configure') { output(await configure(required(options,'admin-url'))); return; }
  if (action==='run' && (!command.length || !command[0])) fail('invalid_usage');
  const path = option(options,'config') ?? 'psm.json';
  const config = await loadSettings(path,options.config!==undefined,option(options,'admin-url'));
  await cleanupStaleRuns();
  if (action==='login') { await login(config); output({ok:true}); return; }
  if (action!=='run') { output(await manage(action,verb,options,config,path)); return; }
  if (!Object.keys(config.secrets).length) fail('missing_mappings');
  const project = option(options,'project') ?? config.project, environment = option(options,'env') ?? config.environment;
  if (!project || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project) || project.length>128 || !environment || environment.length>128 || environment.trim()!==environment || /[\x00-\x1f\x7f]/.test(environment)) fail('invalid_usage');
  const ci = options.ci===true;
  if (!ci && config.projectId) await selectedTarget(new AdminClient(config.adminUrl),config,options);
  const values = await resolveSecrets(config,project,environment,ci);
  const result = await runCommand(config,values,command);
  if (result.signal) process.kill(process.pid,result.signal); else process.exitCode=result.code ?? 1;
}
function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
main().catch(error=>{const code=error instanceof AppError?error.code:'operation_failed';process.stderr.write(`${JSON.stringify({error:{code}})}\n`);process.exitCode=1;});
