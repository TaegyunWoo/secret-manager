import { cloudflared, requestJson } from './client.js';
import { fail, object, origin, safeName } from './config.js';
import type { Project, Environment, Secret, SecretInput, SecretUpdate } from '../shared/types.js';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
export function projectMetadata(value: unknown): Project {
  if (!object(value) || !uuid(value.id) || !text(value.name) || !text(value.slug) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug)) fail('invalid_response');
  return { id: value.id, name: value.name, slug: value.slug };
}
export function environmentMetadata(value: unknown): Environment {
  if (!object(value) || !uuid(value.id) || !uuid(value.projectId) || !text(value.name)) fail('invalid_response');
  return { id: value.id, projectId: value.projectId, name: value.name };
}
export function secretMetadata(value: unknown): Secret {
  if (!object(value) || !uuid(value.id) || !uuid(value.environmentId) || !safeName(value.name) || !['env', 'file'].includes(String(value.kind)) || !uuid(value.currentVersionId) || !(value.deletedAt === null || Number.isSafeInteger(value.deletedAt)) || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)) fail('invalid_response');
  return { id: value.id, environmentId: value.environmentId, name: value.name, kind: value.kind as Secret['kind'], currentVersionId: value.currentVersionId, deletedAt: value.deletedAt as number | null, createdAt: value.createdAt as number, updatedAt: value.updatedAt as number };
}
function list<T>(value: unknown, key: string, convert: (row: unknown) => T): T[] {
  if (!object(value) || !Array.isArray(value[key])) fail('invalid_response');
  return value[key].map(convert);
}
export function confirmation(confirmed: boolean): void { if (!confirmed) fail('confirmation_required'); }
export function id(value: unknown): string { if (!uuid(value)) fail('invalid_usage'); return value; }

export class AdminClient {
  readonly adminUrl: string;
  private token?: Promise<string>;
  constructor(adminUrl: string) { this.adminUrl = origin(adminUrl); }
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!path.startsWith('/api/') || /[\r\n#]/.test(path)) fail('invalid_usage');
    this.token ??= cloudflared(['access', 'token', '--app', this.adminUrl]).catch(() => fail('login_required'));
    const token = await this.token; if (!token || /[\r\n\0]/.test(token)) fail('login_required');
    return requestJson(`${this.adminUrl}${path}`, { method, headers: { 'content-type': 'application/json', 'cf-access-token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, 1024 * 1024, true);
  }
  async projects(): Promise<Project[]> { return list(await this.request('GET', '/api/projects'), 'projects', projectMetadata); }
  async environments(projectId?: string): Promise<Environment[]> { return list(await this.request('GET', `/api/environments${projectId ? `?projectId=${id(projectId)}` : ''}`), 'environments', environmentMetadata); }
  async secrets(environmentId: string): Promise<Secret[]> { return list(await this.request('GET', `/api/secrets?environmentId=${id(environmentId)}`), 'secrets', secretMetadata); }
  async createProject(input: { name: string; slug: string }): Promise<Project> { return projectMetadata(await this.request('POST', '/api/projects', input)); }
  async createEnvironment(input: { projectId: string; name: string }): Promise<Environment> { return environmentMetadata(await this.request('POST', '/api/environments', input)); }
  async createSecret(input: SecretInput): Promise<Secret> { return secretMetadata(await this.request('POST', '/api/secrets', input)); }
  async updateProject(target: string, input: { name: string; slug: string }, confirmed: boolean): Promise<Project> { confirmation(confirmed); return projectMetadata(await this.request('PATCH', `/api/projects/${id(target)}`, input)); }
  async updateEnvironment(target: string, input: { name: string }, confirmed: boolean): Promise<Environment> { confirmation(confirmed); return environmentMetadata(await this.request('PATCH', `/api/environments/${id(target)}`, input)); }
  async updateSecret(target: string, input: SecretUpdate, confirmed: boolean): Promise<Secret> { confirmation(confirmed); id(input.expectedVersionId); return secretMetadata(await this.request('PATCH', `/api/secrets/${id(target)}`, input)); }
  async deleteProject(target: string, confirmed: boolean): Promise<{ ok: true }> { confirmation(confirmed); return this.remove(`/api/projects/${id(target)}`, {}); }
  async deleteEnvironment(target: string, confirmed: boolean): Promise<{ ok: true }> { confirmation(confirmed); return this.remove(`/api/environments/${id(target)}`, {}); }
  async deleteSecret(target: string, version: string, confirmed: boolean): Promise<{ ok: true }> { confirmation(confirmed); return this.remove(`/api/secrets/${id(target)}`, { expectedVersionId: id(version) }); }
  private async remove(path: string, body: unknown): Promise<{ ok: true }> {
    const result = await this.request('DELETE', path, body); if (!object(result) || result.ok !== true) fail('invalid_response'); return { ok: true };
  }
}
