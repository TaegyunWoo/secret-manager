import fs from 'node:fs/promises';
import { AppError } from '../shared/errors.js';
import type { SecretKind } from '../shared/types.js';

export interface Config { adminUrl: string; ciUrl?: string; secrets: Record<string, { name: string; kind: SecretKind }> }
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
  const raw = strictJson(source); if (!object(raw)) fail('invalid_config'); exactKeys(raw,['adminUrl','ciUrl','secrets']);
  const adminUrl = origin(raw.adminUrl); const ciUrl = raw.ciUrl === undefined ? undefined : origin(raw.ciUrl);
  if (!object(raw.secrets) || !Object.keys(raw.secrets).length || Object.keys(raw.secrets).length > 100) fail('invalid_config');
  const secrets: Config['secrets'] = Object.create(null); const kinds = new Map<string, SecretKind>();
  for (const [destination, mapping] of Object.entries(raw.secrets)) {
    if (!safeName(destination) || !object(mapping)) fail('invalid_config'); exactKeys(mapping,['name','kind']);
    if (!safeName(mapping.name) || (mapping.kind !== 'env' && mapping.kind !== 'file')) fail('invalid_config');
    if (kinds.has(mapping.name) && kinds.get(mapping.name) !== mapping.kind) fail('invalid_config');
    kinds.set(mapping.name,mapping.kind); secrets[destination] = {name:mapping.name,kind:mapping.kind};
  }
  return {adminUrl,ciUrl,secrets};
}
