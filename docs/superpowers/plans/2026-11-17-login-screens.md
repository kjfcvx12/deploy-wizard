# 로그인 화면 (웹 + Expo 앱: Google 로그인 · 토큰 유지 · 내 정보 · 계정 삭제 · 개인 토큰) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 웹과 앱(안드로이드 + 웹 번들)에서 Google 로그인으로 들어와, 로그인 백엔드가 이미 주는 토큰(웹: 메모리의 액세스 + httpOnly 쿠키 리프레시, 앱: 메모리의 액세스 + 보안 저장소의 리프레시)으로 모든 API 를 부르고, 만료되면 조용히 갱신하며, 로그아웃·계정 삭제·MCP 개인 토큰 관리를 화면에서 한다. `AUTH_ENABLED=false`에서는 지금처럼 로그인 없이 동작하되, 소유자가 첫 로그인을 해서 `assign-owner`를 할 수 있는 길이 있다.

**Architecture:** 서버에 공개 `GET /api/auth/config` 하나를 더해 클라이언트가 "로그인이 필요한가 / 할 수 있는가 / 웹 클라이언트 ID"를 안다. 웹은 `shared/ui/session.js`(토큰 보관·단일 갱신·탭 간 동기화, features 를 모름)를 `shared/ui/api.js`의 `request()`가 쓰고, 화면·흐름은 `features/auth/ui/`(로그인·내 정보·계정 삭제·개인 토큰·경로 보호)가 가진다. 앱은 같은 구조를 `app/src/auth/`에 옮겨 적는다(앱은 `app/` 밖을 가져오지 않는다): 안드로이드는 `@react-native-google-signin/google-signin`(네이티브, 개발 빌드 필요), 웹 번들은 Google Identity Services(GIS) — 둘 다 `id_token`만 받아 `POST /api/auth/google`에 보낸다.

**Tech Stack:** React 19 + Vite + react-router 7, `node --test`(`tests/web/*.test.js`, `npm run test:web`); Expo SDK 58 + Expo Router, jest-expo(`cd app && npx jest <파일>`), 새 의존성 `expo-secure-store`, `@react-native-google-signin/google-signin`; FastAPI + pytest(서버 Task 1 만).

**Spec:** `docs/app-web/02-feature-spec.md` A-01~A-05, `docs/app-web/06-screens.md` S-01·S-15·S-16, `docs/app-web/05-flowcharts.md` §5, `docs/app-web/04-api-spec.md` §0·§1, 실제 동작 기준 `docs/api-spec.md` "인증 공통"·"Auth"·"개인 토큰", 백엔드 계획 `docs/superpowers/plans/2026-11-17-login-backend.md`(병합됨), 열린 항목 `docs/worklog/2026-11-17.md`. 실행자는 모두 읽는다.

## Global Constraints

- 브랜치 `feat/login-screens` (`test`에서). 끝나면 `test`에 `--no-ff` 로컬 병합. push·`main`은 소유자의 명시적 허락 후에만.
- **`.env`·`data/wizard.db`를 이 계획의 어느 Task 도 바꾸지 않는다.** `AUTH_ENABLED`를 켜지도 않는다. 이전(migrate)과 켜기는 아래 "출시 순서"대로 소유자가 한다.
- **Google·Expo API 를 지어내지 않는다.** 이 계획의 라이브러리 호출 이름은 표준 흐름을 적은 것이고, 각 Task 에서 설치한 버전의 공식 문서로 다시 확인한다(`verify against the library docs` 표시). 확인한 문서 주소와 버전을 커밋 본문에 한 줄 남긴다. 다르면 문서를 따르고 `Ruling:`으로 남긴다.
- 토큰 규칙: 웹은 **액세스 토큰을 메모리에만** 둔다(`localStorage`·`sessionStorage`·URL·로그 금지). 리프레시는 서버가 굽는 `dw_refresh` 쿠키(httpOnly)라 JS 가 보지 않는다. 앱(안드로이드)은 리프레시 원문을 `expo-secure-store`에만, 액세스는 메모리에만. 앱 웹 번들은 웹과 같이 쿠키(보안 저장소가 웹을 지원하지 않는다). `id_token`·토큰은 화면·콘솔·오류 문장·`AsyncStorage`·접근성 라벨에 넣지 않는다 (개인 토큰 원문만 예외: 발급 직후 한 번 보이는 패널 상태).
- 로그인 플랫폼은 서버 `LOGIN_PLATFORMS`(`web`, `android`)뿐이다. 앱의 플랫폼 이름 변환은 `app/src/auth/platform.js` 한 곳에 두고 `ios`는 지원 안 함(`null`)으로 둔다 — iOS 를 다시 넣을 때 그 한 줄을 바꾼다.
- 서버 응답 문구(`detail`)를 그대로 보인다. 클라이언트 문구는 한국어, 서버 필드 이름 그대로(`u_id`, `a_t_id`, `leftover_ecr_repositories`).
- 화면 규칙 (`docs/conventions.md` "화면", `docs/ui-spec.md` "앱"): 웹은 `features/auth/ui/`에 `PascalCase.jsx`·`camelCase.js`, 서버 호출은 `features/auth/ui/api.js` 한 파일, 색은 `shared/ui/styles.css` 변수만, 글을 자르거나 숨기지 않음(320/375/390/768/1280px 가로 넘침 없음), 한글 어절 줄바꿈. 앱은 내용이 정해진 새 화면(로그인·내 정보·계정 삭제)을 `FitScreen` 위에서 한 화면에, 글은 `app/src/components/Text.js`의 `Text`만, 터치 대상 44pt 이상, 확인은 `app/src/confirm.js`의 기존 방식(취소가 먼저, 안전한 쪽 기본).
- 파괴적 동작(계정 삭제)은 빨간 테두리 + 확인 대화상자, 기본 포커스는 [취소] (S-16). **계정 삭제는 AWS 를 건드리지 않는다**(서버가 보장) — 화면은 그 사실과 남는 것(CloudFormation 스택·GitHub 앱 설치·ECR 저장소)을 분명히 적는다. 화면이 대신 배포를 멈추거나 지우지 않는다(규칙 3): 409 이면 그 배포로 가는 링크만 준다.
- 기존 동작 보존: `AUTH_ENABLED=false`이고 아무도 로그인하지 않았으면 웹·앱의 모든 화면·요청 본문·헤더가 지금과 같다(`Authorization` 헤더 없음). 옛 서버(`/api/auth/config`가 404)도 같은 "로그인 끔"으로 본다.
- 백엔드는 Task 1 만 바꾼다(작은 공개 엔드포인트). 그 밖의 서버 동작이 필요해 보이면 바꾸지 말고 "열린 소유자 결정"에 더한다.
- 테스트: 웹 순수 로직은 `tests/web/*.test.js`(node:test, 필요하면 `import './useAlias.mjs'` 뒤 동적 import, `globalThis.fetch` 가짜 — 기존 `tests/web/api.test.js` 방식), 앱은 jest(네이티브 모듈은 `app/jest.setup.js`에서 목). **네트워크·실제 Google·기기 없음.** 실제 Google/기기 확인은 아래 "소유자 수동 확인"으로만. 테스트 러너는 한 번에 하나.
- 이름: 서버 쪽은 기존 규칙(클래스 Pascal_Snake, 함수 `<계층>_<도메인>_<동작>`, 한 줄 한국어 주석, CRLF 보존). JS 는 기존 파일 관례(camelCase 함수, 한 줄 한국어 주석).
- 소유자 지시: 질문은 `AskUserQuestion`으로만. 실행 중 "열린 소유자 결정"이 필요해지면 기본값으로 진행하고 `Ruling:`으로 남긴다.

## 라이브러리 선택 (앱 안드로이드 로그인)

| | `@react-native-google-signin/google-signin` (추천) | `expo-auth-session` (Google, 브라우저 + PKCE) |
|---|---|---|
| 방식 | 기기의 Google 계정 선택 창(네이티브). `configure({ webClientId })` → `signIn()` → `idToken` | 시스템 브라우저로 OAuth 인가 → 리다이렉트로 복귀 → `id_token` |
| 서버와 맞음 | `aud` = 웹(서버) 클라이언트 ID — 백엔드 `LOGIN_PLATFORMS["android"]`가 이미 받는다 (Ruling 13, 실제 로그인으로 확인 필요) | `aud` = 쓴 클라이언트 ID. 안드로이드 클라이언트를 쓰면 리다이렉트 스킴 제약이 있다 |
| Expo Go | **안 된다** (네이티브 모듈) — 개발 빌드(EAS) 필요 | 될 수도 있으나 Google 이 사용자 지정 스킴 리다이렉트를 제한하는 쪽으로 바뀌어 왔다 (verify against Google OAuth docs) |
| 유지 | Expo 문서가 Google 로그인에 이 라이브러리를 안내하는 것으로 안다 (verify against Expo docs, SDK 58 호환은 `npx expo install`로 확인) | Expo 의 Google 전용 provider 는 권장되지 않는 상태로 안다 (verify) |
| 소유자가 할 일 | Google Cloud: 웹 클라이언트 ID(이미 웹용), 안드로이드 클라이언트 ID(패키지 이름 + **EAS 서명 키의 SHA-1**), EAS 프로젝트·개발 빌드 | Google Cloud 클라이언트 + 리다이렉트 URI 등록, 앱 스킴 |

**정함 (Ruling, 바꾸려면 D-S1):** 네이티브 라이브러리의 무료(Original) API. 무료 판의 `signIn()`이 쓰는 안드로이드 API 가 Google 쪽에서 지원 종료 예정인지(Credential Manager 전환) 설치 때 라이브러리 문서로 확인하고 결과를 `app/README.md`에 적는다. 명세 A-01 의 "앱: 시스템 브라우저(PKCE)" 문구는 Task 11 에서 이 결정으로 고친다. 모든 라이브러리 호출은 `app/src/auth/google.js` 한 파일 뒤에 숨겨 jest 는 그 파일만 목으로 바꾼다 — 라이브러리를 바꿔도 그 파일만 바뀐다.

## 소유자 쪽 선행 작업 (코드 Task 와 별개, 계획 실행을 막지 않음 — 테스트는 모두 가짜)

| # | 할 일 | 필요한 때 |
|---|---|---|
| P1 | Google Cloud OAuth 동의 화면 + **웹 클라이언트 ID**(승인된 JavaScript 원본: `http://localhost:5173`, 앱 웹 번들을 쓰면 `http://localhost:8082`, 나중에 상용 주소) → `.env` `GOOGLE_CLIENT_ID_WEB` | 웹 실제 로그인 (M-2) |
| P2 | `.env`: `AUTH_JWT_KEY`, `BLIND_INDEX_KEY`, `AUTH_ALLOWED_EMAILS=<본인>`; 앱 웹 번들을 쓰면 `CORS_ORIGINS`에 `http://localhost:8082` | 첫 로그인 전 |
| P3 | EAS: 프로젝트 만들기(`extra.eas.projectId` — 푸시도 이것이 없어 `no_project`), 안드로이드 패키지 이름 확정(D6), **개발 빌드**, 그 빌드 서명 키의 SHA-1 로 **안드로이드 OAuth 클라이언트** 등록 → `.env` `GOOGLE_CLIENT_ID_ANDROID` | 앱 실제 로그인 (M-5) |
| P4 | 이전 실행 (README "로그인 이전"): 서버 끄기 → `backup` → `status` → `encrypt --yes` | 첫 로그인 전 (아래 출시 순서) |

## 출시 순서 (이 계획이 만드는 화면으로 `assign-owner`를 가능하게 하는 길)

1. 이 계획을 `test`에 병합. `AUTH_ENABLED=false` 그대로 → 웹·앱이 지금과 같다(M-1).
2. P2·P1 → P4(이전). 서버 켜기(아직 끔 모드).
3. `GET /api/auth/config`가 `login_available: true` → 웹 상단에 **`로그인`** 링크가 보인다(끔 모드에서도). 소유자가 `/login`에서 Google 로그인 → 사용자 행이 생긴다(M-2).
4. `python scripts/migrate_login.py assign-owner --email <본인> --yes` → `status`에서 주인 없는 행 0.
5. 웹 `내 정보` → `개인 토큰`에서 MCP 토큰 발급 → MCP 등록의 `WIZARD_API_TOKEN` (끔 모드에서도 미리 넣어 둘 수 있다 — 서버가 무시한다)(M-3).
6. (선택) 앱 개발 빌드로 로그인·푸시 다시 등록 확인(M-5·M-6).
7. 켜기 전 관문: 소유자 혼자 쓰면 `docs/worklog/2026-11-17.md` OPEN 3·4(GitHub 설치 소유 증명, AWS 계정 없는 배포의 서버 세션 대체)는 그대로 둬도 되고, **남이 쓰기 전에는 반드시** 정한다.
8. `assign-owner --yes` 한 번 더(멱등) → `.env` `AUTH_ENABLED=true` → 서버 재시작 → 웹 새로고침이 `/login`으로 가지 않고 조용히 갱신되는지, MCP 가 PAT 로 동작하는지 확인(M-4).
9. 되돌리기: `AUTH_ENABLED=false`로 재시작 (데이터 변화 없음, 화면은 자동으로 로그인 끔으로 돌아간다).

## Review Focus

1. **여러 탭·창의 동시 갱신**: 웹 탭 두 개(또는 메인 창 + `/guide` 안내 창)가 거의 동시에 쿠키로 `refresh`를 부르면, 늦게 온 쪽이 이미 회전된 토큰을 써서 **계열 전체가 폐기**(서버의 재사용 감지)되어 두 탭이 모두 로그아웃될 수 있다 → 탭 간 잠금(`navigator.locks`) + 결과 공유(`BroadcastChannel`)로 한 번만 부르는가 → Task 2.
2. **401 무한 반복·잘못된 재시도**: 갱신 자체의 401, `/api/auth/google`·`/refresh`·`/logout`·`/config`의 401 은 갱신을 부르지 않는가, 재시도는 요청마다 한 번뿐인가, 동시에 401 을 받은 요청 다섯 개가 갱신 한 번을 기다렸다가 모두 다시 가는가, 오프라인(상태 0)은 로그아웃시키지 않는가 → Task 2, 7.
3. **끔 모드 보존과 옛 서버**: 로그인하지 않은 끔 모드에서 요청에 `Authorization`이 없고, 화면이 로그인으로 보내지 않으며, `/api/auth/config` 404(옛 서버)·5xx·네트워크 실패가 각각 "끔"·"오류 + 다시 시도"로 갈리는가; 서버가 도중에 켜짐으로 바뀌면(401) 설정을 다시 읽고 로그인으로 가는가 → Task 3, 9.
4. **다른 사용자로 바뀔 때 남는 것**: 로그아웃 → 다른 계정 로그인 뒤 이전 사용자의 고른 블록(`dw-picked-block`), 푸시 기기 번호(`dw-push-device`), 화면 상태가 남지 않는가; 앱 로그아웃이 기기 등록 해제를 **토큰이 살아 있을 때 먼저** 하는가 → Task 5, 10.
5. **열린 리다이렉트·토큰 노출**: `/login?next=//evil.example`·`https://…`·`/\evil` 이 `/`로 바뀌는가, 개인 토큰 원문이 패널을 닫거나 화면을 떠나면 상태에서 사라지고 목록·저장소·URL 에 없는가, 앱 보안 저장소 쓰기가 실패해도 원문이 `AsyncStorage`로 새지 않는가 → Task 3, 6, 7.

---

### Task 1 (백엔드 변경): 공개 `GET /api/auth/config`

**Files:**
- Modify: `features/auth/scheme.py`, `features/auth/services.py`(`PUBLIC_PATHS`에 `/api/auth/config`), `features/auth/router.py`, `docs/api-spec.md`(Auth 표 + "인증 공통"의 공개 경로 목록)
- Test: `tests/test_auth_config.py`

**Interfaces:**
- Produces (scheme): `Auth_Config_Read(auth_required:bool, login_available:bool, platforms:list[str], google_client_id_web:str|None, pat_default_days:int, pat_max_days:int)`.
- Produces (`Auth_Service`): `services_auth_config() -> Auth_Config_Read` — `auth_required = settings.auth_enabled`; `platforms` = `LOGIN_PLATFORMS` 중 `services_auth_client_ids(p)`가 비어 있지 않은 것(정렬); `login_available = bool(platforms) and bool(settings.auth_jwt_key)`; `google_client_id_web` = 설정값(공백 제거, 없으면 `None`) — 클라이언트 ID 는 공개 값이다; PAT 일수는 설정값. **비밀(`AUTH_JWT_KEY`·`SECRET_KEY`·허용 이메일 목록 등)은 싣지 않는다.**
- Produces (router): `GET /api/auth/config` → `Auth_Config_Read`, 의존성 없음(공개). DB 를 열지 않는다.

- [ ] **Step 1: 실패하는 테스트**
  - `test_auth_config_off_mode` — 기본 설정: 200, `auth_required is False`, 키 집합이 정확히 위 6개.
  - `test_auth_config_on_mode_with_ids` — `auth_enabled=True`, `auth_jwt_key="k"`, 웹·안드로이드 ID 설정 → `auth_required True`, `login_available True`, `platforms == ["android","web"]`, `google_client_id_web == 설정값`.
  - `test_auth_config_login_unavailable` (parametrize) — ID 없음 → `platforms == []`·`login_available False`; ID 는 있고 `auth_jwt_key=None` → `login_available False`.
  - `test_auth_config_no_secrets` — 응답 본문 문자열에 `auth_jwt_key`·`secret_key`·`blind_index_key`·허용 이메일 값이 없다.
  - `test_auth_config_public_on_mode` — `auth_enabled=True`에서 `Authorization` 없이 200 (구조 테스트 `test_auth_every_route_requires_user`도 `PUBLIC_PATHS` 덕에 통과).
- [ ] **Step 2:** `.venv/Scripts/python.exe -m pytest tests/test_auth_config.py -q` → 실패.
- [ ] **Step 3:** 구현 + `docs/api-spec.md`.
- [ ] **Step 4:** `.venv/Scripts/python.exe -m pytest tests/test_auth_config.py tests/test_auth_current_user.py tests/test_auth_api.py -q` 통과.
- [ ] **Step 5:** 커밋 `feat(auth): 공개 로그인 설정 조회 GET /api/auth/config`.

### Task 2: 웹 세션 핵심 — 토큰 보관·단일 갱신·탭 동기화·`request()` 연결

**Files:**
- Create: `shared/ui/session.js`, `shared/ui/tabSync.js`, `tests/web/session.test.js`
- Modify: `shared/ui/api.js`, `tests/web/api.test.js`

**Interfaces:**
- Produces (`shared/ui/tabSync.js`, 순수 + 주입): `createTabSync({ locks, channel })` → `{ runExclusive(name:string, fn:()=>Promise<T>) -> Promise<T>, post(message:object) -> void, onMessage(fn) -> () => void }`. `locks`가 없으면(`navigator.locks` 미지원) `runExclusive`는 그냥 `fn()`; `channel`이 없으면 `post`·`onMessage`는 아무것도 안 한다. 기본 인스턴스 `tabSync`는 `navigator.locks`와 `new BroadcastChannel('dw-auth')`(있을 때만)로 만든다.
- Produces (`shared/ui/session.js`, features 를 import 하지 않는다):
  - `getAccessToken() -> string|null`, `getSessionUser() -> object|null`, `getSessionStatus() -> 'unknown'|'signed_in'|'signed_out'`.
  - `setSession(token)` — `Auth_Token`에서 `access_token`·`user`·`expires_in`만 보관(`refresh_token`은 무시), 상태 `signed_in`, 구독자 알림, 다른 탭에 `{type:'session', access_token, user, expires_in, at}` 보냄.
  - `clearSession(reason:'logout'|'expired'|'deleted')` — 비우고 `signed_out`, 구독자에 `reason` 전달, 다른 탭에 `{type:'signed_out', reason}`. 다른 탭에서 온 메시지로 바뀔 때는 다시 보내지 않는다.
  - `subscribeSession(fn:(state:{status, user, reason?})=>void) -> unsubscribe`.
  - `setRefresher(fn:()=>Promise<Auth_Token>)` — `features/auth/ui`가 등록한다(이 파일은 엔드포인트를 모른다).
  - `refreshSession() -> Promise<boolean>` — **탭 안 단일 비행**(진행 중이면 같은 Promise), 그 안에서 `tabSync.runExclusive('dw-auth-refresh', …)`; 잠금을 얻은 뒤 시작 이후에 다른 탭이 새 세션을 보냈으면 네트워크 없이 `true`. 갱신기 결과로 `setSession`. 갱신기가 상태 401·403 으로 실패하면 `clearSession('expired')` 후 `false`; 상태 0(오프라인)·5xx 는 세션을 지우지 않고 그 오류를 던진다. 갱신기가 없으면 `false`.
  - `markBooted(status)` — 첫 확인 전 `unknown`을 끝낸다(Task 3 이 부른다).
- Produces (`shared/ui/api.js`): `request(path, options)` 시그니처 유지. 변경: (a) 헤더는 `{ 'Content-Type': 'application/json', ...options.headers }`로 **병합**(지금은 `...options`가 `headers`를 덮을 수 있다), 토큰이 있으면 `Authorization: Bearer …`; (b) 응답 401 이고 경로가 `AUTH_NO_RETRY_PATHS`(`/api/auth/google`, `/api/auth/refresh`, `/api/auth/logout`, `/api/auth/config`) 밖이고 이 요청이 아직 재시도 전이면 `refreshSession()` → `true`면 **한 번만** 다시 보내고, `false`면 원래 401 오류를 던진다; (c) 옵션 `auth:false`면 헤더·재시도 없음. `export const AUTH_NO_RETRY_PATHS`.

- [ ] **Step 1: 실패하는 테스트** (`tests/web/session.test.js`, 매 테스트 전 세션 초기화용 `resetSessionForTest()`를 `session.js`가 export; 가짜 `locks`는 이름별 Promise 사슬, 가짜 `channel`은 두 인스턴스를 잇는 메모리 버스)
  - `refresh single flight` — 갱신기가 50ms 뒤 끝나는 가짜일 때 `refreshSession()` 5번 동시 → 갱신기 1번, 모두 `true`, `getAccessToken() === 'A2'`.
  - `refresh 401 clears session` — 갱신기가 `{status:401}` 오류 → `false`, 상태 `signed_out`, 구독자가 `reason === 'expired'`를 받는다.
  - `refresh offline keeps session` — 갱신기가 `{status:0}` → 던지고, 기존 토큰 유지.
  - `two tabs refresh once` — 탭 A·B(각자 `createTabSync`로 같은 가짜 잠금·버스 공유) 동시에 `refreshSession()` → 갱신기 호출 합계 1, B 도 새 토큰을 갖는다.
  - `signed_out broadcast` — A 의 `clearSession('logout')` → B 상태 `signed_out`, B 는 다시 보내지 않는다(버스 메시지 수 1).
  - `setSession ignores refresh_token` — `refresh_token:'dwr_x'`를 줘도 어떤 getter·구독 상태·버스 메시지에도 `dwr_x`가 없다.
  - `tabSync without locks/channel` — 둘 다 `undefined`여도 `runExclusive`가 `fn` 결과를 돌려주고 `post`가 던지지 않는다.
  - (`tests/web/api.test.js`에 추가) `request: no token no Authorization header` (끔 모드 보존), `request: bearer attached and headers merged` (`options.headers`의 `X-Test` 유지, `Content-Type` 유지), `request: 401 refreshes then retries once` (첫 401 → 갱신 → 두 번째 200, fetch 2번, 두 번째 헤더에 새 토큰), `request: 401 after retry is thrown` (재시도도 401 → 던짐, 갱신 1번), `request: auth paths never refresh` (네 경로 각각 401 → 갱신 0번), `request: five concurrent 401 share one refresh`.
- [ ] **Step 2:** `npm run test:web` → 새 테스트 실패.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `npm run test:web` 전부 통과(기존 78개 포함), `npm run build` 성공.
- [ ] **Step 5:** 커밋 `feat(web): 세션 보관·단일 갱신·탭 동기화와 API 401 재시도`.

### Task 3: 웹 인증 흐름 — API·시작 확인·경로 보호·순수 로직

**Files:**
- Create: `features/auth/ui/api.js`, `features/auth/ui/authLogic.js`, `features/auth/ui/userData.js`, `features/auth/ui/AuthProvider.jsx`, `features/auth/ui/RequireAuth.jsx`, `tests/web/authLogic.test.js`
- Modify: `shared/ui/main.jsx`(`AuthProvider`로 감싼다), `shared/ui/App.jsx`(`Shell`과 `/guide/:kind`를 `RequireAuth`로, `/login` 경로 자리 — 화면은 Task 4), `features/accounts/ui/pickedBlock.js`(키 `PICKED_BLOCK_KEY` export 만)

**Interfaces:**
- Consumes: Task 1 `GET /api/auth/config`; Task 2 `session.js` 전부, `request`.
- Produces (`api.js`, 라우터와 1:1): `authApi = { getConfig, loginGoogle(id_token) /* platform:'web' */, refresh /* 본문 없음, 쿠키 */, logout, getMe, deleteMe /* body {confirm:true} */, listTokens, createToken({name, expires_in_days}), revokeToken(a_t_id) }`. `getConfig`·`loginGoogle`·`refresh`·`logout`은 `auth:false`.
- Produces (`authLogic.js`, 순수):
  - `normalizeConfig(raw) -> {auth_required, login_available, platforms, google_client_id_web, pat_default_days, pat_max_days}` — 모르는 키 무시, 타입이 틀리면 안전한 기본(`false`/`[]`/`null`/30/90). `CONFIG_OFF` 상수 = 옛 서버(404)용 끔 설정.
  - `routeDecision({ config, configError, status, path }) -> 'loading'|'error'|'allow'|'login'` — 설정 전·`status==='unknown'`이면 `loading`; 설정 실패면 `error`; `auth_required`가 false 면 `allow`(로그인했든 아니든); true 이고 `signed_in`이면 `allow`, 아니면 `login`. `/login` 경로 자체는 언제나 `allow`.
  - `safeNext(raw) -> string` — `/`로 시작하고 `//`·`/\`로 시작하지 않으며 `/login`이 아닌 경로만, 아니면 `'/'`.
  - `loginErrorText(error) -> string` — 서버 `detail`이 있으면 그대로(403 허용 목록·401·503 문구), 상태 0 은 `NETWORK_ERROR_TEXT`, 그 밖은 `로그인하지 못했습니다. 잠시 뒤 다시 시도해 주세요`.
- Produces (`userData.js`): `HAD_SESSION_KEY = 'dw-had-session'`, `clearUserScopedStorage(storage = window.localStorage) -> void` — `PICKED_BLOCK_KEY`·`HAD_SESSION_KEY` 삭제, 저장소가 없거나 막혀도 던지지 않는다.
- Produces (`AuthProvider.jsx`): 컨텍스트 `useAuth() -> { config, configError, status, user, retryConfig(), signInWithCredential(id_token), signOut(), forgetAfterDelete() }`. 시작: `getConfig()`(404 → `CONFIG_OFF`, 그 밖의 실패 → `configError`) → 로그인이 필요하거나 `localStorage` 힌트 `dw-had-session === '1'`(값은 표시뿐, 비밀 아님)이면 `refreshSession()`, 아니면 바로 `signed_out` → `markBooted`. `setRefresher(() => authApi.refresh())`를 한 번 등록. `signInWithCredential`: `loginGoogle` → `setSession` → 힌트 저장 → `getMe()`는 부르지 않는다(응답에 `user`가 있다). `signOut`: `logout()`(실패해도 계속) → `clearSession('logout')` → `clearUserScopedStorage()`. 구독으로 `signed_out` + `reason==='expired'`를 받으면 설정을 다시 읽는다(서버가 도중에 켜졌을 수 있다).
- Produces (`RequireAuth.jsx`): `routeDecision` 결과로 `loading` → `불러오는 중…`, `error` → `서버에 연결할 수 없습니다` + `[다시 시도]`(`retryConfig`), `login` → `<Navigate to={'/login?next=' + encodeURIComponent(현재 경로)} replace />`, `allow` → 자식.

- [ ] **Step 1: 실패하는 테스트** (`tests/web/authLogic.test.js`)
  - `normalizeConfig`: 정상 값 통과, `{}`·`null`·`auth_required:"yes"`→ 끔 기본, `CONFIG_OFF.auth_required === false`.
  - `routeDecision` 표: (설정 없음)→loading, (configError)→error, (끔·signed_out)→allow, (끔·signed_in)→allow, (켬·unknown)→loading, (켬·signed_out)→login, (켬·signed_in)→allow, (켬·signed_out·path `/login`)→allow.
  - `safeNext`: `/deploys/3`→그대로, `/accounts?connected=github`→그대로, `''`·`null`·`//evil.example`·`/\evil`·`https://evil.example`·`javascript:alert(1)`·`/login`→`/`.
  - `loginErrorText`: 403 `로그인이 허용된 계정이 아닙니다`→그대로, 상태 0→네트워크 문구, `detail` 없는 500→기본 문구.
  - `clearUserScopedStorage`: 가짜 저장소에서 `dw-picked-block`·`dw-had-session`만 지우고 다른 키는 남긴다, `removeItem`이 던져도·`storage`가 `undefined`여도 던지지 않는다.
  - `authApi` 본문 (기존 `api.test.js` 방식): `loginGoogle('t')`는 `POST /api/auth/google` `{id_token:'t', platform:'web'}`, `deleteMe()`는 `DELETE /api/me` `{confirm:true}`, `refresh()`는 본문 없음, 네 공개 호출엔 `Authorization` 없음.
- [ ] **Step 2:** `npm run test:web` → 실패. **Step 3:** 구현. **Step 4:** `npm run test:web`, `npm run build` 통과.
- [ ] **Step 5:** 커밋 `feat(web): 로그인 설정 확인·시작 갱신·경로 보호`.

### Task 4: 웹 로그인 화면 (S-01, GIS 버튼)

**Files:**
- Create: `features/auth/ui/googleIdentity.js`, `features/auth/ui/LoginPage.jsx`, `tests/web/googleIdentity.test.js`
- Modify: `shared/ui/App.jsx`(`/login` → `LoginPage`, 상단 바 없이 — `/guide`와 같은 자리), `shared/ui/styles.css`(로그인 카드, 변수만)

**Interfaces:**
- Consumes: Task 3 `useAuth`, `safeNext`, `loginErrorText`.
- Produces (`googleIdentity.js`, 문서 객체 주입으로 시험 가능): `GIS_SRC = 'https://accounts.google.com/gsi/client'`; `loadGoogleIdentity(doc = document, timeoutMs = 10000) -> Promise<object>` — 같은 문서에서 여러 번 불러도 `<script>` 하나, 로드 후 `window.google.accounts.id`를 돌려준다, 실패·시간 초과는 `Google 로그인 버튼을 불러오지 못했습니다. 새로고침해 주세요`; `renderGoogleButton(gisId, element, { client_id, onCredential })` — 표준 GIS 흐름 `initialize({ client_id, callback })` → `renderButton(element, { type:'standard', text:'signin_with', locale:'ko' })`, 콜백의 `response.credential`(= `id_token`)만 `onCredential`에 넘긴다. **옵션 이름·FedCM 관련 기본값·One Tap 사용 여부는 GIS 문서로 확인한다 (verify against the library docs).** One Tap 자동 띄우기는 쓰지 않는다(사용자가 버튼을 누를 때만).
- Produces (`LoginPage.jsx`): 제목 `AWS 자동 배포 마법사`, 한 줄 설명 `Google 계정으로 로그인합니다. 허용된 계정만 들어올 수 있습니다.`, GIS 버튼 자리, 진행 중 `로그인하는 중…`(버튼 비활성), 오류 자리(`role="alert"`, `loginErrorText`). 성공하면 `navigate(safeNext(searchParams.get('next')), { replace:true })`. `login_available`이 false 면 버튼 대신 `이 서버는 아직 로그인이 설정되지 않았습니다 (GOOGLE_CLIENT_ID_WEB·AUTH_JWT_KEY).` 끔 모드면 위에 `로그인하지 않아도 쓸 수 있습니다. 로그인하면 내 정보와 개인 토큰을 관리할 수 있습니다.` + `[로그인하지 않고 계속]`(→ `/`). 이미 `signed_in`이면 `next`로 바로 보낸다.

- [ ] **Step 1: 실패하는 테스트** (`googleIdentity.test.js`, 가짜 `doc`: `createElement`·`head.appendChild`·`querySelector`를 기록하는 객체, 스크립트의 `onload`/`onerror`를 테스트가 호출)
  - `loads script once` — 두 번 호출 → `appendChild` 1번, `src === GIS_SRC`, `async === true`; `onload` 후 둘 다 같은 객체로 풀린다.
  - `script error rejects with Korean text`, `timeout rejects` (`timeoutMs=10`).
  - `renderGoogleButton passes only credential` — 가짜 `gisId.initialize`가 받은 `callback({credential:'idt', select_by:'btn'})` → `onCredential('idt')` 한 번, `client_id` 전달 확인, `renderButton`이 같은 요소로 불림.
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현. **Step 4:** `npm run test:web`, `npm run build`.
- [ ] **Step 5:** 커밋 `feat(web): Google 로그인 화면`.

### Task 5: 웹 내 정보 (S-15) — 계정 정보·로그아웃·계정 삭제

**Files:**
- Create: `features/auth/ui/MePage.jsx`, `features/auth/ui/DeleteAccountCard.jsx`, `features/auth/ui/AuthNavLink.jsx`
- Modify: `features/auth/ui/authLogic.js`, `tests/web/authLogic.test.js`, `shared/ui/App.jsx`(`/me` 경로, 상단 바에 `AuthNavLink`), `shared/ui/styles.css`

**Interfaces:**
- Consumes: Task 3 `useAuth`, `authApi.deleteMe`.
- Produces (`authLogic.js`):
  - `parseLiveDeploys(detail:string) -> {message:string, items:{d_id:number, label:string}[]}` — 서버 409 문구 `먼저 멈추거나 삭제해야 하는 서비스가 있습니다: #3 my-app, #5 other`를 나눈다. 형식이 다르면 `items: []`, `message`는 원문.
  - `deleteResultView(response) -> {message:string, leftovers:string[]}` — `leftover_ecr_repositories`가 배열이 아니면 `[]`.
- Produces (`AuthNavLink.jsx`): 상단 바의 링크 하나 — `signed_in`이면 `내 정보`(→ `/me`), 아니고 `login_available`이면 `로그인`(→ `/login?next=현재 경로`), 둘 다 아니면 아무것도 안 그림(끔 모드 + 로그인 불가 = 지금 화면 그대로).
- Produces (`MePage.jsx`, `/me`): 로그인 안 했으면 `/login?next=/me`로. 사진(`picture_url`이 있을 때만, `alt=""` + 이름 텍스트 옆), 이름(없으면 표시 안 함), 이메일, `알림 설정` 링크(→ `/notification-settings`), `개인 토큰` 영역(Task 6 자리), `[로그아웃]`(→ `signOut()` → `/login`, 끔 모드면 `/`), 맨 아래 `DeleteAccountCard`.
- Produces (`DeleteAccountCard.jsx`): 빨간 테두리 카드. 설명 `계정과 이 마법사의 기록(배포 기록·연결·알림)을 지웁니다. AWS 의 서비스·CloudFormation 스택·ECR 이미지와 GitHub 앱 설치는 지우지 않습니다. 되돌릴 수 없습니다.` → `[계정 삭제]` → 확인 대화상자(제목 `계정을 삭제할까요?`, 같은 설명, `[취소]` 기본 포커스 / `[삭제]` 빨강) → `deleteMe()`. 409 → `parseLiveDeploys` 목록을 `#3 my-app` 링크(→ `/deploys/3`)로 보이고 `먼저 이 서비스들을 멈추거나 삭제한 뒤 다시 시도하세요.`; 503·500·403 → 서버 문구 그대로. 200 → 세션을 `clearSession('deleted')`, 사용자별 저장값 정리, **결과 화면**(`message` 그대로 + `leftovers`가 있으면 저장소 이름 목록(고정폭, 선택 가능) + `AWS 콘솔의 ECR 에서 직접 지워 주세요. 요금이 나갈 수 있습니다.`) + `[처음으로]`. 결과 화면은 세션이 없어도 보여야 하므로 `/login`으로 바로 보내지 않는다(`forgetAfterDelete`가 결과 표시 뒤 상태만 바꾼다).

- [ ] **Step 1: 실패하는 테스트**: `parseLiveDeploys`(서버 예시 문구 → 2개 항목 `{3,'my-app'}`·`{5,'other'}`, 이름에 공백·쉼표 없는 레포 주소 `#7 https://github.com/a/b` → label 주소, 형식 밖 문구 → `items:[]`), `deleteResultView`(목록 있음/없음/`null`).
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현 (확인 대화상자는 기존 웹 확인 방식 — `features/deploys/ui`의 삭제 확인을 찾아 같은 컴포넌트/패턴을 쓴다). **Step 4:** `npm run test:web`, `npm run build`.
- [ ] **Step 5:** 커밋 `feat(web): 내 정보·로그아웃·계정 삭제`.

### Task 6: 웹 개인 토큰 관리 (MCP)

**Files:**
- Create: `features/auth/ui/TokensCard.jsx`
- Modify: `features/auth/ui/authLogic.js`, `tests/web/authLogic.test.js`, `features/auth/ui/MePage.jsx`

**Interfaces:**
- Consumes: Task 3 `authApi.listTokens/createToken/revokeToken`, `config.pat_default_days/pat_max_days`.
- Produces (`authLogic.js`): `validateTokenForm({ name, days }, { pat_default_days, pat_max_days }) -> { body:object|null, error:string|null }` — 이름 앞뒤 공백 제거 후 1~50자(아니면 `이름은 1~50자로 적어 주세요`), 기간 빈 칸은 `expires_in_days` 없음(서버 기본), 정수 1~`pat_max_days`(아니면 `기간은 1~{max}일입니다`); `tokenExpiryText(expires_at, now) -> string` — `2026년 12월 17일까지 (30일 남음)`, 지남 → `만료됨`, `null` → `만료 없음`(서버 시각은 `shared/ui/time.js`의 UTC 해석을 따른다); `mcpEnvLine(token) -> string` = `WIZARD_API_TOKEN=<token>`.
- Produces (`TokensCard.jsx`): 제목 `개인 토큰 (MCP)`, 설명 `Claude Code 같은 MCP 클라이언트가 이 계정으로 마법사를 쓰게 하는 토큰입니다. 원문은 만들 때 한 번만 보입니다.` 목록(이름, `…{last4}`, 만료 문구, 마지막 사용 `last_used_at` 또는 `아직 쓰지 않음`, `[폐기]` → 확인 `이 토큰을 쓰는 MCP 연결이 바로 끊깁니다.` → `revokeToken`, 404 는 목록 새로 읽기). 만들기 폼(이름 기본 `mcp`, 기간 placeholder `{pat_default_days}`, 힌트 `최대 {pat_max_days}일`) → 발급 패널: 원문(고정폭, 선택 가능), `[복사]`(`navigator.clipboard`, 실패 시 `직접 선택해 복사해 주세요`), `mcpEnvLine` 한 줄과 `[복사]`, 안내 `이 창을 닫으면 다시 볼 수 없습니다.`, `[닫았습니다]` → 원문 상태를 `null`로. 컴포넌트 언마운트 때도 `null`. 원문은 URL·저장소·`console`·`aria-label`에 넣지 않는다. 끔 모드에서도 로그인했으면 쓸 수 있다(서버가 `/api/auth/tokens`에 로그인 사용자를 요구한다).

- [ ] **Step 1: 실패하는 테스트**: `validateTokenForm` 표(`' mcp '`→`{name:'mcp'}` 기간 없음, `''`·51자→이름 오류, `'0'`·`'91'`(max 90)·`'1.5'`·`'abc'`→기간 오류, `'90'`→`expires_in_days:90`), `tokenExpiryText`(남음/지남/`null`, 고정 `now`), `mcpEnvLine`.
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현. **Step 4:** `npm run test:web`, `npm run build`.
- [ ] **Step 5:** 커밋 `feat(web): MCP 개인 토큰 만들기·목록·폐기`.

### Task 7: 앱 세션 핵심 — 보안 저장소·단일 갱신·회전·`request()` 연결

**Files:**
- Create: `app/src/auth/platform.js`, `app/src/auth/tokenStore.js`, `app/src/auth/tokenStore.web.js`, `app/src/auth/session.js`, `app/src/__tests__/authSession.test.js`
- Modify: `app/package.json`(`npx expo install expo-secure-store` — 버전은 SDK 58 이 고르는 것), `app/jest.setup.js`(`expo-secure-store` 메모리 목: `getItemAsync`·`setItemAsync`·`deleteItemAsync`), `app/src/api.js`, `app/src/__tests__/api.test.js`

**Interfaces:**
- Produces (`platform.js`): `loginPlatform(os = Platform.OS) -> 'web'|'android'|null` — `web`→`web`, `android`→`android`, 그 밖(`ios` 포함)→`null`. 주석: `// iOS 추가 시: ios: 'ios' 한 줄 (서버 LOGIN_PLATFORMS 와 같이)`.
- Produces (`tokenStore.js`, 네이티브): `readRefreshToken() -> Promise<string|null>`, `writeRefreshToken(raw) -> Promise<boolean>`(실패하면 `false`, 던지지 않음), `clearRefreshToken() -> Promise<void>`; 키 `dw-refresh`; `expo-secure-store`만 쓴다 (API 이름은 verify against the library docs). `tokenStore.web.js`: 셋 다 아무것도 저장하지 않는다(`null`/`false`/없음) — 웹은 쿠키.
- Produces (`session.js`): 웹 `shared/ui/session.js`와 같은 이름(`getAccessToken`, `getSessionUser`, `getSessionStatus`, `setSession`, `clearSession`, `subscribeSession`, `setRefresher`, `refreshSession`, `markBooted`, `resetSessionForTest`) — 탭 동기화 없음. 다른 점: `setSession(token)`은 `token.refresh_token`이 있으면 **먼저** `writeRefreshToken` 후 메모리 반영(쓰기 실패면 메모리에만 두고 `storageWarning=true` — 다음 실행 때 다시 로그인; 원문을 다른 저장소로 옮기지 않는다); `clearSession`은 `clearRefreshToken`도 한다.
- Produces (`app/src/api.js`): `request` — 헤더 병합(이미 병합한다), 토큰 있으면 Bearer, 웹(`Platform.OS==='web'`)에서 `/api/auth/` 경로는 `credentials:'include'`, 401 처리와 `AUTH_NO_RETRY_PATHS`는 웹 Task 2 와 같은 규칙(한 번만 재시도, 네 경로 제외, 오프라인은 로그아웃 아님). 새 `authApi = { getConfig, loginGoogle(id_token, platform), refresh(refresh_token|null), logout(refresh_token|null), getMe, deleteMe }` — 앱은 개인 토큰 화면을 두지 않는다(D-S4). `refresh`·`logout`은 네이티브면 본문 `{refresh_token}`, 웹이면 본문 없음. 갱신기(`setRefresher`)는 Task 9 가 등록한다.

- [ ] **Step 1: 실패하는 테스트** (`authSession.test.js` + `api.test.js` 추가)
  - `loginPlatform`: `web`·`android`·`ios`(→`null`)·`windows`(→`null`).
  - `setSession writes refresh before memory` — 목 `setItemAsync`가 불린 뒤에야 `getAccessToken()`이 새 값; 목이 던지면 `writeRefreshToken`이 `false`, 메모리에는 있음, `AsyncStorage`의 모든 키 값에 `dwr_`가 없다.
  - `rotation persists new refresh` — 갱신기가 `{access_token:'A2', refresh_token:'dwr_2', …}` → 보안 저장소 값 `dwr_2`.
  - `single flight` (동시 5번 → 갱신기 1번), `401 clears store` (보안 저장소 비워짐), `offline keeps store`.
  - `request: no token no header` (끔 모드 보존 — 기존 `api.test.js` 모든 시험 그대로 통과), `401 refresh retry once`, `auth paths never refresh`, `web auth calls include credentials` (`Platform.OS`를 `web`으로 목: `/api/auth/refresh` 호출에 `credentials:'include'`, 본문 없음), `native refresh sends body`.
- [ ] **Step 2:** `cd app && npx jest src/__tests__/authSession.test.js src/__tests__/api.test.js` → 실패.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** 같은 명령 통과 + `cd app && npx jest` 전체 한 번(기존 수 유지).
- [ ] **Step 5:** 커밋 `feat(app): 보안 저장소 리프레시·단일 갱신·API 401 재시도`.

### Task 8: 앱 Google 로그인 어댑터 (안드로이드 네이티브 + 웹 번들 GIS)

**Files:**
- Create: `app/src/auth/google.js`, `app/src/auth/google.web.js`, `app/src/__tests__/google.test.js`
- Modify: `app/package.json`(`npx expo install @react-native-google-signin/google-signin`), `app/app.json`(`plugins`에 라이브러리 설정 플러그인 — 필요한 옵션은 verify against the library docs), `app/jest.setup.js`(라이브러리 목)

**Interfaces:**
- Produces (둘 다 같은 이름):
  - `googleSignIn({ webClientId }) -> Promise<{ idToken:string } | { cancelled:true }>`. 네이티브: 표준 흐름 `GoogleSignin.configure({ webClientId })` → `GoogleSignin.hasPlayServices()` → `GoogleSignin.signIn()` → 결과에서 `idToken`(설치 버전의 반환 모양 — 예: `{type:'success', data:{idToken}}` 또는 옛 판 `{idToken}` — 을 문서로 확인하고 한 곳에서 꺼낸다). 사용자가 취소한 경우(라이브러리의 취소 상태/코드, verify)는 `{cancelled:true}`. 네이티브 모듈이 없으면(Expo Go) `Google_Sign_In_Error('개발 빌드에서만 Google 로그인을 할 수 있습니다 (Expo Go 는 지원하지 않습니다)')`. Play 서비스 없음 → `이 기기에서 Google Play 서비스를 쓸 수 없습니다`. 그 밖 → `Google 로그인을 하지 못했습니다. 잠시 뒤 다시 시도해 주세요`. **오류 문장에 라이브러리 원문·토큰을 싣지 않는다.**
  - `googleSignOut() -> Promise<void>` — 네이티브는 `GoogleSignin.signOut()`(다음 로그인 때 계정 선택 창이 다시 뜨게), 실패해도 던지지 않음. 웹은 GIS `disableAutoSelect()`(있을 때만).
  - `class Google_Sign_In_Error extends Error` (`google.js`에 두고 `.web.js`가 같은 것을 다시 내보낸다 — 공용 파일 `app/src/auth/googleError.js`로 분리해도 된다).
  - `google.web.js`: 웹 Task 4 의 `loadGoogleIdentity`·`renderGoogleButton` 논리를 옮겨 적는다(앱은 `app/` 밖을 가져오지 않는다). GIS 는 버튼을 그려야 해서 웹 번들 로그인 화면은 `googleSignIn` 대신 `GoogleWebButton` 컴포넌트(`app/src/auth/GoogleWebButton.web.js`, 네이티브용 `GoogleWebButton.js`는 `null`)를 쓴다.
- [ ] **Step 1: 실패하는 테스트** (라이브러리 목: `configure`·`hasPlayServices`·`signIn`·`signOut`·취소 코드 상수)
  - `returns idToken` — `configure`에 `webClientId` 전달, 결과 `{idToken:'idt'}`.
  - `cancel → cancelled` · `no play services → Korean` · `unknown error → generic Korean, no raw text` (목이 `new Error('SECRET raw idt')`를 던져도 메시지에 `SECRET`·`idt` 없음).
  - `native module missing → dev build message` (목을 `jest.doMock`으로 던지는 import 로 바꿔서).
  - `signOut never throws`.
- [ ] **Step 2:** `cd app && npx jest src/__tests__/google.test.js` → 실패. **Step 3:** 구현 + `app/README.md`에 "로그인은 개발 빌드에서만" 한 줄. **Step 4:** 통과 + `cd app && npx expo export --platform web` 성공(웹 번들에 네이티브 라이브러리가 들어가지 않는다 — `.web.js` 분리 확인).
- [ ] **Step 5:** 커밋 `feat(app): Google 로그인 어댑터 (안드로이드 네이티브·웹 GIS)`.

### Task 9: 앱 인증 흐름 — 시작 확인·경로 보호·로그인 화면 (S-01)

**Files:**
- Create: `app/src/auth/logic.js`, `app/src/auth/AuthProvider.js`, `app/app/login.js`, `app/src/__tests__/authLogic.test.js`, `app/src/__tests__/LoginScreen.test.js`
- Modify: `app/app/_layout.js`(`AuthProvider`로 감싸고 경로 보호)

**Interfaces:**
- Consumes: Task 7 `session.js`·`authApi`·`loginPlatform`, Task 8 `googleSignIn`·`GoogleWebButton`.
- Produces (`logic.js`, 웹 `authLogic.js`와 같은 의미 — "양쪽을 같이 고친다"): `normalizeConfig`, `CONFIG_OFF`, `loginErrorText`, `parseLiveDeploys`, `deleteResultView`, 그리고 `authRoute({ config, configError, status, segments }) -> 'loading'|'error'|'allow'|'to_login'|'leave_login'` — 웹 `routeDecision`과 같은 표 + 로그인 필요·`signed_in`·현재 `segments[0]==='login'`이면 `leave_login`(목록으로).
- Produces (`AuthProvider.js`): `useAuth() -> { config, configError, status, user, retryConfig, signIn(), signOut(), forgetAfterDelete() }`. 시작: `getConfig()` → 저장된 리프레시가 있으면 `refreshSession()`, 없으면 `signed_out` → `markBooted`. 갱신기 = `authApi.refresh(await readRefreshToken())`. `signIn()`: 플랫폼 `null`이면 `이 기기에서는 아직 로그인을 지원하지 않습니다`; `googleSignIn({ webClientId: config.google_client_id_web })` → 취소면 아무 안내 없이 끝 → `loginGoogle(idToken, loginPlatform())` → `setSession` → **푸시 다시 등록**(Task 10 의 `reRegisterIfGranted()`, 실패해도 로그인은 성공). 앱이 다시 앞으로 올 때(`useOnForeground`) 상태가 `signed_in`이면 아무것도 안 하고, 401 은 요청이 알아서 갱신한다.
- `_layout.js`: `authRoute` 결과로 `to_login` → `router.replace('/login')`, `leave_login` → `router.replace('/')`, `loading` → 바탕색 화면 + `불러오는 중…`, `error` → `서버에 연결할 수 없습니다` + `다시 시도`. 내비게이션 방식(`useSegments` + `router.replace`, 또는 Expo Router 의 보호 경로 기능)은 SDK 58 의 Expo Router 문서로 확인해 고른다 (verify against the library docs). 알림 탭 이동(`useNotificationRouting`)은 로그인 뒤에만 이동하게 `allow`일 때만 처리한다.
- Produces (`app/app/login.js`, `FitScreen`, 헤더 제목 `로그인`): 웹 Task 4 와 같은 문구. 네이티브는 `Google 계정으로 로그인` 버튼(44pt+, `accessibilityRole="button"`), 웹 번들은 `GoogleWebButton`. 진행 중 버튼 비활성 + `로그인하는 중…`, 오류는 `FooterSlot` 자리. 끔 모드면 `로그인하지 않고 계속`.

- [ ] **Step 1: 실패하는 테스트**
  - `authLogic.test.js`: 웹 Task 3·5 와 같은 표(`normalizeConfig`·`loginErrorText`·`parseLiveDeploys`·`deleteResultView`) + `authRoute`(`leave_login` 경우 포함).
  - `LoginScreen.test.js` (`googleSignIn`·`authApi`·`push` 목): 버튼 → `loginGoogle('idt','android')` 한 번(연타해도 한 번), 성공 시 `router.replace` 대상이 `/`, 취소 → 오류 문구 없음, 403 → 서버 문구 표시, `login_available:false` → 버튼 없음 + 설정 안내, 끔 모드 → `로그인하지 않고 계속` 보임, 로그인 성공 뒤 `reRegisterIfGranted` 1번, 그것이 던져도 화면은 성공.
  - `Text.test.js`(기존)가 새 파일에서도 `react-native` `Text` 직접 import 를 막는지 그대로 통과.
- [ ] **Step 2:** `cd app && npx jest src/__tests__/authLogic.test.js src/__tests__/LoginScreen.test.js` → 실패. **Step 3:** 구현. **Step 4:** 통과 + 전체 `npx jest` 한 번 + `npx expo export --platform web`.
- [ ] **Step 5:** 커밋 `feat(app): 로그인 화면과 경로 보호`.

### Task 10: 앱 내 정보·로그아웃·계정 삭제·푸시 다시 등록

**Files:**
- Create: `app/app/me.js`, `app/app/delete-account.js`, `app/src/auth/userData.js`, `app/src/__tests__/MeScreen.test.js`, `app/src/__tests__/DeleteAccount.test.js`
- Modify: `app/src/ops/push.js`(`reRegisterIfGranted`·`forgetPushDevice` 추가), `app/src/__tests__/push.test.js`, `app/app/index.js`(머리 밑 칩 줄에 `내 정보` 또는 `로그인`), `app/src/accounts/pickedBlock.js`(키 export 만)

**Interfaces:**
- Produces (`push.js`): `reRegisterIfGranted() -> Promise<'granted'|'skipped'>` — 저장된 기기 번호가 있고 `getPushState() === 'granted'`일 때만 `requestAndRegister()`와 같은 등록(권한 창은 **절대** 띄우지 않는다, 이미 허용이므로 `register()`가 묻지 않는다 — 시험으로 고정), 아니면 `skipped`. 서버는 같은 토큰을 새 사용자로 옮긴다(백엔드 Ruling). 그리고 `forgetPushDevice() -> Promise<void>` — 서버를 부르지 않고 저장된 기기 번호만 지운다(계정 삭제 뒤, 서버가 이미 기기 행을 지웠을 때).
- Produces (`userData.js`): `clearUserScopedData() -> Promise<void>` — `dw-picked-block` 삭제(키는 `pickedBlock.js`에서 가져옴). `dw-push-card-dismissed`는 기기 단위라 남긴다. 던지지 않는다.
- Produces (`AuthProvider.signOut` 순서, Task 9 파일에 구현): ① `unregister()`(액세스 토큰이 살아 있을 때 `DELETE /api/devices/{p_d_id}`) ② `authApi.logout(refresh)` (실패해도 계속) ③ `clearSession('logout')`(보안 저장소 비움) ④ `clearUserScopedData()` ⑤ `googleSignOut()` ⑥ `/login`(끔 모드면 `/`).
- Produces (`me.js`, `FitScreen`, 헤더 `내 정보`): 사진(있을 때, `accessibilityLabel` 없이 장식) · 이름 · 이메일, `알림 설정` 버튼(→ `/notification-settings`), 한 줄 `MCP 개인 토큰은 웹의 내 정보에서 만듭니다.`, `로그아웃`(확인 창 `로그아웃할까요? 이 기기의 푸시 알림 등록도 해제됩니다.`, 취소 먼저), `계정 삭제`(빨간 테두리 → `/delete-account`).
- Produces (`delete-account.js`, `FitScreen`, 헤더 `계정 삭제`): 웹 Task 5 와 같은 설명 문구, `계정 삭제`(확인 창: 취소 먼저) → `deleteMe()`. 409 → `parseLiveDeploys` 항목을 누르면 `/deploys/{d_id}`, 안내 `먼저 이 서비스들을 멈추거나 삭제한 뒤 다시 시도하세요.`; 200 → `clearSession('deleted')` + 로컬 기기 번호 지우기(서버가 기기 행을 지웠다 — `unregister()`가 아니라 저장값만, push.js 에 `forgetPushDevice()` export) + `clearUserScopedData()` + `googleSignOut()` → 결과(서버 `message`, ECR 저장소 이름 고정폭 목록 + 복사 버튼) + `처음으로`. 결과가 길면 그 상자만 스크롤.
- `index.js`: 칩 줄(`계정 연결`·`알림 설정` 옆)에 `signed_in`이면 `내 정보`, 아니고 `login_available`이면 `로그인`, 둘 다 아니면 없음.

- [ ] **Step 1: 실패하는 테스트**
  - `push.test.js`: `reRegisterIfGranted` — 저장 번호 없음 → `skipped`·`deviceApi.register` 0번; 권한 `undetermined` → `skipped`·`requestPermissionsAsync` 0번; 저장 번호 + `granted` → 등록 1번, `requestPermissionsAsync` 0번. `forgetPushDevice` — 저장 번호 지움, `deviceApi.remove` 0번.
  - `MeScreen.test.js`: 이름·이메일 표시, 로그아웃 확인 뒤 호출 순서가 `deviceApi.remove` → `authApi.logout` → 보안 저장소 삭제 → `AsyncStorage`의 `dw-picked-block`·`dw-push-device` 없음 → `googleSignOut` (목의 호출 순서 기록으로), `logout`이 실패해도 나머지 진행.
  - `DeleteAccount.test.js`: 409 → 항목 2개, 누르면 `router.push('/deploys/3')`, 세션 그대로; 200 → 결과 문구·저장소 목록 표시, 세션 `signed_out`, `deviceApi.remove` 0번(서버가 이미 지움), 저장 기기 번호 없음; 확인 창 취소 → `deleteMe` 0번; 403(개인 토큰)·503 → 서버 문구.
- [ ] **Step 2:** `cd app && npx jest src/__tests__/push.test.js src/__tests__/MeScreen.test.js src/__tests__/DeleteAccount.test.js` → 실패. **Step 3:** 구현. **Step 4:** 통과 + 전체 `npx jest` 한 번 + `npx expo export --platform web`.
- [ ] **Step 5:** 커밋 `feat(app): 내 정보·로그아웃·계정 삭제·로그인 뒤 푸시 다시 등록`.

### Task 11: 문서

**Files:** `docs/ui-spec.md`(새 절 "5. 로그인·내 정보 (웹)": `/login`·`/me`·`AuthNavLink`·계정 삭제·개인 토큰, 끔 모드 동작, 탭 동기화; "앱" 절에 `/login`·`/me`·`/delete-account` 행, 웹과 다른 점(앱은 개인 토큰 화면 없음, 로그아웃이 기기 등록 해제), "아직 없는 것"에서 로그인·내 정보 제거), `docs/app-web/README.md`("구현 상태"에 이 계획 한 줄 + 확인 범위, "iOS 제거"의 "다시 넣을 때 할 일"에 아래 iOS 노트 추가), `docs/app-web/02-feature-spec.md`(A-01 앱 방식 = 네이티브 계정 선택, A-03 앱은 푸시 해제 먼저, A-04 = 살아 있는 서비스가 있으면 막고(409) 연결만 끊는 진행은 없다 — 백엔드 동작과 맞춤), `docs/app-web/05-flowcharts.md` §5(앱: 네이티브 로그인, 웹: GIS, 401 → 단일 갱신 → 재시도), `docs/app-web/06-screens.md`(S-01·S-15 구현 표시), `docs/app-web/04-api-spec.md`(§1 표에 `GET /api/auth/config`), `app/README.md`(개발 빌드 필요, 로그인 확인 범위, `CORS_ORIGINS`에 `:8082` 필요), `README.md`("Google 로그인, 지금은" 문단을 "웹 `/login`에서 로그인" + 위 "출시 순서"로 교체), `docs/architecture.md`("로그인과 소유권"에 클라이언트 토큰 흐름 웹·앱), `docs/features.md`(`auth` 행에 `ui/`), `docs/milestones.md`, `docs/worklog/2026-11-17.md`(또는 실행 날짜, 영문 간결), `HISTORY.md` 한 줄(끝에 덧붙이기만)

- [ ] **Step 1:** 문서 갱신. 확인한 것과 못 한 것을 나눠 적는다(실제 Google·기기 미확인은 "소유자 수동 확인"으로 남긴다).
- [ ] **Step 2:** `docs/app-web/README.md` "iOS 를 다시 넣을 때 할 일"에 다음 줄을 더한다(한 줄씩):
  - 서버: `features/auth/scheme.py` `LOGIN_PLATFORMS`에 `"ios": ("google_client_id_ios",)` + `shared/settings.py` `google_client_id_ios`(`GOOGLE_CLIENT_ID_IOS`) — 웹·안드로이드 aud 규칙과 다를 수 있으니 Google 문서 확인.
  - 앱: `app/src/auth/platform.js`의 `loginPlatform`에 `ios: 'ios'` 한 줄.
  - 앱: Google 로그인 라이브러리의 iOS 설정(iOS 클라이언트 ID, URL 스킴 — 설정 플러그인 옵션) 한 줄, verify against the library docs.
  - 앱: `expo-secure-store`는 iOS 키체인을 쓴다 — 코드 변경 없음, 기기에서 확인만.
  - 스토어: iOS 에서 Google 만으로 로그인해도 되는지(다른 로그인 옵션 요구 여부) 규정 확인 (이미 README 에 있음 — 링크만).
- [ ] **Step 3:** 커밋 `docs: 로그인 화면 문서`.

### Task 12: 전체 확인·리뷰·병합

- [ ] **Step 1:** 한 번씩 차례로: `npm run test:web`, `npm run build`, `.venv/Scripts/python.exe -m pytest tests/test_auth_config.py tests/test_auth_current_user.py tests/test_auth_api.py -q`, `cd app && npx jest`, `cd app && npx expo export --platform web`. 출력의 통과 수를 worklog 에 적는다.
- [ ] **Step 2 (컨트롤러, 모의 API):** `/api/**`를 모의한 Playwright 로 웹(390×844·1280×800, 라이트·다크): 끔 모드(설정 `auth_required:false, login_available:false`)에서 화면·요청 헤더가 지금과 같음(`Authorization` 없음, `로그인` 링크 없음); 켬 모드에서 `/deploys/3` → `/login?next=%2Fdeploys%2F3`; 가짜 로그인 응답 뒤 `next`로 이동; 401 → 갱신 1번 → 재시도; 두 탭 동시 새로고침에서 `/api/auth/refresh` 1번; 계정 삭제 409 목록 링크·200 결과; 개인 토큰 발급 패널 닫으면 DOM 에 원문 없음; 320px 가로 넘침 없음. GIS 스크립트는 모의(실제 Google 에 연결하지 않음). 앱 웹 번들도 같은 방식으로 로그인·내 정보·계정 삭제 화면을 390×844·360×740 에서 `FitScreen` 넘침을 잰다.
- [ ] **Step 3:** 전체 브랜치 서브에이전트 리뷰(Review Focus 5개를 리뷰어에게 준다) → 지적 수정 → 커밋.
- [ ] **Step 4:** `test`에 `--no-ff` 병합, 브랜치 삭제, push 하지 않음. `.env`·`AUTH_ENABLED`·실제 DB 는 건드리지 않고 "출시 순서"를 소유자에게 남긴다.

---

## 소유자 수동 확인 (실제 Google·기기 — 에이전트가 하지 않는다)

| # | 확인 | 전제 |
|---|---|---|
| M-1 | 병합 직후 끔 모드: 웹·앱의 목록·새 배포·상세·계정 연결·알림이 지금과 같고, 개발자 도구 네트워크에 `Authorization`이 없다 | 없음 |
| M-2 | 웹 `/login`에서 실제 Google 로그인 → `내 정보`에 이름·이메일, 쿠키 `dw_refresh`(HttpOnly) 생김; 허용 목록 밖 계정은 `로그인이 허용된 계정이 아닙니다` | P1·P2·P4 |
| M-3 | 개인 토큰 발급 → MCP `WIZARD_API_TOKEN` → MCP 도구(`list_deploys`) 동작; 폐기 뒤 MCP 가 한국어 401 안내 | M-2 |
| M-4 | `AUTH_ENABLED=true` 재시작 뒤: 새로고침이 로그인 없이 유지(조용한 갱신), 탭 두 개 열고 15분 이상 뒤 동시에 조작해도 둘 다 유지, 로그아웃하면 다른 탭도 로그인 화면, 계정 연결의 GitHub 설치 복귀(`/accounts?connected=…`) 뒤에도 로그인 유지 | M-2, 출시 순서 7 |
| M-5 | 안드로이드 개발 빌드에서 Google 로그인 → 계정 선택 창 → 목록; 서버가 `platform=android` 토큰의 `aud`를 받아들이는지(백엔드 Ruling 13 의 추론 확인); 앱을 껐다 켜도 로그인 유지 | P3 |
| M-6 | 앱 로그인 뒤 푸시 다시 등록 → 서버 `push_devices.u_id`가 본인; 로그아웃 → 기기 행 삭제; 다른 계정 로그인 → 이전 사용자 알림이 오지 않음 | P3 + EAS 프로젝트 id |
| M-7 | 계정 삭제(시험용 허용 계정으로): 살아 있는 배포가 있으면 409 목록, 모두 멈춘 뒤 삭제 → 결과에 ECR 저장소 목록, AWS 콘솔에서 아무것도 지워지지 않았음 | 시험 계정 |

## 이 계획에서 내가 정한 것 (Ruling)

1. 로그인 필요 여부는 공개 `GET /api/auth/config` 하나로 안다(401 로 추측하지 않는다). 옛 서버(404)는 끔.
2. 끔 모드에서도 `login_available`이면 로그인 링크를 보인다 — `assign-owner`와 개인 토큰 발급이 이 길을 쓴다. 로그인하지 않으면 지금과 똑같다.
3. 웹 액세스 토큰은 메모리에만, 새로고침 때 쿠키로 갱신. 여러 탭은 `navigator.locks` + `BroadcastChannel`로 갱신을 한 번만 한다(서버 재사용 감지를 건드리지 않는 클라이언트 쪽 해결).
4. 앱 안드로이드는 `@react-native-google-signin/google-signin`(네이티브, 개발 빌드), 앱 웹 번들은 GIS + 쿠키. 라이브러리 호출은 `app/src/auth/google*.js`에만.
5. 개인 토큰 관리는 웹에만(앱은 안내 한 줄). MCP 는 PC 에서 쓰기 때문.
6. 로그아웃·사용자 바뀜 때 지우는 저장값: `dw-picked-block`(웹·앱), `dw-push-device`(앱, 등록 해제 뒤). `dw-push-card-dismissed`는 기기 단위라 남긴다.
7. 계정 삭제 409 는 링크만 준다 — 화면이 대신 멈추거나 지우지 않는다(규칙 3).

## 열린 소유자 결정 (정해지기 전에는 위 기본값으로 진행)

| # | 결정 | 기본값(추천) | 다른 선택 |
|---|---|---|---|
| D-S1 | 앱 안드로이드 로그인 방식 | 네이티브 `@react-native-google-signin/google-signin` (개발 빌드 필요) | `expo-auth-session` 브라우저 + PKCE (Expo Go 가능성, 리다이렉트 제약) |
| D-S2 | 끔 모드에서 로그인 링크를 보일지 | `login_available`일 때 보인다 (첫 로그인·`assign-owner`·PAT 의 길) | 숨기고 `/login` 주소를 직접 열 때만 |
| D-S3 | 여러 탭 동시 갱신 대응 | 클라이언트 잠금 + 공유 (서버 그대로) | 서버에 재사용 유예(예: 회전 직후 몇 초 안의 옛 토큰은 계열 폐기 대신 401) — 보안 정책 변경 |
| D-S4 | 앱에 개인 토큰 화면 | 두지 않는다 (웹에서) | 앱에도 목록·폐기 |
| D-S5 | 계정 삭제를 ECR 저장소가 남은 멈춘 배포가 있을 때도 막을지 (worklog OPEN 5) | 막지 않고 결과에 목록을 보인다 | 서버를 바꿔 막는다 |
| D-S6 | `AUTH_ENABLED=true`로 켜는 시점 | 출시 순서 1~8 과 M-1~M-4 확인 뒤, 소유자 혼자 쓰는 동안 | 앱 확인(M-5·M-6)까지 끝난 뒤 |
| D-S7 | 남이 쓰기 전 관문 (worklog OPEN 3·4: GitHub 설치 소유 증명, AWS 계정 없는 배포의 서버 세션 대체) | 이 계획 밖, 남에게 열기 전 별도 계획 | 이 계획에 포함 |
