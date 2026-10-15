import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, resolve } from 'node:path';
import { AdminClient, confirmation, id } from './admin.js';
import { fail, safeName, saveJson, type Config } from './config.js';
import { readSecretInput, type SecretSource } from './input.js';
import { importSecrets } from './import.js';
import type { Project, Environment, SecretKind, SecretUpdate } from '../shared/types.js';

export type Options = Record<string, string | boolean | undefined>;
export function option(options: Options, name: string): string | undefined { const value = options[name]; return typeof value === 'string' ? value : undefined; }
export function required(options: Options, name: string): string { const value = option(options, name); if (!value) fail('invalid_usage'); return value; }
const confirmed = (options: Options) => options.confirm === true;
function source(options: Options): SecretSource { return { file: option(options,'file'), fromEnv: option(options,'from-env'), stdin: options.stdin === true }; }
function kind(options: Options, fallback: SecretKind = 'env'): SecretKind { const value = option(options,'kind') ?? fallback; if (value !== 'env' && value !== 'file') fail('invalid_usage'); return value; }
function name(options: Options): string { const value = required(options,'name'); if (!safeName(value)) fail('invalid_usage'); return value; }
export async function selectedProject(admin: AdminClient, config: Config, options: Options): Promise<Project> {
  const slug = option(options, 'project') ?? config.project; if (!slug) fail('missing_project');
  const project = (await admin.projects()).find(item => item.slug === slug);
  if ((!option(options,'project') || option(options,'project')===config.project) && config.projectId && (!project || project.id !== config.projectId)) fail('connection_changed');
  if (!project) fail('not_found'); return project;
}
export async function selectedTarget(admin: AdminClient, config: Config, options: Options): Promise<{ project: Project; environment: Environment }> {
  const project = await selectedProject(admin,config,options);
  const env = option(options,'env') ?? config.environment; if (!env) fail('missing_environment');
  const environment = (await admin.environments(project.id)).find(item => item.name === env);
  const usingBoundProject = !option(options,'project') || option(options,'project') === config.project;
  if (usingBoundProject && (!option(options,'env') || option(options,'env')===config.environment) && config.environmentId && (!environment || environment.id !== config.environmentId)) fail('connection_changed');
  if (!environment) fail('not_found'); return { project, environment };
}
async function init(admin: AdminClient, config: Config, options: Options, path: string): Promise<unknown> {
  if (config.projectId && (!option(options,'project') || option(options,'project')===config.project) && (!option(options,'env') || option(options,'env')===config.environment)) return selectedTarget(admin,config,options);
  if (config.projectId) confirmation(confirmed(options));
  let root = process.cwd();
  try { root = (await promisify(execFile)('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8'})).stdout.trim(); } catch { /* A directory without Git is also a project. */ }
  const slug = option(options,'project') ?? config.project ?? basename(root).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  if (!slug || slug.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) fail('invalid_project_name');
  const environmentName = option(options,'env') ?? config.environment ?? 'dev';
  if (!environmentName || environmentName.length > 128 || environmentName.trim() !== environmentName || /[\x00-\x1f\x7f]/.test(environmentName)) fail('invalid_usage');
  const usesSavedProject = config.projectId && (!option(options,'project') || option(options,'project')===config.project);
  let project = usesSavedProject ? await selectedProject(admin,config,options) : (await admin.projects()).find(item=>item.slug===slug);
  if (project) { if (!usesSavedProject) confirmation(confirmed(options)); }
  else project = await admin.createProject({name:slug,slug});
  let environment = (await admin.environments(project.id)).find(item=>item.name===environmentName);
  environment ??= await admin.createEnvironment({projectId:project.id,name:environmentName});
  const saved: Config = {...config,project:project.slug,projectId:project.id,environment:environment.name,environmentId:environment.id};
  await saveJson(path,saved); return {project,environment,config:resolve(path)};
}
export async function manage(action: string, verb: string | undefined, options: Options, config: Config, path: string): Promise<unknown> {
  const admin = new AdminClient(config.adminUrl);
  if (action === 'init') return init(admin,config,options,path);
  if (action === 'project') {
    if (verb === 'list') return {projects:await admin.projects()};
    if (verb === 'create') return admin.createProject({name:required(options,'name'),slug:required(options,'slug')});
    const target = id(required(options,'id')); confirmation(confirmed(options));
    if (verb === 'update') return admin.updateProject(target,{name:required(options,'name'),slug:required(options,'slug')},true);
    return admin.deleteProject(target,true);
  }
  if (action === 'environment') {
    if (verb === 'list') return {environments:await admin.environments(option(options,'project') || config.project ? (await selectedProject(admin,config,options)).id : undefined)};
    if (verb === 'create') return admin.createEnvironment({projectId:(await selectedProject(admin,config,options)).id,name:required(options,'name')});
    const target = id(required(options,'id')); confirmation(confirmed(options));
    return verb === 'update' ? admin.updateEnvironment(target,{name:required(options,'name')},true) : admin.deleteEnvironment(target,true);
  }
  if (action === 'secret' && (verb === 'update' || verb === 'delete')) {
    confirmation(confirmed(options)); id(required(options,'expected-version')); id(required(options,'id'));
  }
  const {project,environment} = await selectedTarget(admin,config,options);
  if (action === 'import') return importSecrets(admin,project,environment,verb!,{file:required(options,'file'),plan:option(options,'plan'),names:option(options,'names'),confirmed:confirmed(options)});
  if (action === 'bind') {
    if (!config.projectId) fail('missing_connection');
    const to = required(options,'to'); if (!safeName(to)) fail('invalid_usage');
    const secret = (await admin.secrets(environment.id)).find(item=>item.name===name(options)); if (!secret) fail('not_found');
    const mapping = {name:secret.name,kind:secret.kind}; const previous = config.secrets[to];
    const changedKinds = Object.entries(config.secrets).filter(([,item])=>item.name===mapping.name && item.kind!==mapping.kind);
    if ((previous && (previous.name!==mapping.name || previous.kind!==mapping.kind)) || changedKinds.length) confirmation(confirmed(options));
    if (!previous && Object.keys(config.secrets).length >= 100) fail('invalid_config');
    const secrets = {...config.secrets,[to]:mapping}; for (const [destination] of changedKinds) secrets[destination]=mapping;
    await saveJson(path,{...config,secrets}); return {destination:to,...mapping,updatedDestinations:changedKinds.map(([destination])=>destination)};
  }
  if (action === 'secret') {
    if (verb === 'list') return {secrets:await admin.secrets(environment.id)};
    if (verb === 'create') {
      const key = name(options), secretKind = kind(options), value = await readSecretInput(source(options));
      if (secretKind === 'env' && value.includes('\0')) fail('invalid_input');
      return admin.createSecret({environmentId:environment.id,name:key,kind:secretKind,value});
    }
    const secret = (await admin.secrets(environment.id)).find(item=>item.id===required(options,'id')); if (!secret) fail('not_found');
    const expectedVersionId = required(options,'expected-version');
    if (secret.currentVersionId !== expectedVersionId) fail('conflict');
    if (verb === 'delete') return admin.deleteSecret(secret.id,expectedVersionId,true);
    const update: SecretUpdate = {expectedVersionId};
    if (option(options,'name') !== undefined) update.name = name(options);
    if (option(options,'kind') !== undefined) update.kind = kind(options);
    if (options.file !== undefined || options['from-env'] !== undefined || options.stdin) update.value = await readSecretInput(source(options));
    if (Object.keys(update).length===1) fail('invalid_usage');
    if ((update.kind ?? secret.kind)==='env' && update.value?.includes('\0')) fail('invalid_input');
    return admin.updateSecret(secret.id,update,true);
  }
  fail('invalid_usage');
}
