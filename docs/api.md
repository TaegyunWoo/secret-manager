# API 참조

관리 API는 [관리 Worker](../src/admin/index.ts), CI 조회 API는 [CI Worker](../src/ci/index.ts)가 제공한다. 두 Worker는 서로 다른 origin에 배포한다. 운영 설정과 인증 준비는 [운영 문서](operations.md)를 따른다.

## 공통 규칙

요청과 응답은 JSON이다. POST, PATCH, DELETE에는 `Content-Type: application/json`과 JSON 본문을 보낸다. 별도 입력이 없는 변경 요청에도 `{}`를 보낸다. 브라우저 변경 요청의 Origin은 Worker origin과 같아야 하며 CORS는 제공하지 않는다. 모든 응답에 `Cache-Control: no-store`를 적용한다.

관리 요청은 검증 가능한 Cloudflare Access JWT가 필요하다. Access가 전달하는 `Cf-Access-Jwt-Assertion`, 브라우저의 `CF_Authorization` 쿠키, CLI의 `cf-access-token` 헤더를 지원한다. 서로 다른 토큰을 동시에 보내면 거부한다. 정적 자산에도 같은 인증을 적용한다.

CI 요청은 `Authorization: Bearer <GitHub OIDC JWT>`를 사용한다. audience는 CI Worker의 `CI_AUDIENCE`와 일치해야 한다. 활성 정책의 저장소·소유자 숫자 ID, 전체 브랜치 ref, 워크플로, 이벤트와 선택적인 GitHub Environment가 모두 일치해야 한다.

ID는 서버가 생성한 UUID이며 클라이언트가 지정하지 않는다. 시각은 Unix epoch 기준 밀리초다. 시크릿 종류는 `env` 또는 `file`이다. 메타데이터 목록에는 값이나 암호문을 포함하지 않는다.

## 관리 경로

아래 경로는 관리 Worker origin을 기준으로 한다. `:id`와 `:versionId`는 해당 자원의 ID로 바꾼다.

생성 요청은 201, 나머지 성공 요청은 200을 반환한다. 알 수 없는 경로·메서드는 404다. 본문의 알 수 없는 필드는 거부한다. `GET /api/audit-events`의 `limit`은 기본 100이며 1-500을 허용한다.

| 메서드와 경로 | 입력 | 성공 응답 |
|---|---|---|
| `GET /api/projects` | 없음 | `{projects}` |
| `POST /api/projects` | `{name,slug}` | 프로젝트 |
| `PATCH /api/projects/:id` | `{name,slug}` | 프로젝트 |
| `DELETE /api/projects/:id` | `{}` | `{ok:true}` |
| `GET /api/environments` | 선택 쿼리 `projectId` | `{environments}` |
| `POST /api/environments` | `{projectId,name}` | 환경 |
| `PATCH /api/environments/:id` | `{name}` | 환경 |
| `DELETE /api/environments/:id` | `{}` | `{ok:true}` |
| `GET /api/secrets` | 쿼리 `environmentId` | `{secrets}` |
| `POST /api/secrets` | `{environmentId,name,kind,value}` | 시크릿 메타데이터 |
| `PATCH /api/secrets/:id` | `{expectedVersionId,name?,kind?,value?}` | 시크릿 메타데이터 |
| `DELETE /api/secrets/:id` | `{expectedVersionId}` | `{ok:true}` |
| `POST /api/secrets/:id/reveal` | `{}` | `{name,kind,value}` |
| `GET /api/secrets/:id/versions` | 없음 | `{versions}` |
| `POST /api/secrets/:id/versions/:versionId/restore` | `{expectedVersionId}` | 시크릿 메타데이터 |
| `GET /api/trash` | 선택 쿼리 `environmentId` | `{secrets}` |
| `POST /api/trash/:id/restore` | `{expectedVersionId}` | 시크릿 메타데이터 |
| `POST /api/imports/preview` | `{environmentId,source}` | `{entries}` |
| `POST /api/imports/apply` | `{environmentId,entries}` | `{secrets}` |
| `POST /api/resolve` | `{project,environment,names}` | `{secrets:[{name,kind,value}]}` |
| `GET /api/ci-policies` | 선택 쿼리 `environmentId` | `{policies}` |
| `POST /api/ci-policies` | 아래 정책 필드 | 정책 |
| `PATCH /api/ci-policies/:id` | 변경할 정책 필드 | 정책 |
| `DELETE /api/ci-policies/:id` | `{}` | `{ok:true}` |
| `GET /api/audit-events` | 선택 쿼리 `limit` | `{events}` |
| `GET /api/backup` | 없음 | 암호문 백업 |
| `POST /api/backup/restore` | 암호문 백업 전체 | `{ok:true}` |
| `POST /api/operations` | 아래 작업 생성 필드 | 작업 메타데이터, 201 |
| `GET /api/operations/:id` | 없음 | 작업 메타데이터 |
| `POST /api/operations/:id/chunks` | `{index,table,rows}` | `{ok:true}` |
| `GET /api/operations/:id/chunks` | 쿼리 `table`, `index` | `{rows,nextIndex}` |
| `POST /api/operations/:id/commit` | `{}` | `{ok:true}` |
| `DELETE /api/operations/:id` | `{}` | `{ok:true}` |

하위 항목이 남아 있는 프로젝트와 환경은 삭제할 수 없다. 시크릿 삭제는 휴지통으로 이동하며 이름을 계속 예약한다. 보존 기간과 입력 크기 제한은 [운영 문서](operations.md)에 명시한다.

`expectedVersionId`에는 마지막으로 조회한 시크릿의 `currentVersionId`를 넣는다. 그 사이 다른 요청이 값을 수정했으면 `409 conflict`를 반환한다. 최신 목록을 다시 읽어 사용자가 변경 내용을 확인한 뒤 재시도한다. 이력 복원도 새 버전을 만든다.

가져오기 미리보기의 각 항목은 `{name,value,exists,deleted,expectedVersionId?}`다. 적용 요청의 `entries`에는 사용자가 선택한 `{name,value,expectedVersionId?}`만 넣는다. 기존 항목을 덮어쓸 때는 미리보기의 버전 ID를 유지한다. 하나라도 충돌하면 전체 적용을 거부한다. 미리보기는 원래 입력값을 반환하므로 화면에서는 이름과 충돌 상태만 표시한다.

## 큰 작업의 분할 처리

조회는 전체 최대 100개 이름을 허용하되 요청별 10개 이하, 합산 현재 암호문 87,404 bytes 이하로 나눈다. 관리·CI 조회가 이 요청 상한을 넘으면 `413 chunk_required`와 `x-psm-chunk-required: 1`을 반환한다. CLI는 10개씩 요청하고 크기 힌트에 따라 해당 묶음을 이분한다. 그 외 오류를 분할 재시도로 처리하지 않는다.

작업 API의 구현은 [Operations](../src/shared/operations.ts)다. 생성한 관리자만 접근하며 10분 뒤 만료된다. 전체 동시 `preparing`·`ready` 작업은 8개로 제한한다. 상태는 `preparing`, `ready`, `committed`, `cancelled`이고 메타데이터에는 ID, 종류, 테이블별 counts, createdAt, expiresAt, nextIndex, 누적 bytes가 포함된다.

| 종류 | 생성 본문 | 처리 |
|---|---|---|
| 가져오기 | `{kind:"import",environmentId,counts:{imports:N}}` | 전체 1-100개, `imports` 조각 준비 후 commit |
| 복구 | `{kind:"restore",createdAt,counts}` | 원본 백업 시각과 여섯 테이블의 정확한 행 수, 조각 준비 후 commit |
| 내보내기 | `{kind:"export"}` | 서버가 한 트랜잭션으로 스냅샷과 counts 생성, 페이지 조회 후 DELETE |

조각 index는 작업 전체에서 0부터 연속 증가한다. 복구는 `projects`, `environments`, `secrets`, `secret_versions`, `ci_policies`, `audit_events` 순서로 보낸다. 행 수가 0인 테이블은 건너뛴다. 테이블별 전체 counts와 누적 입력 상한을 넘길 수 없다.

가져오기 조각은 최대 10개, 값의 합산 UTF-8 크기 64 KiB 이하다. 저장 준비 데이터는 서버에서 암호화하며 값은 업무 목록에 노출하지 않는다. 전체 entries JSON은 128 KiB 이하다. commit은 모든 조각의 준비 완료와 버전 충돌을 다시 확인하고 전체를 원자적으로 반영한다. 완료한 commit은 작업 만료 전까지 재시도할 수 있다.

복구 조각은 JSON 90,000 bytes 이하이며 암호문 버전 최대 10행, 그 외 테이블 최대 100행이다. 무료 CPU를 줄이기 위해 웹은 암호문 버전을 한 행씩 보낸다. 전체 백업은 1 MiB·테이블별 1,000행 한도를 유지한다. 복호화·참조 검증을 거친 뒤 빈 대상에 원자적으로 반영하고 CI 정책은 비활성화한다.

내보내기 페이지는 암호문 버전 최대 10행, 메타데이터 최대 100행이고 JSON 크기에도 상한을 적용한다. `nextIndex: null`이면 해당 테이블의 마지막 페이지다. 작업 준비 후 업무 데이터가 바뀌어도 같은 스냅샷의 행을 반환한다. 원래 `GET /api/backup`과 `POST /api/backup/restore`는 작은 백업에 유지하며 큰 요청에는 분할 힌트를 반환한다.

DELETE는 작업을 취소하고 조각을 제거한다. 이미 완료한 commit의 재시도 기록은 유지한다. 만료 작업과 조각은 Cron이 제거한다. 분할 호출에도 원래 인증·Origin·감사 기록 규칙을 적용한다.

## 자원 필드

필드 정의의 원본은 [공유 타입](../src/shared/types.ts)이다.

| 자원 | 필드 |
|---|---|
| 프로젝트 | `id`, `name`, `slug` |
| 환경 | `id`, `projectId`, `name` |
| 시크릿 메타데이터 | `id`, `environmentId`, `name`, `kind`, `currentVersionId`, `deletedAt`, `createdAt`, `updatedAt` |
| 버전 메타데이터 | `id`, `secretId`, `keyId`, `createdAt` |
| 감사 이벤트 | `id`, `actor`, `action`, `targetId`, `result`, `createdAt` |

삭제되지 않은 시크릿의 `deletedAt`과 대상이 없는 감사 이벤트의 `targetId`는 `null`이다. 감사 결과는 `success`, `denied`, `error` 중 하나다. 관리 조회와 가져오기 작업은 검증·조회한 환경 UUID를 `targetId`에 기록하며, 이후 값 조회나 가져오기에 실패해도 해당 환경을 유지한다. 인증이나 Origin 검사에서 거부한 요청은 본문에서 환경 ID를 읽지 않는다.

정책은 다음 필드를 사용한다. 응답에는 서버가 생성한 `id`도 포함한다.

생성할 때는 모든 필드가 필수이며, PATCH에는 변경할 필드를 하나 이상 넣는다. PATCH는 해당 필드만 원자적으로 수정하고 삭제된 정책은 404로 거부한다. `active`를 보내지 않은 수정은 현재 활성 상태를 유지하며, 명시적으로 `active: true`를 보내면 정책을 활성화한다. 관리 화면은 실제로 변경한 필드만 전송하고 변경 없는 저장은 요청 없이 닫는다. `events`는 중복 없는 비어 있지 않은 배열이다.

| 필드 | 형식과 용도 |
|---|---|
| `environmentId` | 읽기를 허용할 앱 환경의 UUID |
| `repositoryId` | GitHub 저장소 숫자 ID를 문자열로 표현 |
| `repositoryOwnerId` | GitHub 소유자 숫자 ID를 문자열로 표현 |
| `branch` | `refs/heads/main` 같은 전체 브랜치 ref |
| `workflow` | `.github/workflows/consume-example.yml` 같은 저장소 내 경로 |
| `events` | `push`, `workflow_dispatch` 중 허용할 이벤트 배열 |
| `githubEnvironment` | GitHub Environment 이름 또는 `null` |
| `active` | 정책 활성 여부를 나타내는 boolean |

## CI 조회

CI Worker의 유일한 기능 경로는 `POST /v1/resolve`다. 관리 API는 제공하지 않는다.

```json
{
  "project": "my-app",
  "environment": "ci",
  "names": ["API_TOKEN", "SIGNING_KEY"]
}
```

`project`는 프로젝트 slug이고 `environment`는 앱 환경 이름이다. 반환되는 각 항목은 `{name,kind,value}`다. 파일 시크릿의 `value`도 원문 문자열이며 CLI가 임시 파일로 만든다. 요청한 항목이 없거나 권한 확인에 실패하면 값을 일부만 반환하지 않는다. 정책은 요청마다 DB에서 읽으므로 비활성화한 정책은 다음 요청부터 거부한다.

## 오류

오류 응답은 `{"error":{"code":"..."}}`이며 요청 본문, 토큰, 내부 예외 메시지를 반환하지 않는다.

변경이 DB에 저장된 뒤 감사 기록 저장이 실패하면 오류 응답이 반환될 수 있다. 네트워크나 서버 오류가 발생한 변경 요청은 최신 메타데이터를 다시 조회한 뒤 재시도한다.

| 상태 | 주요 코드와 대응 |
|---|---|
| 400 | `invalid_input`, `invalid_json`, `invalid_backup`: 입력 형식과 필수 필드를 확인 |
| 401 | `unauthorized`: 토큰을 다시 발급하고 인증 설정 확인 |
| 403 | `forbidden`, `forbidden_origin`: 관리자 또는 CI 정책, 요청 origin 확인 |
| 404 | `not_found`: 경로와 자원, 요청한 시크릿 이름 확인 |
| 409 | `conflict`, `operation_expired`: 이름·버전·순서·대상 충돌 또는 작업 만료 확인 |
| 413 | `chunk_required`: 크기 힌트가 있으면 더 작은 조회나 작업 API 사용. `payload_too_large`, `backup_too_large`: 전체 상한 확인 |
| 415 | `unsupported_media_type`: `application/json` 사용 |
| 500 | 안전한 내부 오류 코드: Worker 설정·DB·키 묶음 확인 |

백업 형식은 [백업 구현](../src/shared/backup.ts)의 `schemaVersion: 1`을 사용한다. 복구 대상 조건과 정책 비활성화 절차는 [운영 문서](operations.md#암호문-백업과-복구)를 따른다.
