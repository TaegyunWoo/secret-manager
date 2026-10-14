#!/usr/bin/env node
import { loadConfig, fail } from './config.js';
import { login, resolveSecrets } from './client.js';
import { runCommand } from './run.js';
import { AppError } from '../shared/errors.js';

const usage = `Usage:
  psm login [--config psm.json]
  psm run --project SLUG --env NAME [--config FILE] [--ci] -- COMMAND ARGS

Config contains adminUrl, optional ciUrl, and secrets mappings only.
HTTPS origins are required; local loopback HTTP is supported.
Run inherits the environment, injects selected secrets, and removes temporary files.
`;
async function main(): Promise<void> {
  const args = process.argv.slice(2); if (args.length === 1 && ['--help','-h','help'].includes(args[0]!)) { process.stdout.write(usage); return; }
  const action = args.shift(); if (action !== 'login' && action !== 'run') fail('invalid_usage');
  if (args.includes('--help') && !args.includes('--')) { process.stdout.write(usage); return; }
  let path = 'psm.json', project: string | undefined, environment: string | undefined, ci = false, command: string[] = []; const seen = new Set<string>();
  while (args.length) {
    const arg = args.shift()!; if (arg === '--' && action === 'run') { command = args.splice(0); break; }
    if (seen.has(arg)) fail('invalid_usage'); seen.add(arg);
    if (arg === '--ci' && action === 'run') {ci=true;continue;}
    if (!['--config',...(action === 'run' ? ['--project','--env'] : [])].includes(arg)) fail('invalid_usage');
    const value = args.shift(); if (!value || value.startsWith('--')) fail('invalid_usage');
    if (arg === '--config') path=value; else if (arg === '--project') project=value; else environment=value;
  }
  if (action === 'run' && (!project || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project) || project.length > 128 || !environment || environment.length > 128 || environment.trim() !== environment || /[\x00-\x1f\x7f]/.test(environment) || !command.length || !command[0])) fail('invalid_usage');
  const config = await loadConfig(path);
  if (action === 'login') { await login(config); process.stdout.write('Access login complete.\n'); return; }
  const values = await resolveSecrets(config,project!,environment!,ci);
  const result = await runCommand(config,values,command);
  if (result.signal) process.kill(process.pid,result.signal); else process.exitCode = result.code ?? 1;
}
main().catch(error => { process.stderr.write(`psm: ${error instanceof AppError ? error.code : 'operation_failed'}\n`); process.exitCode=1; });
