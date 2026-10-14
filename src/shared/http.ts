import { AppError } from './errors.js';

export const securityHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
} as const;

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if ((origin !== null && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new AppError(403, 'forbidden_origin');
  }
}

export async function readJson(request: Request, maxBytes = 1_048_576): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new AppError(415, 'unsupported_media_type');
  }
  if (Number(request.headers.get('content-length')) > maxBytes) throw new AppError(413, 'payload_too_large');
  if (!request.body) throw new AppError(400, 'invalid_json');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new AppError(413, 'payload_too_large');
      }
      text += decoder.decode(value, {stream:true});
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'invalid_json');
  } finally {
    reader.releaseLock();
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status,headers:{...securityHeaders,'content-type':'application/json; charset=utf-8'}});
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError && error.status >= 400 && error.status <= 599 && /^[a-z_]+$/.test(error.code)) {
    return jsonResponse({error:{code:error.code}}, error.status);
  }
  return jsonResponse({error:{code:'internal_error'}}, 500);
}
