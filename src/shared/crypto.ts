import { AppError } from './errors.js';

export interface CryptoContext {
  projectId: string;
  environmentId: string;
  secretId: string;
  versionId: string;
}
export interface CipherRecord { ciphertext: string; nonce: string; keyId: string }
export type Keyring = Record<string, string>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid_encoding');
  }
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error('invalid_encoding');
  return bytes;
}

function aad(context: CryptoContext): Uint8Array<ArrayBuffer> {
  const fields = [context?.projectId, context?.environmentId, context?.secretId, context?.versionId];
  if (fields.some(value => typeof value !== 'string' || value.length === 0 || value.length > 1024)) {
    throw new AppError(500, 'configuration_error');
  }
  return encoder.encode(JSON.stringify(['psm', 1, ...fields]));
}

async function importKey(keyring: Keyring, keyId: string): Promise<CryptoKey> {
  try {
    if (!keyring || typeof keyId !== 'string' || !keyId || !Object.hasOwn(keyring, keyId)) {
      throw new Error('missing_key');
    }
    const bytes = decode(keyring[keyId]!);
    if (bytes.length !== 32) throw new Error('invalid_key');
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch {
    throw new AppError(500, 'configuration_error');
  }
}

export async function encrypt(value: string, context: CryptoContext, keyring: Keyring, activeKeyId: string): Promise<CipherRecord> {
  const additionalData = aad(context);
  const key = await importKey(keyring, activeKeyId);
  try {
    if (typeof value !== 'string') throw new Error('invalid_value');
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 }, key, encoder.encode(value));
    return { ciphertext: encode(new Uint8Array(ciphertext)), nonce: encode(nonce), keyId: activeKeyId };
  } catch {
    throw new AppError(500, 'encryption_failed');
  }
}

export async function decrypt(record: CipherRecord, context: CryptoContext, keyring: Keyring): Promise<string> {
  const additionalData = aad(context);
  const key = await importKey(keyring, record?.keyId);
  try {
    const nonce = decode(record.nonce);
    const ciphertext = decode(record.ciphertext);
    if (nonce.length !== 12 || ciphertext.length < 16) throw new Error('invalid_record');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 }, key, ciphertext);
    return decoder.decode(plaintext);
  } catch {
    throw new AppError(500, 'decryption_failed');
  }
}
