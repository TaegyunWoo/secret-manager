# 운영 준비와 복구

실제 Cloudflare 배포와 무료 CPU 한도 검증은 아직 수행하지 않았다. 아래는 운영 계정에서 실행할 준비 절차이며, 공개 서비스의 준비 완료를 뜻하지 않는다. 보안 경계와 무료 운영 조건은 [승인된 설계](design.md)를 따른다.

## 계정과 인증 준비

관리용 `psm-admin`과 CI용 `psm-ci` Worker는 주소를 분리하고 같은 D1을 연결한다. 운영 주소는 계정의 `workers.dev` 주소를 사용한다. 관리 주소에는 Cloudflare Access의 self-hosted application을 연결한다.

Access에는 본인 Google 계정의 정확한 이메일을 **Include** 조건으로, Google 로그인 방식을 **Require** 조건으로 설정한다. Google OAuth client를 먼저 등록하고 다른 로그인 방법이나 이메일 OTP를 허용하는 정책을 추가하지 않는다. 애플리케이션 세션은 1시간으로 설정한다. 설정 방법은 [Google 연동](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/)과 [Access 정책](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)을 따른다.

Access application audience와 team issuer를 관리 Worker에 설정한다. `ADMIN_EMAIL`도 동일한 본인 이메일이어야 한다. CI Worker는 GitHub OIDC를 검증하므로 관리 Worker의 Access 정책을 해제해 CI에 개방하지 않는다.

설정 원본은 [관리 Wrangler 설정](../wrangler.admin.jsonc), [CI Wrangler 설정](../wrangler.ci.jsonc), [로컬 Secret 예시](../.dev.vars.example)다. 예시의 계정 값과 키는 사용할 수 있는 운영 설정이 아니다.

| 설정 | 대상 | 용도 |
|---|---|---|
| `DB` binding | 두 Worker | 동일한 D1 데이터베이스 |
| `ASSETS` binding | 관리 Worker | `public/`의 관리 화면 |
| `ACCESS_ISSUER` | 관리 Worker | `https://<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | 관리 Worker | Access application audience |
| `ADMIN_EMAIL` | 관리 Worker | 로그인할 본인 이메일, 정확히 일치해야 함 |
| `CI_AUDIENCE` | CI Worker | CLI의 `ciUrl`과 같은 HTTPS origin |
| `KEYRING_JSON` Secret | 두 Worker | 키 ID를 base64 암호화 키에 연결하는 JSON |
| `ACTIVE_KEY_ID` | 두 Worker | 새 값을 암호화할 키 ID |

preview URL은 비활성 상태를 유지한다. preview를 나중에 켜면 해당 주소도 Access에 등록하고 인증되지 않은 직접 요청이 거부되는지 확인한다. 관리 Worker는 정적 자산을 포함한 모든 요청에서 JWT를 직접 검증한다. 정적 자산의 Worker-first 설정이 필요한 이유는 [Cloudflare 자산 라우팅](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)을 참고한다.

## 개발 PC와 CLI

CLI는 [설정 예시](../psm.example.json)를 읽어 [CLI 코드](../src/cli/index.ts)의 `login`과 `run` 명령을 실행한다. Node.js 22 이상과 macOS 또는 Linux가 필요하다. 로컬 로그인에는 별도로 설치한 `cloudflared`가 PATH에 있어야 한다. [Cloudflare CLI 인증 안내](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/)

`psm login`은 브라우저 로그인 흐름을 시작한다. CLI는 cloudflared의 토큰 출력을 사용자 로그에 전달하지 않는다. `psm run`은 cloudflared에서 토큰을 가져와 필요한 값을 조회한다. cloudflared의 인증 캐시와 시크릿 원문은 별개이며, psm은 원문 캐시를 만들지 않는다.

| 설정 필드 | 필수·기본값 | 용도 |
|---|---|---|
| `adminUrl` | 필수 | 관리 Worker origin |
| `ciUrl` | `--ci`에서 필수 | CI Worker origin, OIDC audience |
| `secrets` | 필수 | 자식 프로세스 환경변수 이름을 원격 시크릿에 연결 |
| `secrets.<변수>.name` | 필수 | 원격 시크릿 이름 |
| `secrets.<변수>.kind` | 필수 | 일반 값 `env`, 임시 파일 경로 `file` |

URL은 HTTPS origin만 허용하고 로컬 테스트의 loopback HTTP는 예외로 허용한다. 경로, 쿼리, 사용자명·비밀번호가 포함된 URL은 거부한다. 설정에 비밀값을 적거나, 같은 환경변수 목적지를 중복 선언하지 않는다.

| 명령 옵션 | 기본값·적용 범위 | 용도 |
|---|---|---|
| `--config FILE` | `psm.json`, 두 명령 | 설정 파일 경로 |
| `--project SLUG` | run 필수 | 프로젝트 slug |
| `--env NAME` | run 필수 | 앱 환경 이름 |
| `--ci` | 꺼짐, run | GitHub runner의 OIDC로 CI Worker 조회 |
| `-- COMMAND ARGS` | run 필수 | 실행할 프로그램과 인자 |
| `--help` | 두 명령 | 사용법 출력 |

파일 시크릿은 실행별 비공개 디렉터리와 파일에 기록한다. 디렉터리 권한은 0700, 파일은 0600이다. 명령은 별도의 POSIX 프로세스 그룹에서 실행한다. SIGINT, SIGTERM, SIGHUP은 그룹 전체에 전달하고, 정상 종료와 처리 가능한 중단에서는 그룹의 실행 중인 프로세스가 모두 끝난 뒤 정리한다. npm 같은 일반 명령 래퍼의 종료만으로 파일을 삭제하지 않는다. 강제 종료 후 남은 파일은 다음 유효한 CLI 실행의 인증·조회 전에 소유권과 관련 프로세스의 종료를 확인한 경우 정리한다. login, 환경변수만 쓰는 실행과 조회 실패도 기존 임시 루트를 확인하며, 없는 루트를 새로 만들지 않는다. 실행 여부를 판단할 수 없는 시작 중단 흔적은 보존한다. 이 경우 관련 자식 프로그램이 모두 끝났는지 확인한 뒤 해당 임시 디렉터리만 직접 정리한다.

임시 루트는 Node의 `os.tmpdir()` 아래 `psm-<UID>`이고, 실행 디렉터리는 `run-<PID>-<임의값>`이다. `.group-<PGID>` 표시는 실행 그룹의 ID를 기록한다. 소유자 PID나 그룹의 프로세스가 살아 있거나 상태 확인 권한이 없으면 자동 삭제하지 않는다. 그룹 리더가 먼저 끝나도 살아 있는 그룹은 보존하고, PID가 재사용되면 보수적으로 보존한다. 이전 `.child-<PID>` 표시만 있는 디렉터리는 후속 프로세스의 종료를 확인할 수 없어 보존한다. 파일 준비 전에 `.preparing`을 만들고, 그룹 ID 기록 전의 시작 구간에는 `.launching`을 함께 남긴다.

macOS와 Linux의 `/bin/ps`로 실행 그룹의 종료를 확인한다. 종료한 좀비 프로세스는 파일을 사용할 수 없으므로 실행 종료 판단에서 제외한다. 상태 조회에 실패하면 파일을 보존한다. Windows와 스스로 새 세션·그룹으로 이탈하는 데몬은 지원 범위 밖이다. 그룹이 종료하지 않으면 CLI도 기다리므로 종료 처리를 무시하는 프로그램은 별도로 종료해야 한다.

HTTP 요청 제한 시간은 30초이며 조회 응답은 최대 40 MiB, GitHub 토큰 응답은 최대 64 KiB다. 조회 응답 제한은 여러 값의 JSON 이스케이프를 포함하기 위한 전송 상한이다. 토큰 발급 요청은 GitHub Actions의 HTTPS 호스트로만 보내고 리디렉션을 따라가지 않는다. 누락된 값·종류 불일치·조회 실패는 프로그램 실행 전에 거부한다.

## 복호화 키

32바이트 암호학적 난수를 base64로 표현해 키를 만든다. 예를 들어 Node의 `crypto.randomBytes(32)`를 사용할 수 있다. 생성한 값은 비밀번호 관리자 등 비공개 저장소에 보관하고, 코드·커밋·작업 로그에 붙여 넣지 않는다.

키 묶음은 `{"key-2026-10":"<32바이트 난수의 base64>"}` 형태의 JSON이다. 두 Worker의 `KEYRING_JSON` Secret에 같은 묶음을 넣고 `ACTIVE_KEY_ID`를 활성 키 ID로 설정한다. 실제 값을 일반 Wrangler 변수나 예시 파일에 넣지 않는다. [Worker Secret 설정](https://developers.cloudflare.com/workers/configuration/secrets/)

키를 교체할 때는 다음 순서를 따른다.

1. 새 키를 기존 묶음에 추가하고 두 Worker에 같은 묶음을 적용한다.
2. `ACTIVE_KEY_ID`를 새 ID로 변경한다. 이후 저장한 버전이 새 키를 사용한다.
3. 기존 버전과 과거 백업을 복호화할 키는 유지한다. 활성 ID 변경은 이전 버전의 재암호화를 수행하지 않는다.
4. Cloudflare 밖에도 키 묶음을 보관한다. DB 백업과 키는 별도 장소에 보관한다.

키를 잃으면 DB나 백업이 있어도 해당 암호문을 복구할 수 없다. 애플리케이션에서 값을 교체하거나 삭제해도 원래 발급 서비스에서 키가 폐기되지는 않는다.

## 배포 절차

다음 명령은 운영 배포 때 사용할 명령이다. 이 구현 작업에서는 실제 계정 생성·마이그레이션·배포를 실행하지 않았다.

1. `npx wrangler login`으로 운영 계정에 로그인한다.
2. `npx wrangler d1 create psm`으로 DB를 만들고 반환된 ID를 두 `wrangler.*.jsonc` 파일의 `database_id`에 같은 값으로 설정한다.
3. 관리 Worker의 Access issuer, audience, 관리자 이메일과 CI Worker의 audience를 실제 배포 origin으로 변경한다. CI audience는 CLI 설정의 `ciUrl`과 일치해야 한다.
4. `npx wrangler d1 migrations apply psm --remote --config wrangler.admin.jsonc`로 스키마를 적용한다.
5. 두 Worker에 Secret을 각각 등록한다. `npx wrangler secret put KEYRING_JSON --config wrangler.admin.jsonc`와 `npx wrangler secret put KEYRING_JSON --config wrangler.ci.jsonc`의 비공개 입력에 동일한 키 묶음을 넣는다.
6. `npm run check`와 `npm run deploy:check`를 통과한 코드로 `npx wrangler deploy --config wrangler.admin.jsonc`와 `npx wrangler deploy --config wrangler.ci.jsonc`를 실행한다.
7. 앞의 Access 정책과 아래 출시 확인 목록을 검증한 뒤 실제 시크릿을 등록한다.

관리 화면 자산과 API 모두 유효한 Access JWT가 없으면 거부되므로, Access 설정을 마치기 전에는 공개 관리 기능을 사용할 수 없다. 잘못된 키·누락된 설정도 인증 우회로 처리하지 않는다.

## 암호문 백업과 복구

관리 화면에서 암호문 백업을 내려받아 비공개로 보관한다. 값은 암호화되어 있지만 프로젝트명, 키 이름, 정책과 감사 기록 같은 메타데이터는 포함된다. 브라우저에서 직접 내려받은 백업과 PEM 파일의 보관·삭제는 사용자가 관리한다.

복구에는 원본 DB를 덮어쓰지 않는 별도의 대상 D1과 백업에서 참조하는 모든 복호화 키가 필요하다. 대상에 스키마를 적용한 다음 두 Worker가 대상 DB를 바라보게 한다. 관리 화면의 복구 기능으로 백업을 올리고 원문 조회 및 CLI 실행을 확인한 뒤 CI 정책을 재검토해 활성화한다.

복구는 프로젝트, 환경, 시크릿, 버전, CI 정책이 없는 대상에서만 허용한다. 인증·복구 시도로 생긴 감사 기록은 남아 있어도 되며 유지한다. 복구 전에 참조 무결성과 암호문 복호화를 검증한다. 복구된 CI 정책은 비활성 상태로 시작한다.

앱 백업은 JSON 전체 1 MiB와 테이블별 1,000행 이내로 제한한다. 한도를 넘으면 내보내기를 거부하며 일부 행만 저장하지 않는다. 백업 규모가 이 한도에 가까워지면 실제 복구까지 검증하고, 규모에 맞는 별도 백업 방식을 준비한다.

D1 Time Travel은 DB 전체 상태 복구이고 개별 키 이력과 별개다. 무료 보존 범위는 [설계의 한도 표](design.md)를 참고한다. Time Travel로 예전 활성 정책까지 되돌릴 수 있으므로, 복구 작업 중에는 CI 접근을 중지하고 정책을 확인한 후 재개한다. [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

## 무료 운영 검증

클라이언트 응답 시간과 Worker CPU 시간은 다른 값이다. `scripts/benchmark.ts`는 네트워크를 포함한 응답 헤더 도착 시간을 측정하며, CPU 한도를 증명하지 않는다. 배포 후 Worker별 Metrics에서 CPU 시간을 확인해야 한다. [Workers Metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)

벤치마크는 다음 환경변수를 읽는다. 값은 설정 파일에 커밋하지 않는다.

| 변수 | 필수 | 용도와 기본값 |
|---|---|---|
| `PSM_BENCH_URL` | 예 | Worker의 HTTPS origin. 로컬 테스트만 loopback HTTP 허용 |
| `PSM_BENCH_TOKEN` | 예 | 해당 Worker용 단기 Access 또는 GitHub 토큰 |
| `PSM_BENCH_MODE` | 아니요 | `admin` 또는 `ci`, 기본 `admin` |
| `PSM_BENCH_PROJECT` | 예 | 측정용 프로젝트 slug |
| `PSM_BENCH_ENVIRONMENT` | 예 | 측정용 환경 이름 |
| `PSM_BENCH_NAMES` | 예 | 쉼표로 구분한 시크릿 이름 |
| `PSM_BENCH_ITERATIONS` | 아니요 | 1-100, 기본 10회 |

설정 후 `node --import tsx scripts/benchmark.ts`를 실행한다. 결과에는 성공·실패 횟수와 시간만 출력한다. 실패 응답 본문과 비밀값은 출력하지 않는다. 측정 후 단기 토큰 환경변수를 해제한다.

출시 전 별도의 테스트 프로젝트에서 일반 값, 실제 사용할 크기의 PEM, 여러 키 조회, 처음 요청과 반복 요청, 키 수정, 백업·복구, Cron 정리를 실행한다. 두 Worker의 CPU와 오류, D1 행 읽기·쓰기 및 저장량을 기록한다. 한도에 들어오지 않으면 크기·처리량과 구현을 조정하고 다시 측정한다.

2026-10-14 확인 기준으로 무료 D1은 Worker 호출당 쿼리 50개와 SQL당 바인딩 100개 제한도 있다. 배치의 각 SQL에도 개별 한도가 적용되므로 HTTP 요청 수만으로 사용량을 판단하지 않는다. [D1 한도](https://developers.cloudflare.com/d1/platform/limits/)

앱은 값 하나를 UTF-8 기준 64 KiB, 한 번에 조회하거나 가져오는 시크릿을 100개, dotenv 가져오기 입력을 128 KiB로 제한한다. Cron은 한 번에 만료된 시크릿 최대 100개와 감사 기록 최대 100개를 정리한다. 이 제한은 CPU 한도 충족을 보장하지 않으므로 실제 계정에서 측정해야 한다.

## 출시 확인 목록

- [ ] 관리 주소와 preview 직접 접근에서 인증 없이 API와 자산을 받지 못한다.
- [ ] 본인 Google 계정만 로그인할 수 있고 세션은 1시간이다.
- [ ] 로컬 CLI의 cloudflared 로그인과 프로그램 실행이 동작한다.
- [ ] 허용된 Actions에서만 조회되며 PR, 다른 브랜치·워크플로, 비활성 정책은 거부된다.
- [ ] 운영 로그와 공개 빌드에 실제 비밀값·토큰이 없다.
- [ ] 암호문 백업을 빈 대상에 복구하고 원문을 확인했다.
- [ ] 두 Worker의 인증·암호화·조회·복구·예약 작업이 무료 한도를 충족한다.

이 목록은 로컬 자동 테스트만으로 완료 처리하지 않는다.
