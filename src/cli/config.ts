import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AppError } from '../shared/errors.js';
import type { SecretKind } from '../shared/types.js';

export interface Config { adminUrl: string; ciUrl?: string; secrets: Record<string, { name: string; kind: SecretKind }>; project?: string; environment?: string; projectId?: string; environmentId?: string }
export function fail(code: string): never { throw new AppError(400, code); }
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function exactKeys(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) fail('invalid_config'); }
export function safeName(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value); }
export function origin(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_config');
  let url: URL; try { url = new URL(value); } catch { fail('invalid_config'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) fail('invalid_config');
  return url.origin;
}

// JSON.parse silently overwrites duplicate keys, so reject them before validation.
export function strictJson(source: string): unknown {
  let offset = 0;
  const space = () => { while (/\s/.test(source[offset] ?? '') && offset < source.length) offset++; };
  function string(): string {
    const start = offset++;
    while (offset < source.length) { const char = source[offset++]; if (char === '\\') offset++; else if (char === '"') return JSON.parse(source.slice(start, offset)); }
    fail('invalid_json');
  }
  function value(depth: number): void {
    if (depth > 20) fail('invalid_json'); space(); const char = source[offset];
    if (char === '"') { string(); return; }
    if (char === '{' || char === '[') {
      const end = char === '{' ? '}' : ']'; offset++; space(); const keys = new Set<string>();
      if (source[offset] === end) { offset++; return; }
      for (;;) {
        if (char === '{') { if (source[offset] !== '"') fail('invalid_json'); const key = string(); if (keys.has(key)) fail('invalid_json'); keys.add(key); space(); if (source[offset++] !== ':') fail('invalid_json'); }
        value(depth + 1); space(); const next = source[offset++]; if (next === end) return; if (next !== ',') fail('invalid_json'); space();
      }
    }
    const start = offset; while (offset < source.length && !/[\s,}\]]/.test(source[offset]!)) offset++; if (offset === start) fail('invalid_json'); JSON.parse(source.slice(start,offset));
  }
  try { value(0); space(); if (offset !== source.length) fail('invalid_json'); return JSON.parse(source); } catch { fail('invalid_json'); }
}
export async function loadConfig(path: string): Promise<Config> {
  let source: string;
  try { const handle = await fs.open(path, 'r'); try { if ((await handle.stat()).size > 65536) fail('invalid_config'); source = await handle.readFile('utf8'); } finally { await handle.close(); } } catch { fail('invalid_config'); }
  if (Buffer.byteLength(source) > 65536) fail('invalid_config');
  const raw = strictJson(source); if (!object(raw)) fail('invalid_config'); exactKeys(raw,['adminUrl','ciUrl','secrets','project','environment','projectId','environmentId']);
  const adminUrl = origin(raw.adminUrl); const ciUrl = raw.ciUrl === undefined ? undefined : origin(raw.ciUrl);
  if (raw.secrets === undefined) raw.secrets = {}; if (!object(raw.secrets) || Object.keys(raw.secrets).length > 100) fail('invalid_config');
  const secrets: Config['secrets'] = Object.create(null); const kinds = new Map<string, SecretKind>();
  for (const [destination, mapping] of Object.entries(raw.secrets)) {
    if (!safeName(destination) || !object(mapping)) fail('invalid_config'); exactKeys(mapping,['name','kind']);
    if (!safeName(mapping.name) || (mapping.kind !== 'env' && mapping.kind !== 'file')) fail('invalid_config');
    if (kinds.has(mapping.name) && kinds.get(mapping.name) !== mapping.kind) fail('invalid_config');
    kinds.set(mapping.name,mapping.kind); secrets[destination] = {name:mapping.name,kind:mapping.kind};
  }
  const binding: Partial<Config> = {};
  if (['project','environment','projectId','environmentId'].some(key=>raw[key] !== undefined)) {
    if (typeof raw.project !== 'string' || raw.project.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.project) || typeof raw.environment !== 'string' || !raw.environment.length || raw.environment.length > 128 || raw.environment.trim() !== raw.environment || /[\x00-\x1f\x7f]/.test(raw.environment)) fail('invalid_config');
    for (const key of ['projectId','environmentId']) if (typeof raw[key] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw[key])) fail('invalid_config');
    Object.assign(binding, { project: raw.project, environment: raw.environment, projectId: raw.projectId, environmentId: raw.environmentId });
  }
  return {adminUrl,...(ciUrl ? {ciUrl}:{}),secrets,...binding};
}

export function settingsPath(): string { return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'psm', 'config.json'); }
export async function saveJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.psm-${randomUUID()}.tmp`);
  try {
    try { if ((await fs.lstat(path)).isSymbolicLink()) fail('unsafe_config'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, path);
  } catch (error) { if (error instanceof AppError) throw error; fail('config_write_failed'); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
export async function configure(adminUrl: string): Promise<{ adminUrl: string; path: string }> {
  const address = origin(adminUrl), path = settingsPath();
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 }); await saveJson(path, { adminUrl: address });
  return { adminUrl: address, path };
}
export async function loadSettings(path: string, explicit: boolean, adminUrl?: string): Promise<Config> {
  let config: Config | undefined;
  try { await fs.stat(path); config = await loadConfig(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || explicit) throw error instanceof AppError ? error : new AppError(400,'invalid_config'); }
  if (config) return adminUrl === undefined ? config : { ...config, adminUrl: origin(adminUrl) };
  if (adminUrl !== undefined) return { adminUrl: origin(adminUrl), secrets: Object.create(null) };
  try { const raw = strictJson(await fs.readFile(settingsPath(), 'utf8')); if (!object(raw)) fail('invalid_config'); exactKeys(raw, ['adminUrl']); return { adminUrl: origin(raw.adminUrl), secrets: Object.create(null) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('missing_admin_url'); throw error instanceof AppError ? error : new AppError(400,'invalid_config'); }
}
