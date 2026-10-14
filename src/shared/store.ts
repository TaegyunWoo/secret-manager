import { encrypt, decrypt, type Keyring, type CipherRecord } from './crypto.js';
import { AppError } from './errors.js';
import type { CiPolicy } from './auth.js';
import type { Project, Environment, Secret, Version, ResolvedSecret, AuditEvent, SecretInput, SecretUpdate, ImportEntry } from './types.js';
export const DAY = 86400000;
export const MAX_VALUE_BYTES = 65536;
export const MAX_IMPORT_BYTES = 131072;
const secretColumns = 'id, environment_id AS environmentId, name, kind, current_version_id AS currentVersionId, deleted_at AS deletedAt, created_at AS createdAt, updated_at AS updatedAt';
const environmentColumns = 'id, project_id AS projectId, name';
export function invalid(): never { throw new AppError(400, 'invalid_input'); }
export function validId(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) invalid(); }
export function validText(value: unknown, max = 128): asserts value is string { if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) invalid(); }
export function validName(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) invalid(); }
export function validValue(value: unknown): asserts value is string { if (typeof value !== 'string' || new TextEncoder().encode(value).length > MAX_VALUE_BYTES) invalid(); }
export function validKind(value: unknown): asserts value is 'env' | 'file' { if (value !== 'env' && value !== 'file') invalid(); }
export function validPolicy(policy: Omit<CiPolicy, 'id'> & { id?: string }): void {
  validId(policy.environmentId); if (policy.id !== undefined) validId(policy.id);
  if (typeof policy.repositoryId !== 'string' || typeof policy.repositoryOwnerId !== 'string' || !/^[1-9][0-9]{0,31}$/.test(policy.repositoryId) || !/^[1-9][0-9]{0,31}$/.test(policy.repositoryOwnerId)) invalid();
  validText(policy.branch, 256); validText(policy.workflow, 256);
  if (!/^refs\/heads\/[^\s~^:?*\[\\]+$/.test(policy.branch) || !/^\.github\/workflows\/[^\s/@\\]+\.ya?ml$/.test(policy.workflow)) invalid();
  if (!Array.isArray(policy.events) || policy.events.length < 1 || policy.events.length > 2 || new Set(policy.events).size !== policy.events.length || policy.events.some(e => !['push', 'workflow_dispatch'].includes(e))) invalid();
  if (policy.githubEnvironment !== null) validText(policy.githubEnvironment);
  if (typeof policy.active !== 'boolean') invalid();
}
interface JoinedSecret extends Secret, CipherRecord { projectId: string }
interface Write extends Secret, CipherRecord { expectedVersionId: string | null }
export class Store {
  constructor(public readonly db: D1Database, public readonly keyring: Keyring, public readonly activeKeyId: string) {}
  statement(sql: string, ...args: unknown[]): D1PreparedStatement { return this.db.prepare(sql).bind(...args); }
  async rows<T>(sql: string, ...args: unknown[]): Promise<T[]> { try { return (await this.statement(sql, ...args).all<T>()).results; } catch { throw new AppError(500, 'storage_error'); } }
  async one<T>(sql: string, ...args: unknown[]): Promise<T> { const row = (await this.rows<T>(sql, ...args))[0]; if (!row) throw new AppError(404, 'not_found'); return row; }
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> { try { return await this.db.batch(statements); } catch (error) { if (error instanceof Error && /constraint failed|SQLITE_CONSTRAINT/i.test(error.message)) throw new AppError(409, 'conflict'); throw new AppError(500, 'storage_error'); } }
  private async mutate(sql: string, ...args: unknown[]): Promise<void> { const result = (await this.batch([this.statement(sql, ...args)]))[0]!; if (!result.meta.changes) throw new AppError(404, 'not_found'); }
  listProjects(): Promise<Project[]> { return this.rows('SELECT id,name,slug FROM projects ORDER BY name,id'); }
  async createProject(input: {name: string; slug: string}): Promise<Project> {
    validText(input.name); if (typeof input.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) || input.slug.length > 128) invalid();
    const result = { id: crypto.randomUUID(), name: input.name, slug: input.slug }; await this.mutate('INSERT INTO projects(id,name,slug) VALUES (?,?,?)', result.id, input.name, input.slug); return result;
  }
  async updateProject(id: string, input: {name: string; slug: string}): Promise<Project> {
    validId(id); validText(input.name); if (typeof input.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) || input.slug.length > 128) invalid();
    await this.mutate('UPDATE projects SET name=?,slug=? WHERE id=?', input.name, input.slug, id); return { id, name: input.name, slug: input.slug };
  }
  async deleteProject(id: string): Promise<void> { validId(id); await this.mutate('DELETE FROM projects WHERE id=?', id); }
  listEnvironments(projectId?: string): Promise<Environment[]> { if (projectId !== undefined) validId(projectId); return this.rows(`SELECT ${environmentColumns} FROM environments ${projectId ? 'WHERE project_id=?' : ''} ORDER BY name,id`, ...(projectId ? [projectId] : [])); }
  async createEnvironment(input: {projectId: string; name: string}): Promise<Environment> { validId(input.projectId); validText(input.name); const result = {id: crypto.randomUUID(), projectId: input.projectId, name: input.name}; await this.mutate('INSERT INTO environments(id,project_id,name) VALUES (?,?,?)', result.id, input.projectId, input.name); return result; }
  async updateEnvironment(id: string, input: {name: string}): Promise<Environment> { validId(id); validText(input.name); await this.mutate('UPDATE environments SET name=? WHERE id=?', input.name, id); return this.one(`SELECT ${environmentColumns} FROM environments WHERE id=?`, id); }
  async deleteEnvironment(id: string): Promise<void> { validId(id); await this.mutate('DELETE FROM environments WHERE id=?', id); }
  listSecrets(environmentId: string): Promise<Secret[]> { validId(environmentId); return this.rows(`SELECT ${secretColumns} FROM secrets WHERE environment_id=? AND deleted_at IS NULL ORDER BY name,id`, environmentId); }
  listTrash(environmentId?: string): Promise<Secret[]> { if (environmentId !== undefined) validId(environmentId); return this.rows(`SELECT ${secretColumns} FROM secrets WHERE deleted_at>? ${environmentId ? 'AND environment_id=?' : ''} ORDER BY deleted_at DESC,id`, Date.now() - 7 * DAY, ...(environmentId ? [environmentId] : [])); }
  async getEnvironment(projectSlug: string, environmentName: string): Promise<Environment> { validText(projectSlug); validText(environmentName); return this.one('SELECT e.id,e.project_id AS projectId,e.name FROM environments e JOIN projects p ON p.id=e.project_id WHERE p.slug=? AND e.name=?', projectSlug, environmentName); }
  private async joined(id: string, versionId?: string): Promise<JoinedSecret> {
    validId(id); if (versionId !== undefined) validId(versionId);
    return this.one(`SELECT s.id,s.environment_id AS environmentId,s.name,s.kind,s.current_version_id AS currentVersionId,s.deleted_at AS deletedAt,s.created_at AS createdAt,s.updated_at AS updatedAt,e.project_id AS projectId,v.ciphertext,v.nonce,v.key_id AS keyId FROM secrets s JOIN environments e ON e.id=s.environment_id JOIN secret_versions v ON v.secret_id=s.id AND v.id=${versionId ? '?' : 's.current_version_id'} WHERE s.id=? AND s.deleted_at IS NULL`, ...(versionId ? [versionId] : []), id);
  }
  private decryptRow(row: JoinedSecret, versionId = row.currentVersionId): Promise<string> { return decrypt(row, { projectId: row.projectId, environmentId: row.environmentId, secretId: row.id, versionId }, this.keyring); }
  async reveal(id: string): Promise<ResolvedSecret> { const row = await this.joined(id); return {name: row.name, kind: row.kind, value: await this.decryptRow(row)}; }
  async createSecret(input: SecretInput): Promise<Secret> {
    validId(input.environmentId); validName(input.name); validKind(input.kind); validValue(input.value);
    const environment = await this.one<Environment>(`SELECT ${environmentColumns} FROM environments WHERE id=?`, input.environmentId);
    const now = Date.now(); const metadata: Secret = {id: crypto.randomUUID(), environmentId: input.environmentId, name: input.name, kind: input.kind, currentVersionId: crypto.randomUUID(), deletedAt: null, createdAt: now, updatedAt: now};
    const cipher = await encrypt(input.value, {projectId: environment.projectId, environmentId: metadata.environmentId, secretId: metadata.id, versionId: metadata.currentVersionId}, this.keyring, this.activeKeyId);
    await this.write([{...metadata, ...cipher, expectedVersionId: null}]); return metadata;
  }
  async updateSecret(id: string, input: SecretUpdate): Promise<Secret> {
    validId(input.expectedVersionId); const old = await this.joined(id); if (old.currentVersionId !== input.expectedVersionId) throw new AppError(409, 'conflict');
    const name = input.name === undefined ? old.name : input.name, kind = input.kind === undefined ? old.kind : input.kind, value = input.value === undefined ? await this.decryptRow(old) : input.value;
    validName(name); validKind(kind); validValue(value);
    const metadata: Secret = {id, environmentId: old.environmentId, name, kind, currentVersionId: crypto.randomUUID(), deletedAt: null, createdAt: old.createdAt, updatedAt: Math.max(Date.now(), old.updatedAt + 1)};
    const cipher = await encrypt(value, {projectId: old.projectId, environmentId: old.environmentId, secretId: id, versionId: metadata.currentVersionId}, this.keyring, this.activeKeyId);
    await this.write([{...metadata, ...cipher, expectedVersionId: input.expectedVersionId}]); return metadata;
  }
  private async write(writes: Write[]): Promise<void> {
    const payload = JSON.stringify(writes);
    // A stale CAS must fail a constraint: zero affected rows does not roll back D1 batches.
    await this.batch([
      this.statement(`INSERT INTO secrets(id,environment_id,name,kind,current_version_id,deleted_at,created_at,updated_at) SELECT value->>'id',value->>'environmentId',value->>'name',value->>'kind',value->>'currentVersionId',NULL,value->>'createdAt',value->>'updatedAt' FROM json_each(?) WHERE value->>'expectedVersionId' IS NULL`, payload),
      this.statement(`INSERT INTO secret_versions(id,secret_id,ciphertext,nonce,key_id,created_at) SELECT value->>'currentVersionId',(SELECT id FROM secrets WHERE id=value->>'id' AND deleted_at IS NULL AND current_version_id=coalesce(value->>'expectedVersionId',value->>'currentVersionId')),value->>'ciphertext',value->>'nonce',value->>'keyId',value->>'updatedAt' FROM json_each(?)`, payload),
      this.statement(`UPDATE secrets SET name=j.value->>'name',kind=j.value->>'kind',current_version_id=j.value->>'currentVersionId',updated_at=j.value->>'updatedAt' FROM json_each(?) j WHERE secrets.id=j.value->>'id'`, payload),
      this.statement(`DELETE FROM secret_versions WHERE id IN (SELECT id FROM (SELECT id,row_number() OVER (PARTITION BY secret_id ORDER BY created_at DESC,id DESC) AS position FROM secret_versions WHERE secret_id IN (SELECT value->>'id' FROM json_each(?))) WHERE position>10)`, payload)
    ]);
  }
  async deleteSecret(id: string, expectedVersionId: string): Promise<void> {
    validId(id); validId(expectedVersionId); const now = Date.now();
    await this.mutate('UPDATE secrets SET deleted_at=?,updated_at=CASE WHEN current_version_id=? AND deleted_at IS NULL THEN max(updated_at,?) ELSE NULL END WHERE id=?', now, expectedVersionId, now, id);
  }
  async restoreSecret(id: string, expectedVersionId: string): Promise<Secret> {
    validId(id); validId(expectedVersionId); const now = Date.now();
    await this.mutate('UPDATE secrets SET deleted_at=NULL,updated_at=CASE WHEN current_version_id=? AND deleted_at>? THEN max(updated_at,?) ELSE NULL END WHERE id=?', expectedVersionId, now - 7 * DAY, now, id);
    return this.one(`SELECT ${secretColumns} FROM secrets WHERE id=?`, id);
  }
  async listVersions(id: string): Promise<Version[]> { validId(id); await this.one('SELECT id FROM secrets WHERE id=? AND deleted_at IS NULL', id); return this.rows('SELECT id,secret_id AS secretId,key_id AS keyId,created_at AS createdAt FROM secret_versions WHERE secret_id=? ORDER BY created_at DESC,id DESC', id); }
  async restoreVersion(id: string, versionId: string, expectedVersionId: string): Promise<Secret> { const old = await this.joined(id, versionId); return this.updateSecret(id, {expectedVersionId, value: await this.decryptRow(old, versionId)}); }
  async resolve(projectSlug: string, environmentName: string, names: string[]): Promise<{secrets: ResolvedSecret[]}> {
    const environment = await this.getEnvironment(projectSlug, environmentName);
    return this.resolveEnvironment(environment.id, names);
  }
  async resolveEnvironment(environmentId: string, names: string[]): Promise<{secrets: ResolvedSecret[]}> {
    validId(environmentId);
    if (!Array.isArray(names) || !names.length || names.length > 100 || new Set(names).size !== names.length) invalid(); names.forEach(validName);
    const rows = await this.rows<JoinedSecret>(`SELECT s.id,s.environment_id AS environmentId,s.name,s.kind,s.current_version_id AS currentVersionId,e.project_id AS projectId,v.ciphertext,v.nonce,v.key_id AS keyId FROM secrets s JOIN environments e ON e.id=s.environment_id JOIN secret_versions v ON v.id=s.current_version_id AND v.secret_id=s.id WHERE s.environment_id=? AND s.deleted_at IS NULL AND s.name IN (SELECT value FROM json_each(?))`, environmentId, JSON.stringify(names));
    if (rows.length !== names.length) throw new AppError(404, 'not_found');
    const byName = new Map(rows.map(row => [row.name, row]));
    return {secrets: await Promise.all(names.map(async name => { const row = byName.get(name)!; return {name, kind: row.kind, value: await this.decryptRow(row)}; }))};
  }
  async importEntries(environmentId: string, entries: ImportEntry[]): Promise<Secret[]> {
    validId(environmentId); if (!Array.isArray(entries) || !entries.length || entries.length > 100 || new Set(entries.map(e => e.name)).size !== entries.length) invalid();
    for (const e of entries) { validName(e.name); validValue(e.value); if (e.expectedVersionId !== undefined) validId(e.expectedVersionId); }
    if (new TextEncoder().encode(JSON.stringify(entries)).length > MAX_IMPORT_BYTES) invalid();
    const environment = await this.one<Environment>(`SELECT ${environmentColumns} FROM environments WHERE id=?`, environmentId);
    const existing = await this.rows<Secret>(`SELECT ${secretColumns} FROM secrets WHERE environment_id=? AND name IN (SELECT value->>'name' FROM json_each(?))`, environmentId, JSON.stringify(entries));
    const byName = new Map(existing.map(s => [s.name, s])); const writes: Write[] = [];
    for (const entry of entries) {
      const old = byName.get(entry.name);
      if ((old && (old.deletedAt !== null || entry.expectedVersionId !== old.currentVersionId)) || (!old && entry.expectedVersionId !== undefined)) throw new AppError(409, 'conflict');
      const now = Math.max(Date.now(), (old?.updatedAt ?? 0) + 1);
      const metadata: Secret = {id: old?.id ?? crypto.randomUUID(), environmentId, name: entry.name, kind: 'env', currentVersionId: crypto.randomUUID(), deletedAt: null, createdAt: old?.createdAt ?? now, updatedAt: now};
      const cipher = await encrypt(entry.value, {projectId: environment.projectId, environmentId, secretId: metadata.id, versionId: metadata.currentVersionId}, this.keyring, this.activeKeyId);
      writes.push({...metadata, ...cipher, expectedVersionId: entry.expectedVersionId ?? null});
    }
    await this.write(writes);
    return writes.map(({ciphertext: _c, nonce: _n, keyId: _k, expectedVersionId: _e, ...metadata}) => metadata);
  }
  async listPolicies(environmentId?: string, activeOnly = false): Promise<CiPolicy[]> {
    if (environmentId !== undefined) validId(environmentId);
    const rows = await this.rows<Omit<CiPolicy, 'events' | 'active'> & {events: string; active: number}>(`SELECT id,environment_id AS environmentId,repository_id AS repositoryId,repository_owner_id AS repositoryOwnerId,branch,workflow,events,github_environment AS githubEnvironment,active FROM ci_policies WHERE (? IS NULL OR environment_id=?) AND (?=0 OR active=1) ORDER BY id`, environmentId ?? null, environmentId ?? null, Number(activeOnly));
    return rows.map(row => ({...row, events: JSON.parse(row.events) as string[], active: row.active === 1}));
  }
  async savePolicy(input: Omit<CiPolicy, 'id'> & {id?: string}): Promise<CiPolicy> {
    validPolicy(input); const policy: CiPolicy = {id: input.id ?? crypto.randomUUID(), environmentId: input.environmentId, repositoryId: input.repositoryId, repositoryOwnerId: input.repositoryOwnerId, branch: input.branch, workflow: input.workflow, events: [...input.events], githubEnvironment: input.githubEnvironment, active: input.active};
    await this.mutate('INSERT INTO ci_policies(id,environment_id,repository_id,repository_owner_id,branch,workflow,events,github_environment,active) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET environment_id=excluded.environment_id,repository_id=excluded.repository_id,repository_owner_id=excluded.repository_owner_id,branch=excluded.branch,workflow=excluded.workflow,events=excluded.events,github_environment=excluded.github_environment,active=excluded.active', policy.id, policy.environmentId, policy.repositoryId, policy.repositoryOwnerId, policy.branch, policy.workflow, JSON.stringify(policy.events), policy.githubEnvironment, Number(policy.active)); return policy;
  }
  async deletePolicy(id: string): Promise<void> { validId(id); await this.mutate('DELETE FROM ci_policies WHERE id=?', id); }
  listAudit(limit = 100): Promise<AuditEvent[]> { if (!Number.isInteger(limit) || limit < 1 || limit > 500) invalid(); return this.rows('SELECT id,actor,action,target_id AS targetId,result,created_at AS createdAt FROM audit_events WHERE created_at>? ORDER BY created_at DESC,id DESC LIMIT ?', Date.now() - 30 * DAY, limit); }
  async audit(input: Pick<AuditEvent, 'actor' | 'action' | 'targetId' | 'result'>): Promise<void> { validText(input.actor, 256); validText(input.action, 64); if (input.targetId !== null) validId(input.targetId); if (!['success','denied','error'].includes(input.result)) invalid(); await this.mutate('INSERT INTO audit_events(id,actor,action,target_id,result,created_at) VALUES (?,?,?,?,?,?)', crypto.randomUUID(), input.actor, input.action, input.targetId, input.result, Date.now()); }
  async cleanup(limit = 100): Promise<{secrets: number; events: number}> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid(); const now = Date.now();
    const results = await this.batch([
      this.statement('DELETE FROM secrets WHERE id IN (SELECT id FROM secrets WHERE deleted_at<=? ORDER BY deleted_at,id LIMIT ?) RETURNING id', now - 7 * DAY, limit),
      this.statement('DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE created_at<=? ORDER BY created_at,id LIMIT ?) RETURNING id', now - 30 * DAY, limit)
    ]); return {secrets: results[0]!.results.length, events: results[1]!.results.length};
  }
}
