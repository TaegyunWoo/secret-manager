import { AppError } from './errors.js';
import { Store, invalid, validText, validName } from './store.js';
import type { AuditEvent } from './types.js';

export interface StorageEnv { DB: D1Database; KEYRING_JSON: string; ACTIVE_KEY_ID: string }
export interface ResolveInput { project: string; environment: string; names: string[] }

export function configuredStore(env: StorageEnv): Store {
  try {
    const keyring: unknown = JSON.parse(env.KEYRING_JSON);
    if (!keyring || typeof keyring !== 'object' || Array.isArray(keyring) || typeof env.ACTIVE_KEY_ID !== 'string' || !env.ACTIVE_KEY_ID || !Object.hasOwn(keyring, env.ACTIVE_KEY_ID) || Object.values(keyring).some(value => typeof value !== 'string')) throw new Error();
    return new Store(env.DB, keyring as Record<string,string>, env.ACTIVE_KEY_ID);
  } catch { throw new AppError(500, 'configuration_error'); }
}

// Runtime storage validation checks field types; this boundary excludes arrays, null and unknown fields.
export function objectInput<T>(value: unknown, fields: string[]): T {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) invalid();
  return value as T;
}
export function resolveInput(value: unknown): ResolveInput {
  const input = objectInput<ResolveInput>(value, ['project','environment','names']);
  validText(input.project); validText(input.environment);
  if (!Array.isArray(input.names) || !input.names.length || input.names.length > 100 || new Set(input.names).size !== input.names.length) invalid();
  input.names.forEach(validName);
  return input;
}
export async function auditFailure(store: Store, actor: string, action: string, targetId: string | null, error: unknown): Promise<void> {
  const result: AuditEvent['result'] = error instanceof AppError && [401,403].includes(error.status) ? 'denied' : 'error';
  // A failing audit sink must never replace an authentication rejection with success.
  try { await store.audit({actor,action,targetId,result}); } catch { /* Preserve the safe original error response. */ }
}
