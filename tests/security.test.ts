import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { encrypt, decrypt, type CryptoContext } from '../src/shared/crypto.js';
import { verifyAccess, verifyGitHub, authorizeGitHub, type CiPolicy } from '../src/shared/auth.js';
import { AppError } from '../src/shared/errors.js';

const context: CryptoContext = { projectId: 'project', environmentId: 'production', secretId: 'pem', versionId: 'version-1' };
const keyring = { old: Buffer.alloc(32, 1).toString('base64'), current: Buffer.alloc(32, 2).toString('base64') };
const access = { ACCESS_ISSUER: 'https://example.cloudflareaccess.com', ACCESS_AUD: 'access-audience', ADMIN_EMAIL: 'owner@example.com' };
const github = { CI_AUDIENCE: 'https://ci.example.workers.dev' };
const policy: CiPolicy = { id: 'policy', environmentId: 'production', repositoryId: '123', repositoryOwnerId: '456', branch: 'refs/heads/main', workflow: '.github/workflows/deploy.yml', events: ['push', 'workflow_dispatch'], githubEnvironment: 'production', active: true };
const identity: JWTPayload = { repository_id: '123', repository_owner_id: '456', repository: 'owner/repo', ref: 'refs/heads/main', ref_type: 'branch', workflow_ref: 'owner/repo/.github/workflows/deploy.yml@refs/heads/main', event_name: 'push', environment: 'production' };
let key: CryptoKey;
let otherKey: CryptoKey;
let jwks: JWTVerifyGetKey;
before(async () => {
  const pair = await generateKeyPair('RS256');
  key = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' }] });
});
async function token(payload: JWTPayload, signingKey = key): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).sign(signingKey);
}
function accessClaims(overrides: JWTPayload = {}): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return { iss: access.ACCESS_ISSUER, aud: access.ACCESS_AUD, sub: 'access-subject', iat: now, exp: now + 300, email: access.ADMIN_EMAIL, ...overrides };
}
function githubClaims(overrides: JWTPayload = {}): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'https://token.actions.githubusercontent.com', aud: github.CI_AUDIENCE, sub: 'repo:owner/repo:environment:production', iat: now, exp: now + 300, ...identity, ...overrides };
}
function request(value: string, header = 'Cf-Access-Jwt-Assertion'): Request {
  return new Request('https://example.workers.dev', { headers: { [header]: value } });
}
function error(status: number, code: string) {
  return (value: unknown) => value instanceof AppError && value.status === status && value.code === code && value.message === code;
}

test('AES-GCM preserves PEM CRLF and unicode exactly', async () => {
  const pem = '-----BEGIN PRIVATE KEY-----\r\n한글\r\n-----END PRIVATE KEY-----\r\n';
  const encrypted = await encrypt(pem, context, keyring, 'current');
  assert.equal(encrypted.keyId, 'current');
  assert.equal(Buffer.from(encrypted.nonce, 'base64').length, 12);
  assert.equal(await decrypt(encrypted, context, keyring), pem);
  assert.ok(!encrypted.ciphertext.includes('PRIVATE KEY'));
});
test('every encryption uses a fresh nonce', async () => {
  const records = await Promise.all(Array.from({ length: 64 }, () => encrypt('same value', context, keyring, 'current')));
  assert.equal(new Set(records.map(record => record.nonce)).size, 64);
});
test('old and current key versions both decrypt during rotation', async () => {
  const old = await encrypt('old value', context, keyring, 'old');
  const current = await encrypt('new value', context, keyring, 'current');
  assert.equal(await decrypt(old, context, keyring), 'old value');
  assert.equal(await decrypt(current, context, keyring), 'new value');
  await assert.rejects(decrypt(old, context, { current: keyring.current }), error(500, 'configuration_error'));
});
test('tampered ciphertext and every swapped context field reject decryption safely', async () => {
  const record = await encrypt('secret plaintext', context, keyring, 'current');
  const damaged = Buffer.from(record.ciphertext, 'base64');
  damaged[0] = damaged[0]! ^ 1;
  await assert.rejects(decrypt({ ...record, ciphertext: damaged.toString('base64') }, context, keyring), error(500, 'decryption_failed'));
  for (const field of Object.keys(context) as (keyof CryptoContext)[]) {
    await assert.rejects(decrypt(record, { ...context, [field]: 'different' }, keyring), error(500, 'decryption_failed'));
  }
  await assert.rejects(decrypt(record, context, { current: keyring.old }), error(500, 'decryption_failed'));
});
test('malformed keys, nonce, ciphertext and missing context fail closed', async () => {
  for (const malformed of ['', 'not base64', Buffer.alloc(31).toString('base64'), '__proto__']) {
    await assert.rejects(encrypt('value', context, { current: malformed }, 'current'), error(500, 'configuration_error'));
  }
  await assert.rejects(encrypt('value', context, keyring, '__proto__'), error(500, 'configuration_error'));
  await assert.rejects(encrypt('value', { ...context, versionId: '' }, keyring, 'current'), error(500, 'configuration_error'));
  const record = await encrypt('value', context, keyring, 'current');
  for (const changes of [{ nonce: 'bad' }, { nonce: Buffer.alloc(11).toString('base64') }, { ciphertext: 'bad' }, { ciphertext: '' }]) {
    await assert.rejects(decrypt({ ...record, ...changes }, context, keyring), error(500, 'decryption_failed'));
  }
});

test('Access authenticates signed owner token from assertion, CLI header and cookie', async () => {
  const signed = await token(accessClaims());
  for (const req of [request(signed), request(signed, 'cf-access-token'), request(`other=1; CF_Authorization=${signed}`, 'Cookie')]) {
    assert.equal(await verifyAccess(req, access, jwks), 'owner@example.com');
  }
});
test('Access rejects wrong issuer, audience, email and token lifetimes', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const override of [{ iss: 'https://evil.cloudflareaccess.com' }, { aud: 'other' }, { email: 'other@example.com' }, { email: 'OWNER@example.com' }, { exp: now - 1 }, { iat: now + 60 }, { exp: undefined }, { iat: undefined }, { sub: undefined }, { email: undefined }, { nbf: now + 60 }]) {
    await assert.rejects(verifyAccess(request(await token(accessClaims(override))), access, jwks), error(401, 'unauthorized'));
  }
});
test('Access rejects unsigned, incorrectly signed and non-RS256 tokens', async () => {
  const claims = accessClaims();
  await assert.rejects(verifyAccess(request(await token(claims, otherKey)), access, jwks), error(401, 'unauthorized'));
  const hmac = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32));
  await assert.rejects(verifyAccess(request(hmac), access, jwks), error(401, 'unauthorized'));
  await assert.rejects(verifyAccess(request('eyJhbGciOiJub25lIn0.e30.'), access, jwks), error(401, 'unauthorized'));
});
test('missing, oversized and conflicting Access tokens reject safely', async () => {
  for (const req of [new Request('https://example.com'), request('a'.repeat(17000)), request('invalid.token.here')]) {
    await assert.rejects(verifyAccess(req, access, jwks), error(401, 'unauthorized'));
  }
  const signed = await token(accessClaims());
  const req = new Request('https://example.com', { headers: { 'cf-access-jwt-assertion': signed, 'cf-access-token': await token(accessClaims({ sub: 'different' })) } });
  await assert.rejects(verifyAccess(req, access, jwks), error(401, 'unauthorized'));
});
test('Access config rejects absent or untrusted issuer, audience and owner email even with test JWKS', async () => {
  const signed = await token(accessClaims());
  for (const override of [{ ACCESS_ISSUER: '' }, { ACCESS_ISSUER: 'http://example.cloudflareaccess.com' }, { ACCESS_ISSUER: 'https://example.com' }, { ACCESS_ISSUER: 'https://example.cloudflareaccess.com/path' }, { ACCESS_AUD: '' }, { ADMIN_EMAIL: '' }]) {
    await assert.rejects(verifyAccess(request(signed), { ...access, ...override }, jwks), error(500, 'configuration_error'));
  }
});
test('GitHub verifies the signed issuer, audience and required identity', async () => {
  const claims = await verifyGitHub(request(`Bearer ${await token(githubClaims())}`, 'Authorization'), github, jwks);
  assert.equal(claims.repository_id, '123');
  assert.equal(authorizeGitHub(claims, [policy]).environmentId, 'production');
});
test('GitHub rejects wrong issuer, audience, signature, expiry and missing time/subject', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const override of [{ iss: access.ACCESS_ISSUER }, { aud: 'other' }, { exp: now - 1 }, { exp: undefined }, { iat: undefined }, { iat: now + 60 }, { sub: undefined }, { nbf: now + 60 }]) {
    await assert.rejects(verifyGitHub(request(`Bearer ${await token(githubClaims(override))}`, 'Authorization'), github, jwks), error(401, 'unauthorized'));
  }
  await assert.rejects(verifyGitHub(request(`Bearer ${await token(githubClaims(), otherKey)}`, 'Authorization'), github, jwks), error(401, 'unauthorized'));
});
test('GitHub rejects missing/bad authorization and audience configuration', async () => {
  for (const header of ['', 'Basic value', 'Bearer invalid', `Bearer ${'a'.repeat(17000)}`]) {
    await assert.rejects(verifyGitHub(request(header, 'Authorization'), github, jwks), error(401, 'unauthorized'));
  }
  await assert.rejects(verifyGitHub(request('Bearer invalid', 'Authorization'), { CI_AUDIENCE: '' }, jwks), error(500, 'configuration_error'));
});
test('GitHub requires canonical repository and owner IDs plus branch workflow event identity', async () => {
  for (const override of [{ repository_id: '0123' }, { repository_id: 123 }, { repository_owner_id: '0456' }, { repository_owner_id: 456 }, { repository: undefined }, { ref: undefined }, { workflow_ref: undefined }, { event_name: undefined }]) {
    await assert.rejects(verifyGitHub(request(`Bearer ${await token(githubClaims(override))}`, 'Authorization'), github, jwks), error(401, 'unauthorized'));
  }
});

test('GitHub policy denies PRs, tags and every mismatched identity dimension', () => {
  for (const override of [{ event_name: 'pull_request' }, { event_name: 'pull_request_target' }, { event_name: 'schedule' }, { ref: 'refs/tags/main', ref_type: 'tag' }, { ref_type: 'tag' }, { repository_id: '999' }, { repository_owner_id: '999' }, { repository_id: 123 }, { repository_id: '0123' }, { ref: 'refs/heads/other' }, { workflow_ref: 'owner/repo/.github/workflows/other.yml@refs/heads/main' }, { workflow_ref: 'owner/other/.github/workflows/deploy.yml@refs/heads/main' }, { workflow_ref: 'owner/repo/.github/workflows/deploy.yml@refs/heads/other' }, { environment: 'other' }, { environment: undefined }]) {
    assert.throws(() => authorizeGitHub({ ...identity, ...override }, [policy]), error(403, 'forbidden'));
  }
});
test('active policy and event allowlist are evaluated for every request', () => {
  const policies = [{ ...policy }];
  assert.equal(authorizeGitHub(identity, policies).id, 'policy');
  policies[0]!.active = false;
  assert.throws(() => authorizeGitHub(identity, policies), error(403, 'forbidden'));
  assert.throws(() => authorizeGitHub(identity, []), error(403, 'forbidden'));
  assert.throws(() => authorizeGitHub(identity, [{ ...policy, events: ['workflow_dispatch'] }]), error(403, 'forbidden'));
  assert.equal(authorizeGitHub({ ...identity, event_name: 'workflow_dispatch' }, [policy]).id, 'policy');
});
test('GitHub Environment is optional but environment subject never bypasses branch', () => {
  const optional = { ...policy, githubEnvironment: null };
  assert.equal(authorizeGitHub({ ...identity, environment: undefined }, [optional]).id, 'policy');
  assert.throws(() => authorizeGitHub({ ...identity, sub: 'repo:owner/repo:environment:production', ref: 'refs/heads/other' }, [policy]), error(403, 'forbidden'));
});
test('malformed policies cannot grant access', () => {
  for (const override of [{ repositoryId: '0123' }, { repositoryOwnerId: '0456' }, { branch: 'main' }, { branch: 'refs/tags/main' }, { workflow: '../deploy.yml' }, { events: ['push', 'pull_request'] }, { events: [] }, { githubEnvironment: '' }, { active: 1 }, { environmentId: '' }]) {
    assert.throws(() => authorizeGitHub(identity, [{ ...policy, ...override } as CiPolicy]), error(403, 'forbidden'));
  }
});
