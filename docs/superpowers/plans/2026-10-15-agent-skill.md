# 로컬 에이전트 스킬과 관리 CLI 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 로컬 에이전트가 시크릿 등록과 프로젝트 실행 연결을 수행하도록 관리 CLI와 설치 가능한 스킬을 제공한다.

**Architecture:** 기존 관리 API와 cloudflared 인증을 재사용한다. CLI에 메타데이터 검증·입력·가져오기 모듈과 초기 연결 명령을 추가하고 기존 실행 모듈은 유지한다.

**Tech Stack:** TypeScript, Node.js 표준 라이브러리, 기존 Node test runner와 Miniflare. 새 의존성은 추가하지 않는다.

**Spec:** `docs/superpowers/specs/2026-10-15-agent-skill-design.md`.

## Global Constraints

- 개인 로컬 에이전트가 본인 로그인 세션을 사용하며 서버 권한은 변경하지 않는다.
- 비밀값은 파일·환경변수·stdin으로만 입력하고 관리 JSON 출력에는 메타데이터만 포함한다.
- 기존 시크릿 변경과 모든 삭제는 명시적인 확인을 요구하며 시크릿 변경은 확인한 버전을 사용한다.
- 기존 설정·CI 조회·임시 파일 처리와 자식 종료 코드 전달을 유지한다.
- 이력 복원, 백업 복구, CI 관리, 외부 서비스 발급 자동화는 추가하지 않는다.

## Review Focus

- 미연결 폴더와 같은 slug의 원격 프로젝트는 확인 없이 결합하지 않는다.
- 이름이 바뀌거나 재생성된 원격 자원을 기존 연결 대상으로 취급하지 않는다.
- 서버 미리보기·오류·예상 밖 응답에 비밀값이 있어도 관리 출력에 전달하지 않는다.
- 가져오기 확인 이후 버전이 바뀌면 최신 버전으로 자동 덮어쓰지 않는다.
- 부분 성공이나 불확실한 응답을 자동 재전송·삭제로 처리하지 않는다.

## 파일 구성과 인터페이스

- `src/cli/config.ts`: 기존 설정 검증, 선택적 연결 정보와 비밀값 없는 사용자 공통 주소 설정.
- `src/cli/admin.ts`: `AdminClient`의 인증된 API 호출과 허용 필드만 남긴 메타데이터 검증.
- `src/cli/input.ts`: 제한된 UTF-8 파일·환경변수·stdin 입력.
- `src/cli/manage.ts`: 관리 명령, 초기 연결·바인딩과 승인한 버전의 가져오기 적용.
- `src/cli/index.ts`: 명령 파싱과 JSON 출력. 기존 `client.ts`와 `run.ts`를 계속 사용한다.
- `scripts/install-skill.mjs`: 사용자 스킬 디렉터리에 원본 복사, 충돌 거부와 설치 결과 출력.
- `skills/personal-secret-manager/SKILL.md`: 프로젝트 구축 작업과 확인·실패 처리 규칙.
- `tests/agent-cli.test.ts`, `tests/skill-install.test.ts`: 합성 데이터로 CLI·설치의 실행 결과 검증.

### Task 1: 관리 클라이언트와 비밀값 입력

**Files:** `src/cli/admin.ts`, `src/cli/input.ts`, `tests/agent-cli.test.ts`.

**Interfaces:** `AdminClient(adminUrl: string)`의 `request(method, path, body?)`와 프로젝트·환경·시크릿 메타데이터 목록·생성·변경 메서드. `readSecretInput({file?,fromEnv?,stdin?}, maxBytes)`는 원문 문자열을 반환하고 입력 출처가 여러 개면 거부한다. 오류에는 값을 포함하지 않는다.

- [x] 입력 크기·UTF-8·잘못된 출처, 메타데이터 원문 제거, 안전한 인증·서버 오류와 변경 확인의 실패 테스트를 작성한다.
- [x] `node --import tsx --test tests/agent-cli.test.ts`를 실행해 기능 부재로 실패하는지 확인한다.
- [x] 기존 토큰 조회와 HTTP 읽기를 재사용해 관리 요청을 구현한다. 서버 응답은 허용된 필드만 JSON으로 반환한다.
- [x] 테스트와 `npm run typecheck`를 실행해 통과를 확인한다.

### Task 2: 설정 없는 초기화와 관리 명령

**Files:** `src/cli/config.ts`, `src/cli/manage.ts`, `src/cli/index.ts`, `tests/agent-cli.test.ts`.

**Interfaces:** `Config`는 선택적 기본 프로젝트·환경과 원격 ID를 지원한다. 공통 주소 설정은 XDG 설정 디렉터리 아래 `psm/config.json`에 저장한다. 우선순위는 `--admin-url`, 프로젝트 설정, 사용자 공통 설정이다.

명령은 `configure`, `login`, `init`, `bind`, `project|environment|secret list|create|update|delete`, `import preview|apply`, 기존 `run`으로 구성한다. 관리 작업은 JSON을 출력한다. 변경·삭제는 `--confirm`, 시크릿 변경은 `--expected-version`도 요구한다. 원문 입력은 `--file`, `--from-env`, `--stdin` 중 하나다.

- [x] 새 디렉터리 로그인·초기화, 동일 slug 확인, ID 변경 거부와 재실행, 기존 호출 호환 테스트를 작성하고 실패를 확인한다.
- [x] 초기화 시 프로젝트 루트에서 이름을 도출하고 `dev`를 기본값으로 사용한다. 원격 ID와 이름을 연결 파일에 저장하고 기존 매핑은 보존한다.
- [x] 관리 CRUD와 `bind --name KEY --to VARIABLE`를 구현한다. 바인딩은 원격 종류를 사용하며 기존 매핑 변경을 확인 없이 수행하지 않는다.
- [x] 입력 누락·모호한 옵션은 API 변경 전에 거부한다. `run`은 명시 대상 또는 저장한 기본 대상으로 실행한다.
- [x] 새 CLI 테스트와 기존 `tests/cli.test.ts`를 실행해 통과를 확인한다.

### Task 3: 값 없는 가져오기 미리보기와 버전 고정 적용

**Files:** `src/cli/manage.ts`, `tests/agent-cli.test.ts`.

**Interfaces:** `import preview --file FILE`은 원문 없는 계획 JSON을 반환한다. 계획은 대상 origin·환경 ID, 입력 해시, 항목 이름·버전·종류 변경을 포함한다. `import apply --file FILE --plan PLAN [--confirm]`은 해당 계획만 적용한다. `--names A,B`로 적용할 항목을 선택할 수 있다.

- [x] 원문 없는 미리보기, 파일 시크릿 종류 변경, 입력 파일 변경과 오래된 버전의 적용 거부 테스트를 작성하고 실패를 확인한다.
- [x] 미리보기와 적용을 분리한다. 적용 시 계획의 대상·입력 해시·선택한 버전과 현재 상태를 대조한다. 기존 항목은 확인을 요구한다.
- [x] 작은 가져오기는 기존 apply API를 사용하고 큰 가져오기는 10개·값 64 KiB 제한으로 분할한다. 쓰기를 자동 반복하지 않는다.
- [x] 합성 데이터로 10개 초과 원자적 가져오기와 뒤늦은 충돌을 검증한다.

### Task 4: 스킬·설치·문서와 통합 검증

**Files:** `skills/personal-secret-manager/SKILL.md`, `scripts/install-skill.mjs`, `tests/skill-install.test.ts`, `package.json`, `README.md`, `psm.example.json`.

**Interfaces:** `npm run skill:install -- [--target DIRECTORY]`가 스킬을 복사한다. 대상 기본값은 사용자 Codex 스킬 경로이며 변경된 기존 스킬은 거부하고 같은 내용은 재실행할 수 있다.

- [x] 스킬 없는 작업 시나리오의 실패 지점을 기록한다. 설치 결과·재실행·충돌·대상 밖 쓰기 방지 테스트를 작성하고 실패를 확인한다.
- [x] 등록·연결·검증의 스킬과 CLI `--help`를 작성한다. 스킬은 메타데이터 확인과 필요한 확인 절차를 안내한다.
- [x] 설치 스크립트를 구현하고 새 스킬을 검증한다. 같은 시나리오를 스킬과 함께 독립 에이전트로 수행한다.
- [x] README에 실제 검증한 명령과 기존 기능과의 호환성을 기록한다.
- [x] `npm run check`, `npm run deploy:check`, 문서·차이 검사를 수행한다. 전체 변경을 별도 에이전트가 검토하고 필요한 회귀 테스트와 수정을 수행한다.
- [x] 로컬 CLI와 사용자 공통 스킬을 설치하고 다른 합성 프로젝트에서 등록·주입 흐름을 검증한다. 실제 서비스 변경·키 사용 여부는 결과에 명시한다.

## 검증 결과

- `npm run check`: 타입 검사·빌드 통과, 테스트 132개 통과와 macOS에서 Linux 전용 테스트 1개 생략.
- `npm run deploy:check`: 두 Worker의 dry run 통과. Worker 소스와 서버 권한 모델은 변경하지 않았다.
- 스킬 공식 검증기 통과. 설치 테스트는 새 설치·동일 내용 재설치·충돌 보존·심볼릭 링크 거부를 검증한다.
- 독립 에이전트가 임시 프로젝트에서 합성 JWT·외부 키를 등록하고 실행 연결을 완료했다. 별도 저장소 검사는 값 일치·JWT 형식·주입 성공과 설정 내 비밀값 부재를 확인했다.
- 최종 검토의 환경 변경 시 프로젝트 선택 문제는 회귀 테스트로 재현한 뒤 수정했다. 환경만 바꾸는 초기화는 기존 프로젝트 ID를 확인한다.
- 사용자 CLI와 공통 스킬을 설치하고 비밀값 없는 관리 주소를 설정했다. 실제 관리 API 메타데이터 확인은 `login_required`를 반환했다. 실제 시크릿 등록과 외부 제공자의 키 수락 여부는 검증하지 않았다.
