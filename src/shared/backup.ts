import { decrypt } from './crypto.js';
import { AppError } from './errors.js';
import { Store, validId, validText, validName, validKind, validPolicy, validValue } from './store.js';
import type { CiPolicy } from './auth.js';
export const MAX_BACKUP_BYTES = 1048576;
export const MAX_BACKUP_ROWS = 1000;
const columns = {
  projects: ['id','name','slug'],
  environments: ['id','project_id','name'],
  secrets: ['id','environment_id','name','kind','current_version_id','deleted_at','created_at','updated_at'],
  secret_versions: ['id','secret_id','ciphertext','nonce','key_id','created_at'],
  ci_policies: ['id','environment_id','repository_id','repository_owner_id','branch','workflow','events','github_environment','active'],
  audit_events: ['id','actor','action','target_id','result','created_at']
} as const;
type Table = keyof typeof columns;
export type BackupRow = Record<string, string | number | null>;
export interface Backup { schemaVersion: 1; createdAt: number; tables: Record<Table, BackupRow[]> }
const tables = Object.keys(columns) as Table[];
function tooLarge(): never { throw new AppError(413, 'backup_too_large'); }
function bad(): never { throw new AppError(400, 'invalid_backup'); }
function size(value: unknown): void { if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BACKUP_BYTES) tooLarge(); }
function timestamp(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) bad(); }
export async function exportBackup(store: Store): Promise<Backup> {
  const statements: D1PreparedStatement[] = [];
  for (const table of tables) {
    const bytes = columns[table].map(c => `coalesce(length(CAST(${c} AS BLOB)),4)+${c.length + 8}`).join('+');
    const stats = `SELECT count(*) AS count,coalesce(sum(${bytes}),0) AS bytes FROM ${table}`;
    statements.push(store.statement(stats));
    statements.push(store.statement(`SELECT * FROM ${table} WHERE (SELECT bytes FROM (${stats}))<=? ORDER BY id LIMIT ?`, MAX_BACKUP_BYTES, MAX_BACKUP_ROWS + 1));
  }
  let results: D1Result[]; try { results = await store.db.batch(statements); } catch { throw new AppError(500, 'storage_error'); }
  const output: Backup = {schemaVersion: 1, createdAt: Date.now(), tables: {} as Backup['tables']};
  tables.forEach((table, index) => {
    const stats = results[index * 2]!.results[0] as {count: number; bytes: number};
    if (stats.count > MAX_BACKUP_ROWS || stats.bytes > MAX_BACKUP_BYTES) tooLarge();
    output.tables[table] = results[index * 2 + 1]!.results as BackupRow[];
  }); size(output); return output;
}
async function validate(store: Store, value: unknown): Promise<Backup> {
  try {
    if (!value || typeof value !== 'object') bad(); const backup = value as Backup;
    if (backup.schemaVersion !== 1 || !backup.tables || typeof backup.tables !== 'object') bad(); timestamp(backup.createdAt);
    if (Object.keys(backup).sort().join(',') !== 'createdAt,schemaVersion,tables' || Object.keys(backup.tables).sort().join(',') !== [...tables].sort().join(',')) bad();
    const maps = {} as Record<Table, Map<string, BackupRow>>;
    for (const table of tables) {
      const rows = backup.tables[table]; if (!Array.isArray(rows) || rows.length > MAX_BACKUP_ROWS) bad();
      const map = maps[table] = new Map();
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== [...columns[table]].sort().join(',')) bad();
        validId(row.id); if (map.has(row.id)) bad(); map.set(row.id, row);
      }
    }
    const projectSlugs = new Set();
    for (const row of backup.tables.projects) {
      validText(row.name); validText(row.slug); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug) || projectSlugs.has(row.slug)) bad(); projectSlugs.add(row.slug);
    }
    const environmentNames = new Set();
    for (const row of backup.tables.environments) {
      validId(row.project_id); validText(row.name); if (!maps.projects.has(row.project_id)) bad(); const key = JSON.stringify([row.project_id, row.name]); if (environmentNames.has(key)) bad(); environmentNames.add(key);
    }
    const secretNames = new Set();
    for (const row of backup.tables.secrets) {
      validId(row.environment_id); validId(row.current_version_id); validName(row.name); validKind(row.kind); timestamp(row.created_at); timestamp(row.updated_at); if (row.deleted_at !== null) timestamp(row.deleted_at);
      if (row.updated_at < row.created_at || !maps.environments.has(row.environment_id) || maps.secret_versions.get(row.current_version_id)?.secret_id !== row.id) bad();
      const key = JSON.stringify([row.environment_id, row.name]); if (secretNames.has(key)) bad(); secretNames.add(key);
    }
    const counts = new Map<string, number>();
    for (const row of backup.tables.secret_versions) {
      validId(row.secret_id); validText(row.key_id); timestamp(row.created_at); const secret = maps.secrets.get(row.secret_id); if (!secret) bad();
      const count = (counts.get(row.secret_id) ?? 0) + 1; if (count > 10) bad(); counts.set(row.secret_id, count);
      const environment = maps.environments.get(secret.environment_id as string)!;
      if (typeof row.ciphertext !== 'string' || row.ciphertext.length > 87404 || typeof row.nonce !== 'string') bad();
      const plaintext = await decrypt({ciphertext: row.ciphertext, nonce: row.nonce, keyId: row.key_id}, {projectId: environment.project_id as string, environmentId: secret.environment_id as string, secretId: row.secret_id, versionId: row.id as string}, store.keyring); validValue(plaintext);
      if (row.created_at > (secret.updated_at as number)) bad();
    }
    for (const row of backup.tables.ci_policies) {
      if (typeof row.events !== 'string' || (row.active !== 0 && row.active !== 1)) bad();
      validPolicy({id: row.id, environmentId: row.environment_id, repositoryId: row.repository_id, repositoryOwnerId: row.repository_owner_id, branch: row.branch, workflow: row.workflow, events: JSON.parse(row.events), githubEnvironment: row.github_environment, active: row.active === 1} as CiPolicy);
      if (!maps.environments.has(row.environment_id as string)) bad();
    }
    for (const row of backup.tables.audit_events) { validText(row.actor, 256); validText(row.action, 64); timestamp(row.created_at); if (row.target_id !== null) validId(row.target_id); if (!['success','denied','error'].includes(row.result as string)) bad(); }
    return backup;
  } catch { bad(); }
}
export async function restoreBackup(store: Store, value: unknown): Promise<void> {
  size(value); const backup = await validate(store, value);
  const sentinel = crypto.randomUUID();
  // The sentinel forces SQL failure even for an empty backup. Audit-only DBs are valid targets.
  const occupied = tables.filter(t => t !== 'audit_events').map(t => `EXISTS(SELECT 1 FROM ${t})`).join(' OR ');
  const statements = [store.statement(`INSERT INTO projects(id,name,slug) VALUES (CASE WHEN ${occupied} THEN NULL ELSE ? END,?,?)`, sentinel, sentinel, sentinel)];
  for (const table of tables) {
    const select = columns[table].map(column => table === 'ci_policies' && column === 'active' ? '0' : `value->>'${column}'`).join(',');
    const insert = table === 'audit_events' ? 'INSERT OR IGNORE' : 'INSERT';
    statements.push(store.statement(`${insert} INTO ${table}(${columns[table].join(',')}) SELECT ${select} FROM json_each(?)`, JSON.stringify(backup.tables[table])));
  }
  statements.push(store.statement('DELETE FROM projects WHERE id=?', sentinel));
  await store.batch(statements);
}
