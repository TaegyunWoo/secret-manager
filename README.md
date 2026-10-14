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

빌드 후 `node dist/cli/index.js`로 CLI를 실행한다. `psm` 명령을 설치하려면 저장소에서 `npm link`를 사용할 수 있다. CLI를 사용할 프로젝트에 `psm.example.json`을 복사해 `psm.json`을 만들고 Worker 주소와 필요한 시크릿 이름·종류를 설정한다. 이 파일에는 비밀값을 넣지 않는다.

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
src/cli/         로그인과 자식 프로세스 주입
public/          관리 화면
migrations/      D1 스키마
tests/           보안, DB, HTTP, CLI, 웹 테스트
scripts/         응답 시간 측정
docs/            설계와 운영 문서
```

## 문서

- [설계와 보안 경계](docs/design.md)
- [운영 준비, 키 교체와 복구](docs/operations.md)
- [API 계약](docs/api.md)
- [구현 진행 기록](docs/implementation-progress.md)
