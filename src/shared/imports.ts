import { Store, invalid, validName, validValue, MAX_IMPORT_BYTES } from './store.js';
import type { ImportEntry, Secret } from './types.js';
import { AppError } from './errors.js';
export function parseDotenv(source: string): {name: string; value: string}[] {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > MAX_IMPORT_BYTES) invalid();
  const entries: {name: string; value: string}[] = []; const names = new Set<string>(); let offset = 0;
  while (offset < source.length) {
    while (/[ \t\r\n]/.test(source[offset] ?? '') && offset < source.length) offset++;
    if (offset >= source.length) break;
    if (source[offset] === '#') { while (offset < source.length && source[offset] !== '\n') offset++; continue; }
    const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/.exec(source.slice(offset));
    if (!match) invalid(); const name = match[1]!; validName(name); if (names.has(name)) invalid(); names.add(name); offset += match[0].length;
    let value = ''; const quote = source[offset];
    if (quote === '"' || quote === "'") {
      offset++; let closed = false;
      while (offset < source.length) {
        const character = source[offset++]!;
        if (character === quote) { closed = true; break; }
        if (character === '\\' && quote === '"') {
          const next = source[offset++]; if (next === undefined) invalid();
          const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
          value += Object.hasOwn(escapes, next) ? escapes[next] : `\\${next}`;
        } else value += character;
      }
      if (!closed) invalid();
      while (source[offset] === ' ' || source[offset] === '\t' || source[offset] === '\r') offset++;
      if (source[offset] === '#') { while (offset < source.length && source[offset] !== '\n') offset++; }
      if (offset < source.length && source[offset] !== '\n') invalid();
    } else {
      const start = offset; while (offset < source.length && source[offset] !== '\n' && source[offset] !== '\r') offset++;
      value = source.slice(start, offset).replace(/(?:^|[ \t]+)#.*$/, '').trimEnd();
    }
    validValue(value); entries.push({ name, value }); if (entries.length > 100) invalid();
  }
  if (!entries.length) invalid(); return entries;
}
export async function previewImport(store: Store, environmentId: string, source: string): Promise<{entries: (ImportEntry & {exists: boolean; deleted: boolean})[]}> {
  const entries = parseDotenv(source);
  // Include expired tombstones too: their names remain reserved until cleanup.
  const existing = await store.rows<Secret>('SELECT name,current_version_id AS currentVersionId,deleted_at AS deletedAt FROM secrets WHERE environment_id=?', environmentId);
  await store.one('SELECT id FROM environments WHERE id=?', environmentId);
  const byName = new Map(existing.map(s => [s.name, s]));
  return {entries: entries.map(entry => { const old = byName.get(entry.name); return {...entry, exists: !!old, deleted: old ? old.deletedAt !== null : false, ...(old ? {expectedVersionId: old.currentVersionId} : {})}; })};
}
export async function applyImport(store: Store, environmentId: string, entries: ImportEntry[]): Promise<Secret[]> {
  if(entries.length>10||entries.reduce((bytes,entry)=>bytes+(typeof entry.value==='string'?new TextEncoder().encode(entry.value).length:0),0)>65536)throw new AppError(413,'chunk_required');
  return store.importEntries(environmentId, entries);
}
