import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AppError } from './errors.js';

export interface AccessConfig { ACCESS_ISSUER: string; ACCESS_AUD: string; ADMIN_EMAIL: string }
export interface GitHubConfig { CI_AUDIENCE: string }
export interface CiPolicy {
  id: string;
  environmentId: string;
  repositoryId: string;
  repositoryOwnerId: string;
  branch: string;
  workflow: string;
  events: string[];
  githubEnvironment: string | null;
  active: boolean;
}

const githubIssuer = 'https://token.actions.githubusercontent.com';
const remoteKeys = new Map<string, JWTVerifyGetKey>();
const allowedEvents = new Set(['push', 'workflow_dispatch']);
const digitId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && value.trim() === value;
const branch = (value: unknown): value is string => text(value) && /^refs\/heads\/[^\s~^:?*\[\\]+$/.test(value);
const repository = (value: unknown): value is string => text(value) && /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(value);

function trustedKeys(url: string): JWTVerifyGetKey {
  let keys = remoteKeys.get(url);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(url), { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000 });
    remoteKeys.set(url, keys);
  }
  return keys;
}

function boundedToken(value: string | null): string {
  if (!value || value.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    throw new AppError(401, 'unauthorized');
  }
  return value;
}

function accessToken(request: Request): string {
  const candidates = [request.headers.get('Cf-Access-Jwt-Assertion'), request.headers.get('cf-access-token')];
  const cookies = request.headers.get('Cookie');
  if (cookies) {
    for (const cookie of cookies.split(';')) {
      const separator = cookie.indexOf('=');
      if (separator >= 0 && cookie.slice(0, separator).trim() === 'CF_Authorization') {
        candidates.push(cookie.slice(separator + 1).trim());
      }
    }
  }
  const tokens = candidates.filter((value): value is string => value !== null);
  if (new Set(tokens).size !== 1) throw new AppError(401, 'unauthorized');
  return boundedToken(tokens[0]!);
}

async function verify(token: string, issuer: string, audience: string, keys: JWTVerifyGetKey): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256'], requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'] });
  const now = Math.floor(Date.now() / 1000);
  if (!text(payload.sub) || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat! > now || payload.exp! <= payload.iat!) {
    throw new Error('invalid_claims');
  }
  return payload;
}

export async function verifyAccess(request: Request, config: AccessConfig, jwks?: JWTVerifyGetKey): Promise<string> {
  if (!config || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.ACCESS_ISSUER) || !text(config.ACCESS_AUD) || !text(config.ADMIN_EMAIL) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.ADMIN_EMAIL)) {
    throw new AppError(500, 'configuration_error');
  }
  try {
    const claims = await verify(accessToken(request), config.ACCESS_ISSUER, config.ACCESS_AUD, jwks ?? trustedKeys(`${config.ACCESS_ISSUER}/cdn-cgi/access/certs`));
    if (claims.email !== config.ADMIN_EMAIL) throw new Error('wrong_owner');
    return config.ADMIN_EMAIL;
  } catch {
    throw new AppError(401, 'unauthorized');
  }
}

function githubIdentity(claims: JWTPayload): boolean {
  return digitId(claims.repository_id) && digitId(claims.repository_owner_id) && repository(claims.repository) && text(claims.ref) && text(claims.workflow_ref) && text(claims.event_name);
}

export async function verifyGitHub(request: Request, config: GitHubConfig, jwks?: JWTVerifyGetKey): Promise<JWTPayload> {
  if (!config || !text(config.CI_AUDIENCE)) throw new AppError(500, 'configuration_error');
  try {
    const authorization = request.headers.get('Authorization');
    const match = authorization && /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(authorization);
    const claims = await verify(boundedToken(match ? match[1]! : null), githubIssuer, config.CI_AUDIENCE, jwks ?? trustedKeys(`${githubIssuer}/.well-known/jwks`));
    if (!githubIdentity(claims)) throw new Error('invalid_identity');
    return claims;
  } catch {
    throw new AppError(401, 'unauthorized');
  }
}

function validPolicy(policy: CiPolicy): boolean {
  return policy?.active === true && text(policy.id) && text(policy.environmentId) && digitId(policy.repositoryId) && digitId(policy.repositoryOwnerId) && branch(policy.branch) && typeof policy.workflow === 'string' && /^\.github\/workflows\/[^\s/@\\]+\.ya?ml$/.test(policy.workflow) && Array.isArray(policy.events) && policy.events.length > 0 && policy.events.every(event => allowedEvents.has(event)) && (policy.githubEnvironment === null || text(policy.githubEnvironment));
}

export function authorizeGitHub(claims: JWTPayload, policies: CiPolicy[]): CiPolicy {
  if (!githubIdentity(claims) || !branch(claims.ref) || claims.ref_type !== 'branch' || !allowedEvents.has(claims.event_name as string)) {
    throw new AppError(403, 'forbidden');
  }
  const policy = policies.find(policy => validPolicy(policy) && claims.repository_id === policy.repositoryId && claims.repository_owner_id === policy.repositoryOwnerId && claims.ref === policy.branch && claims.workflow_ref === `${claims.repository}/${policy.workflow}@${policy.branch}` && policy.events.includes(claims.event_name as string) && (policy.githubEnvironment === null || claims.environment === policy.githubEnvironment));
  if (!policy) throw new AppError(403, 'forbidden');
  return policy;
}
