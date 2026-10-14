import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/shared/errors.js';
import { assertSameOrigin, readJson, jsonResponse, errorResponse } from '../src/shared/http.js';

test('JSON body limit counts streamed bytes, including bodies without content-length', async () => {
  const request = new Request('https://admin.example.com/api/secrets', {method:'POST',headers:{'content-type':'application/json'},body:'{"value":"한글"}'});
  await assert.rejects(readJson(request, 15), {status:413,code:'payload_too_large'});
  const valid = new Request('https://admin.example.com/api/resolve', {method:'POST',headers:{'content-type':'application/json; charset=utf-8'},body:'{"names":["KEY"]}'});
  assert.deepEqual(await readJson(valid), {names:['KEY']});
});

test('JSON parser rejects form submissions and malformed bodies without echoing input', async () => {
  await assert.rejects(readJson(new Request('https://app.example/api/secrets',{method:'POST',body:'value=private'})), {status:415,code:'unsupported_media_type'});
  await assert.rejects(readJson(new Request('https://app.example/api/secrets',{method:'POST',headers:{'content-type':'application/json'},body:'private-invalid-json'})), {status:400,code:'invalid_json'});
});

test('origin guard permits CLI and same-origin requests but rejects cross-site calls', () => {
  assert.doesNotThrow(() => assertSameOrigin(new Request('https://app.example/api/resolve',{method:'POST'})));
  assert.doesNotThrow(() => assertSameOrigin(new Request('https://app.example/api/resolve',{method:'POST',headers:{origin:'https://app.example'}})));
  const hostileHeaders: Record<string,string>[] = [{origin:'https://evil.example'},{origin:'null'},{'sec-fetch-site':'cross-site'}];
  for (const headers of hostileHeaders) {
    assert.throws(() => assertSameOrigin(new Request('https://app.example/api/resolve',{method:'POST',headers})), {status:403,code:'forbidden_origin'});
  }
});

test('responses forbid caching and expose only safe application error codes', async () => {
  const response=jsonResponse({value:'synthetic'});
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.deepEqual(await errorResponse(new Error('private detail')).json(),{error:{code:'internal_error'}});
  assert.deepEqual(await errorResponse(new AppError(409,'version_conflict')).json(),{error:{code:'version_conflict'}});
});
