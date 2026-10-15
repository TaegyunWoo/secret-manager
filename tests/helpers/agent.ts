import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { database } from './d1.js';
import { createAdminHandler } from '../../src/admin/index.js';
import { Store } from '../../src/shared/store.js';

const entry = resolve('src/cli/index.ts');
export async function agentFixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'psm-agent-'));
  const data = await database();
  const pair = await generateKeyPair('RS256');
  const handler = createAdminHandler(createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'agent-test', alg: 'RS256' }] }));
  const config = { ACCESS_ISSUER: 'https://example.cloudflareaccess.com', ACCESS_AUD: 'test', ADMIN_EMAIL: 'owner@example.com', ACTIVE_KEY_ID: 'test', KEYRING_JSON: JSON.stringify({ test: Buffer.alloc(32, 4).toString('base64') }) };
  const token = await new SignJWT({ email: config.ADMIN_EMAIL }).setProtectedHeader({ alg: 'RS256', kid: 'agent-test' }).setIssuer(config.ACCESS_ISSUER).setAudience(config.ACCESS_AUD).setSubject('owner').setIssuedAt().setExpirationTime('1h').sign(pair.privateKey);
  const requests: { path: string; method: string; body: any }[] = [];
  let beforeRequest: ((path: string) => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const part of req) body += part;
      requests.push({ path: req.url!, method: req.method!, body: body ? JSON.parse(body) : undefined });
      await beforeRequest?.(req.url!);
      const headers = Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, String(value)]));
      const response = await handler.fetch(new Request(`https://test.example${req.url}`, { method: req.method, headers, ...(body ? { body } : {}) }), { ...config, DB: data.db, ASSETS: { fetch: async () => new Response('test') } });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"code":"internal_error"}}'); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bin = join(dir, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(join(bin, 'cloudflared'), `#!${process.execPath}\nif(process.env.CF_FAIL || (process.env.CF_TOKEN_FAIL && process.argv[3]==='token'))process.exit(1);process.stdout.write(${JSON.stringify(token)});\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: join(dir, 'settings'), TMPDIR: dir };
  const app = join(dir, 'new-app'); await fs.mkdir(app);
  const store = new Store(data.db, JSON.parse(config.KEYRING_JSON), config.ACTIVE_KEY_ID);
  async function cli(args: string[], options: { input?: string; extra?: NodeJS.ProcessEnv; cwd?: string } = {}) {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], { cwd: options.cwd ?? app, env: { ...env, ...options.extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {}); child.stdin.end(options.input ?? '');
    let stdout = '', stderr = ''; child.stdout.on('data', part => stdout += part); child.stderr.on('data', part => stderr += part);
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(done => child.on('close', code => done({ code, stdout, stderr })));
  }
  return { dir, app, url, env, store, requests, cli, onRequest(callback: (path: string) => Promise<void>) { beforeRequest=callback; }, async close() { await new Promise<void>(done => server.close(() => done())); await data.dispose(); await fs.rm(dir, { recursive: true, force: true }); } };
}
