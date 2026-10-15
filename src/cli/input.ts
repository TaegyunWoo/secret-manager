import fs from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { fail, safeName } from './config.js';

export interface SecretSource { file?: string; fromEnv?: string; stdin?: boolean }
export async function readSecretInput(source: SecretSource, maxBytes = 65536, input: Readable = process.stdin): Promise<string> {
  if ([source.file !== undefined, source.fromEnv !== undefined, source.stdin === true].filter(Boolean).length !== 1) fail('invalid_usage');
  let bytes: Buffer;
  if (source.fromEnv !== undefined) {
    if (!safeName(source.fromEnv)) fail('invalid_usage');
    const value = process.env[source.fromEnv]; if (value === undefined) fail('missing_input');
    bytes = Buffer.from(value, 'utf8'); if (bytes.toString('utf8') !== value) fail('invalid_input');
  } else {
    let stream = input;
    if (source.file !== undefined) {
      let handle;
      try { handle = await fs.open(source.file, 'r'); } catch { fail('missing_input'); }
      try {
        const info = await handle.stat(); if (!info.isFile()) fail('invalid_input'); if (info.size > maxBytes) fail('input_too_large');
        stream = handle.createReadStream();
        bytes = await readBounded(stream, maxBytes);
      } finally { await handle.close(); }
      return decode(bytes, maxBytes);
    }
    bytes = await readBounded(stream, maxBytes);
  }
  return decode(bytes, maxBytes);
}
async function readBounded(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const part of stream) { const chunk = Buffer.from(part); size += chunk.length; if (size > limit) fail('input_too_large'); chunks.push(chunk); }
  } catch (error) { if (error instanceof Error && error.message === 'input_too_large') throw error; fail('invalid_input'); }
  return Buffer.concat(chunks);
}
function decode(bytes: Buffer, limit: number): string {
  if (bytes.length > limit) fail('input_too_large');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('invalid_input'); }
}
