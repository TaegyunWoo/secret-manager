# 개인 시크릿 저장소 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 승인된 설계의 관리 Worker, CI Worker, 웹 화면, 로컬/CI CLI와 복구 기능을 실행 가능한 코드와 테스트로 구현한다.

**Architecture:** 두 Worker는 Web Crypto 암호화 모듈과 D1 저장소를 공유한다. 관리 Worker만 정적 웹 화면과 변경 API를 제공한다. CLI는 필요한 키만 조회해 자식 프로세스에 주입한다.

**Tech Stack:** TypeScript, Node.js 22 이상, Cloudflare Workers/D1, jose, Node test runner, Miniflare. 웹은 프레임워크 없이 HTML/CSS/JavaScript를 사용한다.

**Spec:** `docs/design.md`, 승인 근거 `docs/approvals.md`.

## Global Constraints

- AES-256-GCM, 암호화마다 새 nonce, 프로젝트/환경/시크릿/버전 ID를 AAD에 포함. key_id 기록.
- 현재 값을 포함한 최근 10개 버전, 휴지통 7일, 감사 기록 30일.
- 비밀 응답 no-store. 비밀값/토큰/본문을 로그에 기록하지 않는다. 목록은 값 제외.
- Access JWT 서명/발급자/대상/만료와 정확한 관리자 이메일 확인. Google 전용/1시간 세션은 Access 배포 설정.
- CI는 GitHub JWT 검증 후 숫자 저장소/소유자 ID, 브랜치, 워크플로, push/workflow_dispatch, 선택적 Environment, 활성 정책을 매 요청 확인한다.
- 읽기는 요청 키 전체 성공 또는 전체 실패. CI에는 관리 라우트가 없다.
- D1 batch의 변경 건수 0을 롤백으로 간주하지 않는다. 동시 수정은 CAS와 DB 제약/조건부 SQL로 원자적으로 방지.
- CLI는 macOS/Linux, 캐시 없음, 파일 0600/디렉터리 0700, 정상 종료/신호 정리, 남은 파일의 소유권과 프로세스 생존 확인.
- 공개 산출물에 실제 키/토큰 없음. 복구는 빈 DB에만, 모든 암호문 검증, 복구된 CI 정책은 비활성.
- 배포와 실제 무료 CPU 측정은 구현과 별도다. 이 작업은 재현 가능한 배포/측정 절차를 준비하고 로컬 결과를 실제 CPU 증거로 주장하지 않는다.

## Review Focus

1. 동시 수정/가져오기 충돌은 현재 값과 이력에 부분 쓰기를 남기지 않는다.
2. 변조/이식 암호문, 잘못된 JWT, PR/태그/다른 워크플로는 거부한다.
3. .env 중복 및 CRLF PEM은 사용자의 명시적 덮어쓰기 선택과 원문을 보존한다.
4. CLI 오류/신호/동시 실행/심볼릭 링크는 자식 실행과 파일 정리 경계를 깨뜨리지 않는다.
5. 손상된 백업/기존 DB 복구는 실패하고 정책을 활성화하지 않는다.

## Task 1: 암호화와 인증

**Files:** `src/shared/crypto.ts`, `src/shared/auth.ts`, `src/shared/errors.ts`, `tests/security.test.ts`.
**Interfaces:** `encrypt(value, context, keyring, activeKeyId)` returns `{ciphertext,nonce,keyId}`; `decrypt(record, context, keyring)` returns string. Context `{projectId,environmentId,secretId,versionId}`; keyring is `Record<string,string>` of base64 32-byte keys. `verifyAccess(request, config)` returns actor string; `verifyGitHub(request, config)` returns verified jose JWTPayload. `authorizeGitHub(claims, policies)` returns matching policy or throws. Auth config uses `ACCESS_ISSUER`, `ACCESS_AUD`, `ADMIN_EMAIL`, `CI_AUDIENCE`; test JWKS injection is optional function parameter, never environment bypass. `AppError(status, code)` safe errors.

- [ ] RED: AES exact CRLF roundtrip, nonce uniqueness, key rotation, tampered/context swapped ciphertext rejection; signed local JWT fixtures for invalid issuer/audience/expiry/email/signature; deny PR/tag/wrong numeric IDs/ref/workflow/environment/inactive policy.
- [ ] GREEN: Web Crypto + jose restricted RS256, bounded JWT input, required time/identity claims, remote trusted JWKS caches. Policy fields: `id, environmentId, repositoryId, repositoryOwnerId, branch` (full refs/heads/...), `workflow` (.github/workflows/file.yml), `events` (allowed subset), `githubEnvironment` (nullable), `active` boolean. Match workflow_ref against verified repository + path + ref exactly.
- [ ] Verify `npm test -- tests/security.test.ts` (or direct node test command) and `npm run typecheck`.

## Task 2: D1 저장소와 복구

**Files:** `migrations/0001_initial.sql`, `src/shared/store.ts`, `src/shared/imports.ts`, `src/shared/backup.ts`, `src/shared/types.ts`, `tests/store.test.ts`, `tests/helpers/d1.ts`.
**Interfaces:** `Store(db, keyring, activeKeyId)` methods `listProjects/createProject/updateProject/deleteProject`, `listEnvironments/createEnvironment/updateEnvironment/deleteEnvironment`, `listSecrets/createSecret/updateSecret/deleteSecret/reveal/listVersions/restoreVersion/listTrash/restoreSecret/resolve`, `listPolicies/savePolicy/deletePolicy`, `listAudit/audit/cleanup`. Use camelCase JSON records, UUID IDs, millisecond timestamps, currentVersionId for CAS. Project `{id,name,slug}`, environment `{id,projectId,name}`, secret `{id,environmentId,name,kind:'env'|'file',currentVersionId,deletedAt,createdAt,updatedAt}`. Resolve `(projectSlug, environmentName, names)` returns `{secrets:[{name,kind,value}]}`. Signature details finalized by implementer in report before API task.

- [ ] RED: real Miniflare D1 integration testing plaintext absent in DB, all-or-none resolution, stale/concurrent updates, maximum 10 versions, 7-day restore deadline, 30-day audit retention, bounded cleanup, uniqueness.
- [ ] GREEN: six tables with constraints/indexes, transactions/conditional inserts with fail-fast CAS guard. Parent deletion must reject nonempty parents. Rename metadata allowed without altering encryption context IDs. Version restore creates a new encrypted version. Tombstones reserve names until purge. Secret size max 64 KiB, max 100 resolve/import entries. Values can be empty. No secrets in errors.
- [ ] RED/GREEN: dotenv parser supports export, comments, single/double quote multiline values without interpolation; rejects malformed lines/duplicate input keys; preview marks existing keys; apply requires explicitly chosen overwrites and expected version IDs, transactionally handles conflicts.
- [ ] RED/GREEN: encrypted JSON backup includes schemaVersion, createdAt and all six tables; bounded export/import, validate IDs/relationships/ciphertexts before writes, restore only to empty DB in one transaction, policies forced inactive.
- [ ] Verify store tests and typecheck. Document public signatures in task report for consumers.

## Task 3: Worker API와 운영 설정

**Files:** `src/admin/index.ts`, `src/ci/index.ts`, `src/shared/http.ts`, `wrangler.admin.jsonc`, `wrangler.ci.jsonc`, `.dev.vars.example`, `tests/api.test.ts`, `scripts/benchmark.ts`.
**Interfaces:** Admin routes JSON: GET/POST `/api/projects`; PATCH/DELETE `/api/projects/:id`; GET `?projectId` and POST `/api/environments`; PATCH/DELETE `/api/environments/:id`; GET `?environmentId` and POST `/api/secrets`; PATCH/DELETE `/api/secrets/:id`; POST `/api/secrets/:id/reveal`; GET `/api/secrets/:id/versions`; POST `/api/secrets/:id/versions/:versionId/restore`; GET `/api/trash?environmentId`; POST `/api/trash/:id/restore`; POST `/api/imports/preview` and `/api/imports/apply`; POST `/api/resolve` body `{project,environment,names}`; GET/POST `/api/ci-policies`, PATCH/DELETE `/api/ci-policies/:id`; GET `/api/audit-events`; GET `/api/backup`; POST `/api/backup/restore`. Responses use `{projects}`, `{environments}`, `{secrets}`, `{versions}`, `{policies}`, `{events}` or resource objects; errors `{error:{code}}`. CI only POST `/v1/resolve` with identical resolve body/result.

- [ ] RED: signed JWT HTTP integration tests for every trust boundary, all-or-none retrieval, no-store, safe errors, forged origins/cross-site mutation rejected, real D1 current policy revocation, CI cannot reach management routes.
- [ ] GREEN: authenticate every admin route including assets using Worker-first routing; JSON-only mutation with same-origin validation when Origin present (CLI no Origin allowed), request size limit and no CORS. Auth headers Cf-Access-Jwt-Assertion or CF_Authorization cookie; CLI uses cf-access-token translated by Access, direct token accepted with full verification. Root assets route via binding only after verification. Audit successes/denials/errors without payloads. Scheduled bounded cleanup.
- [ ] Verify dry-run builds for both Workers and benchmark harness against local synthetic data; cloud metrics explicitly unverified.

## Task 4: CLI

**Files:** `src/cli/index.ts`, `src/cli/config.ts`, `src/cli/run.ts`, `src/cli/client.ts`, `tests/cli.test.ts`, `psm.example.json`.
**Interfaces:** `psm login [--config psm.json]`, `psm run --project SLUG --env NAME [--config FILE] [--ci] -- COMMAND ARGS`. Config `{adminUrl,ciUrl?,secrets:{VARIABLE:{name,kind:'env'|'file'}}}` contains no values. HTTPS required except explicit loopback HTTP for local tests. cloudflared access login URL then access token --app URL; run retrieves token without printing. CI fetches OIDC using GitHub ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN and audience ciUrl; POST CI resolve. Handle child exit code/signals.

- [ ] RED/GREEN: missing/unknown key or unavailable backend prevents child spawn; no values on stdout/logs; file exact bytes and modes; cleanup after exit/signal; live peer directory kept; stale owned directory removed; symlinks/unowned entries never followed. Reject duplicate destinations, prototype names, unsafe names, NUL env values. Only configured names resolved.
- [ ] Verify real child process integration including nonzero exit, SIGTERM, interrupted file preparation, inherited environment and temporary file cleanup.

## Task 5: 웹 관리와 통합 문서

**Files:** `public/index.html`, `public/app.js`, `public/style.css`, `tests/web.test.ts`, `README.md`, `docs/operations.md`, `docs/api.md`, `.github/workflows/check.yml`, `.github/workflows/consume-example.yml`.
**Interfaces:** Task 3 API. Korean labels, accessible forms/statuses, responsive layout. No values in list DOM. Secret details populated only on explicit reveal/copy/download and cleared on dismiss/navigation. PEM text upload/download exact. Users can manage projects/environments, edit/delete/restore secrets and versions, preview/apply dotenv chosen conflicts, manage CI policies, inspect audit, export/restore encrypted backup.

- [ ] RED/GREEN: web behavior tests for XSS-safe rendering, explicit reveal, conflict form, status handling; browser smoke of core interactions at multiple widths when available.
- [ ] Document configuration, Access Google allow+require and 1-hour session, workers.dev/preview protection, keys/rotation, encrypted backup/empty DB restore and offline keys, CLI auth/install, GitHub policy/PR denial, rollout and CPU metrics gate. No actual account identifiers/keys in examples.
- [ ] CI runs npm ci/check/deploy:check using no production secrets. Example consumption workflow is manual-only with id-token write and example config, no PR secret access.
- [ ] Final full suite, typecheck, builds, independent security/spec review. Fix important findings with regression tests. Report only verified implementation and explicitly state cloud deployment/performance limits.
