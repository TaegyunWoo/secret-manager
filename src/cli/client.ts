import { execFile } from 'node:child_process';
import { fail, object, strictJson, type Config } from './config.js';
import type { ResolvedSecret } from '../shared/types.js';
import { AppError } from '../shared/errors.js';

export function cloudflared(args: string[]): Promise<string> {
  return new Promise((resolve,reject) => execFile('cloudflared',args,{timeout:120000,maxBuffer:65536,encoding:'utf8'},(error,stdout) => error ? reject(new Error('access_failed')) : resolve(stdout.trim())));
}
export async function login(config: Config): Promise<void> { await cloudflared(['access','login',config.adminUrl]); }

// 100 x 64 KiB values may each expand sixfold in JSON; 40 MiB bounds that maximum.
const adminErrors = new Set(['invalid_input','not_found','conflict','chunk_required','payload_too_large','operation_expired','storage_error','configuration_error']);
export async function requestJson(url: string, options: RequestInit, maxBytes = 40 * 1024 * 1024, admin = false): Promise<unknown> {
  try {
    const response = await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});
    if (!response.ok) {
      if (admin && response.status === 401) { await response.body?.cancel(); throw new AppError(401, 'login_required'); }
      if (admin && response.body) {
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        try {
          for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 4096) break; chunks.push(next.value); }
        } finally { await reader.cancel(); }
        if (bytes <= 4096) {
          let body: unknown; try { body = strictJson(Buffer.concat(chunks).toString('utf8')); } catch { fail('request_failed'); }
          if (object(body) && object(body.error) && typeof body.error.code === 'string' && adminErrors.has(body.error.code)) throw new AppError(response.status, body.error.code);
        }
        fail('request_failed');
      }
      await response.body?.cancel();
      if (response.status === 413 && response.headers.get('x-psm-chunk-required') === '1') throw new AppError(413, 'chunk_required');
      fail('request_failed');
    }
    const length = response.headers.get('content-length'); if (length && Number(length) > maxBytes) { await response.body?.cancel(); fail('response_too_large'); }
    const reader = response.body?.getReader(); if (!reader) fail('invalid_response');
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maxBytes) { await reader.cancel(); fail('response_too_large'); } chunks.push(next.value); }
    return strictJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  } catch (error) { if (error instanceof AppError && (error.code === 'chunk_required' || (admin && (adminErrors.has(error.code) || error.code === 'login_required')))) throw error; fail('request_failed'); }
}
export async function githubToken(ciUrl: string): Promise<string> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, credential = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !credential || /[\r\n\0]/.test(credential)) fail('oidc_unavailable');
  let url: URL; try { url = new URL(requestUrl); } catch { fail('oidc_unavailable'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !(url.hostname === 'actions.githubusercontent.com' || url.hostname.endsWith('.actions.githubusercontent.com'))) fail('oidc_untrusted_url');
  url.searchParams.set('audience',ciUrl);
  const response = await requestJson(url.toString(),{headers:{Authorization:`Bearer ${credential}`}},65536);
  if (!object(response) || typeof response.value !== 'string' || !response.value || /[\r\n\0]/.test(response.value)) fail('invalid_oidc_response');
  return response.value;
}
export function validateResolved(response: unknown, config: Config): ResolvedSecret[] {
  if (!object(response) || Object.keys(response).length !== 1 || !Array.isArray(response.secrets)) fail('invalid_response');
  const expected = new Map(Object.values(config.secrets).map(item => [item.name,item.kind])); const found = new Set<string>(); const result: ResolvedSecret[] = [];
  for (const raw of response.secrets) {
    if (!object(raw) || Object.keys(raw).length !== 3 || typeof raw.name !== 'string' || !expected.has(raw.name) || expected.get(raw.name) !== raw.kind || found.has(raw.name) || typeof raw.value !== 'string' || Buffer.from(raw.value,'utf8').toString('utf8') !== raw.value || Buffer.byteLength(raw.value) > 65536 || (raw.kind === 'env' && raw.value.includes('\0'))) fail('invalid_response');
    found.add(raw.name); result.push({name:raw.name,kind:raw.kind as ResolvedSecret['kind'],value:raw.value});
  }
  if (found.size !== expected.size) fail('invalid_response'); return result;
}
export async function resolveSecrets(config: Config, project: string, environment: string, ci: boolean): Promise<ResolvedSecret[]> {
  if (ci && !config.ciUrl) fail('missing_ci_url');
  const token = ci ? await githubToken(config.ciUrl!) : await cloudflared(['access','token','--app',config.adminUrl]);
  if (!token || /[\r\n\0]/.test(token)) fail('access_failed');
  const url = ci ? `${config.ciUrl}/v1/resolve` : `${config.adminUrl}/api/resolve`;
  const headers: Record<string,string> = {'content-type':'application/json'}; headers[ci ? 'Authorization' : 'cf-access-token'] = ci ? `Bearer ${token}` : token;
  const names = [...new Set(Object.values(config.secrets).map(item => item.name))];
  async function chunk(selected: string[]): Promise<ResolvedSecret[]> {
    const subset = {...config,secrets:Object.fromEntries(Object.entries(config.secrets).filter(([,item]) => selected.includes(item.name)))};
    try { return validateResolved(await requestJson(url,{method:'POST',headers,body:JSON.stringify({project,environment,names:selected})}),subset); }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'chunk_required' || selected.length === 1) fail('request_failed');
      const middle = Math.ceil(selected.length / 2);
      return [...await chunk(selected.slice(0,middle)),...await chunk(selected.slice(middle))];
    }
  }
  const secrets: ResolvedSecret[] = [];
  for (let index = 0; index < names.length; index += 10) secrets.push(...await chunk(names.slice(index,index + 10)));
  return validateResolved({secrets},config);
}
