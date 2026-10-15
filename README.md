# Personal Secret Manager

개인 프로젝트의 환경변수와 PEM 키를 암호화해 저장하고, 개발 프로그램과 GitHub Actions에 필요한 값만 전달하는 도구다. 관리 Worker, CI 전용 Worker, D1, 웹 관리 화면과 TypeScript CLI로 구성한다.

Cloudflare 무료 플랜의 [관리 화면](https://psm-admin.dnxprbs.workers.dev/)에 배포되어 있다. 본인 Google 계정으로 로그인해 프로젝트와 환경을 만든 다음 시크릿을 등록한다. 실제 로그인·CLI·Actions·백업 복구 검증 결과와 CPU 제한은 [운영 문서](docs/operations.md#운영-검증-결과)에 기록한다.

## 기술 구성

| 구성 | 기술 |
|---|---|
| 서버 | TypeScript, Cloudflare Workers 2개, D1 |
| 암호화·인증 | Web Crypto AES-256-GCM, jose, Access JWT, GitHub OIDC |
| 웹 | HTML, CSS, JavaScript |
| CLI | Node.js 22 이상, macOS/Linux, 로컬 로그인용 cloudflared |
| 검증 | Node test runner, Miniflare의 실제 로컬 D1 |

의존성 버전은 [package-lock.json](package-lock.json)으로 고정한다. 구조와 보안 경계는 [승인된 설계](docs/design.md)를 참고한다.

## 개발 시작

```sh
npm ci
npm run check
npm run deploy:check
```

`check`는 타입 검사, 테스트, CLI 빌드를 실행한다. `deploy:check`는 두 Worker를 번들링하는 dry run이며 실제 배포를 하지 않는다. 자동 테스트는 합성 값과 테스트용 서명 키를 사용한다.

로컬 Worker를 실행하려면 `.dev.vars.example`을 `.dev.vars`로 복사해 비공개 설정을 넣은 다음 로컬 D1에 마이그레이션을 적용한다.

```sh
npx wrangler d1 migrations apply psm --local --config wrangler.admin.jsonc
npm run dev
```

CI Worker는 별도 터미널에서 `npm run dev:ci`로 실행한다. 로컬에서도 JWT 검증을 수행하며 인증을 생략하는 개발 모드는 없다. UI를 실제 계정으로 사용하려면 [Access 설정과 배포 절차](docs/operations.md)를 따른다.

## CLI 사용

빌드 후 `node dist/cli/index.js`로 CLI를 실행한다. `psm` 명령과 [에이전트 스킬](skills/personal-secret-manager/SKILL.md)을 설치하려면 이 저장소에서 다음 명령을 실행한다. 스킬은 기본적으로 `$CODEX_HOME/skills` 또는 `~/.codex/skills`에 설치한다. 다른 에이전트에는 `npm run skill:install -- --target 스킬_디렉터리`로 설치 위치를 지정한다. 내용이 다른 기존 스킬은 덮어쓰지 않는다.

```sh
npm run build
npm link
npm run skill:install
```

CLI를 사용할 프로젝트의 루트에서 관리 주소를 설정하고 로그인한다. 주소는 `$XDG_CONFIG_HOME/psm/config.json` 또는 `~/.config/psm/config.json`에 저장하며 비밀값을 넣지 않는다. 로그인은 프로젝트 설정과 시크릿 매핑 없이도 가능하다.

```sh
psm configure --admin-url https://psm-admin.dnxprbs.workers.dev
psm login
psm init
```

`init`은 저장소·디렉터리 이름을 프로젝트 slug로 사용하고 `dev` 환경을 만든다. 같은 slug의 원격 프로젝트가 있으면 사용자 확인 후 `--confirm`으로 재사용한다. 생성한 `psm.json`에는 서버 주소, 프로젝트·환경 이름과 ID, 시크릿 매핑만 들어간다. 연결한 자원의 ID나 이름이 바뀌면 자동으로 다른 자원을 선택하지 않는다.

이미 제공된 환경변수의 값이나 로컬 파일을 등록하고, 애플리케이션이 사용할 변수 이름에 연결한다.

```sh
psm secret create --name API_TOKEN --from-env PROVIDER_INPUT
psm secret create --name SIGNING_KEY --kind file --file /path/to/private-key.pem
psm bind --name API_TOKEN --to API_TOKEN
psm bind --name SIGNING_KEY --to SIGNING_KEY_FILE
psm run -- npm run dev
```

`PROVIDER_INPUT`은 사용자가 미리 제공한 환경변수 이름이다. 파일과 환경변수 외에 `--stdin` 입력도 지원한다. 비밀값을 명령 인자로 받는 옵션은 제공하지 않는다. 관리 명령의 stdout은 메타데이터 JSON, stderr는 `{error:{code}}` JSON이다. `login_required`이면 다시 로그인하고 `connection_changed`이면 저장한 대상의 변경 여부를 확인한다.

원격 시크릿의 종류를 바꾼 뒤에는 `bind`로 연결을 갱신한다. 기존 종류와 다르면 사용자 확인 후 `--confirm`을 사용하며, 같은 시크릿을 참조하는 기존 변수 매핑의 종류도 함께 갱신한다. 결과의 `updatedDestinations`에 갱신한 변수 이름을 반환한다.

`project`, `environment`, `secret` 명령은 `list`, `create`, `update`, `delete`를 지원한다. 기존 자원 변경·삭제는 사용자 확인 후 `--confirm`을 사용한다. 시크릿 변경·삭제에는 목록에서 확인한 `currentVersionId`를 `--expected-version`으로 전달한다. 버전 충돌은 `conflict`로 실패하며 최신 값을 자동 덮어쓰지 않는다. 이 확인은 CLI 동작 규칙이며 API의 관리자 권한을 제한하지 않는다. 자세한 옵션은 `psm --help`를 따른다.

`.env`는 원문을 출력하지 않는 미리보기 계획을 만든 뒤 적용한다. 계획에는 입력 파일의 해시, 대상 ID와 확인한 버전이 들어간다. 파일이 바뀌면 다시 미리보기하고 기존 버전이 바뀌면 재확인한다.

```sh
plan=$(mktemp)
psm import preview --file .env > "$plan"
psm import apply --file .env --plan "$plan"
rm "$plan"
```

기존 항목은 계획을 검토한 후 `--confirm`을 추가하고, 일부만 적용할 때는 `--names API_TOKEN,OTHER_KEY`를 지정한다. 파일 시크릿을 `.env`로 덮어쓰면 종류도 `env`로 바뀌므로 미리보기의 `kindBefore`와 `kindAfter`를 확인한다. 원본 파일은 자동 삭제하지 않는다. 큰 가져오기는 여러 조각으로 준비하고 원자적으로 적용한다.

기존 [설정 예시](psm.example.json)를 복사한 연결 ID 없는 설정도 계속 지원한다. 이 경우 실행 대상을 직접 지정한다.

```sh
psm login
psm run --project my-app --env dev -- npm run dev
```

일반 값은 자식 프로세스의 환경변수로, 파일 값은 실행별 임시 파일 경로로 전달한다. CLI는 최대 100개 조회를 여러 요청으로 나누며 모든 응답을 검증한 뒤 프로그램을 시작한다. 연결·권한·키 검증에 실패하면 프로그램을 시작하지 않는다. 자식 프로그램의 종료 코드를 반환한다.

GitHub Actions는 `--ci`로 실행하고 `id-token: write` 권한을 부여한다. 저장소·소유자의 숫자 ID, 브랜치, 워크플로와 대상 환경이 일치하는 활성 정책을 먼저 등록해야 한다. PR 이벤트에는 값을 제공하지 않는다.

[수동 실행 예제](.github/workflows/consume-example.yml)는 `my-app` 프로젝트의 `ci` 환경에서 `API_TOKEN`과 `SIGNING_KEY`를 요청한다. [설정 예시](psm.example.json)는 운영 Worker 주소를 사용한다. 예제의 프로젝트·환경·시크릿과 해당 워크플로를 허용하는 정책을 등록한 뒤 실행한다. 예제는 자식 프로세스가 값을 전달받았는지만 확인한다.

## 디렉터리

```text
src/admin/       관리 Worker
src/ci/          읽기 전용 CI Worker
src/shared/      암호화, JWT, D1, 가져오기와 백업
src/cli/         관리 명령, 로그인과 자식 프로세스 주입
skills/          로컬 에이전트용 스킬 원본
public/          관리 화면
migrations/      D1 스키마
tests/           보안, DB, HTTP, CLI, 웹 테스트
scripts/         응답 시간 측정
docs/            설계와 운영 문서
```

## 문서

- [설계와 보안 경계](docs/design.md)
- [로컬 에이전트용 스킬과 관리 CLI 설계](docs/superpowers/specs/2026-10-15-agent-skill-design.md)
- [운영 준비, 키 교체와 복구](docs/operations.md)
- [API 계약](docs/api.md)
- [구현 진행 기록](docs/implementation-progress.md)
