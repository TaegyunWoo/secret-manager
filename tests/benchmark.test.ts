import assert from 'node:assert/strict';
import test from 'node:test';
import { measureResolve } from '../scripts/benchmark.js';

test('benchmark requests only declared keys and reports timing without values or tokens', async () => {
  const result = await measureResolve({
    url: 'https://ci.example.com', token: 'synthetic-auth-token', mode: 'ci',
    project: 'app', environment: 'dev', names: ['TOKEN'], iterations: 2,
  }, async (input, init) => {
    assert.equal(input, 'https://ci.example.com/v1/resolve');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-auth-token');
    assert.deepEqual(JSON.parse(String(init?.body)), { project: 'app', environment: 'dev', names: ['TOKEN'] });
    return new Response(JSON.stringify({secrets:[{name:'TOKEN',kind:'env',value:'synthetic-secret'}]}), {headers:{'content-type':'application/json'}});
  });
  assert.equal(result.requests, 2);
  assert.equal(result.successes, 2);
  assert.equal(result.failures, 0);
  assert.ok(result.p50Ms >= 0);
  assert.equal(result.measurement, 'client-wall-time');
  assert.doesNotMatch(JSON.stringify(result), /synthetic/);
});

test('benchmark bounds load and rejects unsafe destinations before sending a token', async () => {
  let called = false;
  const send = async () => { called=true; return new Response('{}'); };
  for (const [url, iterations] of [['http://example.com', 1], ['https://user:pass@example.com', 1], ['https://example.com', 101]] as const) {
    await assert.rejects(measureResolve({url,iterations,token:'test',mode:'admin',project:'app',environment:'dev',names:['TOKEN']},send));
  }
  assert.equal(called,false);
});

test('benchmark counts HTTP and network errors without serializing error content', async () => {
  let requests = 0;
  const result=await measureResolve({url:'http://127.0.0.1:8787',iterations:2,token:'test',mode:'admin',project:'app',environment:'dev',names:['TOKEN']}, async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('cf-access-token'), 'test');
    assert.equal(init?.redirect,'error');
    if (requests++===0) return new Response('private error detail',{status:403});
    throw new Error('private token detail');
  });
  assert.equal(result.failures,2);
  assert.equal(result.successes,0);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});
