# 보안 관문 2개 (GitHub 설치 주인 증명 · 서버 AWS 계정 대신 쓰기 막기) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `AUTH_ENABLED=true`를 소유자 말고 다른 사람이 쓰기 전에 닫아야 할 두 구멍을 닫는다. (1) GitHub 설치 콜백이 `installation_id`가 로그인한 사용자 것임을 GitHub 사용자 인증으로 증명한 뒤에만 저장한다. (2) 로그인을 켜면 배포가 AWS 계정 없이(또는 연결이 끊긴 채) 서버 자신의 AWS 세션으로 조용히 돌아가지 않는다.

**Architecture:** 관문 1 — GitHub App 설정 "설치 중 사용자 인증(OAuth) 요청"을 켜면 콜백에 `code`가 온다. 새 파일 `features/accounts/github_oauth.py`가 `code`를 사용자 토큰으로 바꾸고 그 사용자가 접근할 수 있는 설치 목록을 받아, 콜백(`Github_Service.services_github_callback`)이 목록에 `installation_id`가 있을 때만 저장한다. 토큰은 메모리에서만 쓰고 버린다. 관문 2 — 배포에 `aws_binding`(`server`|`account`) 열을 두어 "처음부터 서버 계정(소유자 개발 배포)"과 "계정이 있었는데 연결이 끊김"을 구분하고, 세션을 만드는 곳을 하나의 판정 함수(`services_aws_account_session_for_deploy`)로 모은다. 켬 모드에서 끊긴 연결은 항상 실패하고, 서버 계정은 소유자가 허락한 사용자(`users.server_aws_allowed`)만 쓴다. 끔 모드는 지금과 똑같다.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0(async), httpx(`MockTransport`), PyJWT, pytest. 웹 상수는 `node --test`(`npm run test:web`).

**Spec:** `docs/worklog/2026-11-17.md` "OPEN OWNER ITEMS" 3·4 와 "Open owner gates", `docs/superpowers/plans/2026-11-17-login-backend.md`(소유권 규칙·서명 state), `CLAUDE.md` Hard rules 1·2·3·6·8. 실행자는 모두 읽는다. GitHub 사실은 Task 1 이 만드는 `docs/github-notes.md`만 믿는다.

## Global Constraints

- 브랜치 `feat/security-gates` (`test`에서). 끝나면 `test`에 `--no-ff` 로컬 병합. push·`main`은 소유자의 명시적 허락 후에만.
- **끔 모드(`AUTH_ENABLED=false`)는 지금 동작 그대로.** 콜백은 `code` 없이도 저장하고(있어도 무시), `aws_account_id`가 없거나 끊긴 배포는 지금처럼 서버 세션을 쓴다. 기존 끔 모드 테스트는 하나도 고치지 않고 통과해야 한다.
- **GitHub API 를 지어내지 않는다** (Hard rule 2 의 GitHub 판). 코드에 쓰는 GitHub 주소·인자·응답 필드는 `docs/github-notes.md`의 "확인됨" 줄에 있는 것만. "확인 안 됨"으로 남은 사실에 기대는 코드는 쓰지 않고 Task 1 의 멈춤 규칙을 따른다.
- **사용자 토큰·`code`·Client secret 은 저장하지 않고 로그·DB·오류문·리다이렉트 주소에 싣지 않는다** (Hard rule 6). 외부로 나가는 오류 문자열은 `mask_text`를 거치고, 콜백 실패는 이유 문자열 대신 리다이렉트 코드만 돌려준다. Client secret 은 요청 본문으로만 보낸다(주소·argv 금지).
- 새 AWS API 호출 없음. 세션은 지금처럼 주입(Hard rule 1). 자동 삭제 없음(Hard rule 3) — 연결이 끊긴 배포의 리소스는 지우지 않고 안내만 한다.
- 새 열은 `ENSURE_COLUMNS`로만 더한다(열 삭제·이름 변경 없음). `data/wizard.db`는 어느 Task 도 열지 않는다(테스트는 `tests/.data`·`tmp_path`).
- 이름: 클래스 Pascal_Snake, 함수 `<계층>_<도메인>_<동작>`, 함수 위 한 줄 한국어 주석, docstring 없음, 기존 `=` 공백 유지, 사용자에게 보이는 문자열 한국어, 기존 파일 줄바꿈(CRLF) 보존. 기능 간 호출은 services 로만(`accounts` → `auth` 는 순환을 피해 함수 안에서 임포트 — 기존 `from features.deploys.services import Deploy_Service` 방식), `shared/*` → `features/*` 금지.
- API 변경은 같은 Task 에서 `docs/api-spec.md`를 고친다. `deploys.status` 값은 바뀌지 않는다.
- 테스트는 네트워크·AWS·GitHub 없이. pytest 는 한 번에 하나, 범위를 좁혀 돌리고 전체는 Task 8 에서 한 번. 다른 프로젝트의 프로세스를 이름으로 끄지 않는다.
- 소유자 지시: 질문은 `AskUserQuestion`으로만. 아래 "열린 결정"은 표시된 기본값(추천)으로 진행하고 `Ruling:`으로 남긴다.

## 소유자 쪽 선행 작업 (코드 Task 와 별개)

| # | 할 일 | 필요한 시점 |
|---|---|---|
| P1 | GitHub App 설정(github.com/settings/apps/<앱>): "Request user authorization (OAuth) during installation" 켜기, Callback URL 을 `<서버 주소>/api/accounts/github/callback`으로(지금 Setup URL 로 쓰는 주소와 같은 경로), Client secret 생성. 정확한 화면 이름·Setup URL 과의 관계는 `docs/github-notes.md`(Task 1)대로 | 실제 GitHub 연결 확인 때 (테스트는 가짜) |
| P2 | `.env`에 `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` 추가. Client secret 은 비밀번호 관리자에 백업(잃으면 GitHub 에서 새로 만든다) | P1 직후 |
| P3 | 병합 뒤 `python scripts/migrate_login.py status` → (열린 결정 D1 기본값이면) `assign-owner --email <본인> --yes`가 본인에게 서버 계정 허락도 준다. 이미 assign-owner 를 돌렸다면 `server-aws --email <본인> --allow --yes` | `AUTH_ENABLED=true` 전 |
| P4 | 실제 GitHub 로 한 번 연결해 보고(설치 → 돌아와 초록 알림) `docs/github-notes.md`의 "실제로 본 것"에 적기 | 다른 사람에게 열기 전 |

## Review Focus

1. **목록에 없는 설치·여러 쪽 목록**: 사용자가 접근할 수 없는 `installation_id`(남의 개인 계정·권한 없는 조직)는 저장되지 않고 `github_unverified`; 설치가 100개를 넘어 2쪽째에 있는 경우도 찾는다 → Task 2(`test_github_oauth_installation_ids_paginates`), Task 3(`test_github_callback_rejects_foreign_installation`).
2. **토큰·code·secret 새는 곳**: 교환 실패·네트워크 오류 메시지, 리다이렉트 `location`, DB(`github_installations` 모든 열), 배포 로그에 `ghu_…`·`code` 값·secret 이 없다 → Task 2(`test_github_oauth_errors_never_carry_secrets`), Task 3(`test_github_callback_never_leaks_code_or_token`).
3. **끊긴 연결이 서버 세션으로 새는 모든 길**: 켬 모드에서 파이프라인(새 배포·다시 배포·자동 재배포·다시 켜기·이어서 배포), 자동 복구(재시작·되돌리기), 멈춤, 삭제, `session_end.py` 어디서도 `get_aws_session()`이 불리지 않는다 → Task 4·5(`test_binding_*`, `test_no_direct_deploy_session_build`).
4. **주인 없는 행(u_id NULL, assign-owner 전)**: 켬 모드에서 서버 계정을 쓰는 만들기·갱신은 거절되고, 요금을 줄이는 정리(멈춤·삭제·session_end)만 된다 → Task 4(`test_binding_ownerless_denied_except_cleanup`).
5. **끔 모드 회귀**: `code` 없는 콜백, 연결 없는 배포, 끊긴 연결 배포가 지금처럼 동작 → Task 3(`test_github_callback_off_mode_ignores_code`), Task 4(`test_binding_off_mode_unchanged`).

---

### Task 1: GitHub 문서 확인과 `docs/github-notes.md` (코드 없음)

**Files:**
- Create: `docs/github-notes.md`
- Modify: `CLAUDE.md` Docs 표에 한 줄(`docs/github-notes.md` | GitHub API 호출을 쓰거나 고칠 때) — Hard rules 는 건드리지 않는다

**Interfaces:**
- Produces: `docs/github-notes.md` — `docs/aws-notes.md` 형식(검증 출처·날짜, "API" 표, "확인됨 / 확인 안 됨" 표, "실제로 본 것" 빈 절, "함정"). 아래 사실마다 출처 URL(docs.github.com)과 확인한 문장 요약.

- [ ] **Step 1:** docs.github.com 에서 아래 사실을 하나씩 확인해 표에 `확인됨`/`확인 안 됨`/`다름(실제 내용)`으로 적는다. 기억으로 채우지 않는다(WebFetch 로 읽은 쪽만).
  - G1 "Request user authorization (OAuth) during installation"을 켜면 설치 뒤 Setup URL 대신 **Callback URL** 로 돌아오고, 쿼리에 `code`·`installation_id`·`setup_action`이 온다. Setup URL 은 쓸 수 없게 되는가.
  - G2 설치 주소 `https://github.com/apps/<slug>/installations/new?state=<값>`의 `state`가 이 경우에도 콜백에 그대로 돌아오는가.
  - G3 코드 교환: `POST https://github.com/login/oauth/access_token`, 본문 `client_id`·`client_secret`·`code`(`redirect_uri` 필요 여부), `Accept: application/json` → `access_token`. 실패가 HTTP 200 + `error`(`bad_verification_code` 등)로 오는가. code 유효 시간과 1회용 여부.
  - G4 `GET https://api.github.com/user/installations` (사용자 토큰 `Authorization: Bearer`, `per_page` 최대 100, `page`) → `{total_count, installations:[{id, account{login,type}, repository_selection}]}`. 포함 기준(사용자가 접근 권한을 가진 이 앱의 설치) — 조직 설치에서 관리자가 아닌 구성원도 보이는가. 앱에 사용자 권한(user permissions)이 따로 필요 없는가.
  - G5 사용자 토큰 폐기: `DELETE https://api.github.com/applications/{client_id}/token`, Basic 인증 `client_id:client_secret`, 본문 `{"access_token": …}` → 204.
  - G6 `setup_action` 값(`install`|`update`|`request`): `request`(조직 소유자 승인 대기)일 때 `installation_id`가 없는가, `update`일 때 `code`가 오는가.
  - G7 사용자 토큰 만료(expiring user tokens)가 켜져 있으면 응답에 `refresh_token`·`expires_in`이 더 오는 것 말고 다른가.
  - G8 Callback URL 이 여러 개 등록돼 있을 때 교환에 `redirect_uri`를 보내야 하는가.
  - G9 Client ID 형식·Client secret 만드는 화면 (P1·P2 안내용).
- [ ] **Step 2: 멈춤 규칙.** G1·G3·G4 중 하나라도 `확인 안 됨`/`다름`이면 Task 2 로 가지 않고 controller 에 보고한다(소유자에게 묻는 것은 controller). G2 만 `다름`이면 대안 설계를 그대로 쓴다: 콜백이 `code` 없이 오면 서명된 새 state(`typ="gh_claim"`, `u`, `c`, `i`=installation_id, 15분)를 실어 `https://github.com/login/oauth/authorize?client_id=…&state=…`로 다시 보내고, 돌아온 `code`+`gh_claim` state 로 Task 3 의 확인을 한다(이때 authorize 주소의 인자도 G-표에 넣고 확인). G5 가 `확인 안 됨`이면 폐기 호출은 빼고(토큰은 그냥 버린다) `Ruling:`으로 남긴다. G6·G7·G8 은 확인한 대로 Task 3 분기를 맞춘다.
- [ ] **Step 3:** 커밋 `docs: GitHub 사용자 인증 확인 메모`.

### Task 2: 설정과 GitHub 사용자 인증 클라이언트

**Files:**
- Create: `features/accounts/github_oauth.py`
- Modify: `shared/settings.py`, `.env.example`
- Test: `tests/test_github_oauth.py` (새)

**Interfaces:**
- Consumes: `docs/github-notes.md` G3·G4·G5 의 주소·필드.
- Produces:
  - 설정: `github_app_client_id:str|None=Field(None, alias="GITHUB_APP_CLIENT_ID")`, `github_app_client_secret:str|None=Field(None, alias="GITHUB_APP_CLIENT_SECRET")`, `@property github_oauth_ready -> bool` (둘 다 있을 때).
  - `class Github_Oauth_Error(Exception)` — 메시지는 고정 한국어 짧은 문구만(응답 본문·토큰·code 를 싣지 않는다). 속성 `reason:str` ∈ `exchange_failed`|`list_failed`|`not_configured`.
  - `class Github_Oauth` (`@staticmethod`, 모두 `transport:httpx.AsyncBaseTransport|None=None` 키워드를 받아 `httpx.AsyncClient(transport=transport, timeout=GITHUB_OAUTH_TIMEOUT_SECONDS)`로 부른다; 상수 10초):
    - `async github_oauth_exchange_code(code:str, transport=None) -> str` — 사용자 토큰. 설정 없음 → `not_configured`, HTTP 오류·`error` 필드·`access_token` 없음 → `exchange_failed`.
    - `async github_oauth_installation_ids(token:str, transport=None) -> set[int]` — `per_page=100`, 최대 10쪽, 받은 수가 100 미만이거나 `total_count`에 닿으면 멈춤. 실패 → `list_failed`.
    - `async github_oauth_revoke(token:str, transport=None) -> None` — 실패해도 예외를 내지 않는다(G5 가 확인 안 됐으면 이 함수는 만들지 않는다).

- [ ] **Step 1: 실패하는 테스트** (`httpx.MockTransport`, 요청을 리스트에 모아 단언):
  - `test_github_oauth_exchange_code_ok` — 교환 요청이 G3 주소·`POST`·`Accept: application/json`, 본문에 `client_id`·`client_secret`·`code`; 요청 **주소(query)에는 secret·code 가 없다**. 응답 `{"access_token":"ghu_"+"a"*36,"token_type":"bearer"}` → 그 토큰.
  - `test_github_oauth_exchange_code_errors` — `200 {"error":"bad_verification_code"}`, 401, 연결 오류(`MockTransport`가 `httpx.ConnectError`) → 모두 `Github_Oauth_Error`, `reason == "exchange_failed"`; client id/secret 이 없으면 요청 0번에 `not_configured`.
  - `test_github_oauth_installation_ids_paginates` — 1쪽 100개(id 1..100), 2쪽 1개(id 777), `total_count=101` → `{1..100, 777}`, 요청 2번, 각 요청 `Authorization: Bearer <토큰>`.
  - `test_github_oauth_installation_ids_fail` — 401/500/깨진 JSON → `list_failed`.
  - `test_github_oauth_errors_never_carry_secrets` — 위 실패들의 `str(e)`·`repr(e)`에 토큰·`code` 값·secret 문자열이 없다. 또 `mask_text("token=ghu_"+"b"*36)`에 원문이 없다(기존 패턴 `gh[pousr]_` 확인).
  - `test_github_oauth_revoke_swallows_errors` — 500·연결 오류에도 예외 없음, 요청은 Basic 인증(G5).
- [ ] **Step 2:** `.venv/Scripts/python.exe -m pytest tests/test_github_oauth.py -q` → 실패(모듈 없음).
- [ ] **Step 3:** 구현. `.env.example`에 두 변수와 주석(GitHub App 설정의 Client ID·Client secret, 로그인 켬 모드의 GitHub 연결에 필요).
- [ ] **Step 4:** 같은 명령 → 통과.
- [ ] **Step 5:** 커밋 `feat(accounts): GitHub 사용자 인증 클라이언트`.

### Task 3: 설치 콜백 — 켬 모드에서 설치 주인 증명

**Files:**
- Modify: `features/accounts/services.py` (`services_github_callback`, `services_github_install_url`, `services_github_installation_upsert`, 상수), `features/accounts/router.py` (콜백 쿼리), `features/accounts/models.py` + `features/accounts/crud.py` (`claim_verified_at`), `shared/database.py` (`ENSURE_COLUMNS["github_installations"]`), `features/accounts/ui/constants.js`, `docs/api-spec.md`, `docs/ui-spec.md`(연결 실패 알림 문구)
- Test: `tests/test_ownership_accounts.py` (켬 모드 콜백 테스트 갱신·추가), `tests/web/accountsCallback.test.js`

**Interfaces:**
- Consumes: Task 2 `Github_Oauth.github_oauth_exchange_code/installation_ids/revoke`, `Github_Oauth_Error`, `settings.github_oauth_ready`.
- Produces:
  - 열 `github_installations.claim_verified_at: Mapped[Optional[datetime]]` (TIMESTAMP) — 켬 모드에서 사용자 인증으로 주인을 확인한 시각. 옛 행은 NULL(그대로 쓸 수 있다, 열린 결정 D2).
  - 새 리다이렉트 상수: `GH_CALLBACK_UNVERIFIED="/accounts?connected=github_unverified"`, `GH_CALLBACK_REQUESTED="/accounts?connected=github_requested"`, `GH_SETUP_ACTION_REQUEST="request"`.
  - `services_github_callback(db, installation_id:int|None, state:str|None, setup_action:str|None=None, code:str|None=None) -> str`. 라우터는 `installation_id:int|None=None`, `code:str|None=None`을 받아 넘긴다.
  - `services_github_installation_upsert(db, installation_id, u_id=None, verified:bool=False)` — `verified`면 `claim_verified_at=지금`.
  - 켬 모드 순서 (끔 모드는 지금 코드 그대로, `code` 무시, `installation_id` 없으면 `github_error`):
    1. state 없음 → 지금처럼(`update`면 neutral, 아니면 `github_error`). state 서명 불량 / `u` 없음 → `github_error`.
    2. `setup_action == "request"` → 저장 없이 `github_requested` (G6 대로).
    3. `installation_id` 없음 → `github_error`. `code` 없음 → `update`면 neutral(G6), 아니면 `github_unverified`. `settings.github_oauth_ready` 아님 → `github_unverified`.
    4. 기존 주인 비교(지금처럼 GitHub 에 묻기 전) → 남의 것 `github_taken`.
    5. 교환 → 목록 → `installation_id`가 목록에 없거나 `Github_Oauth_Error` → 저장 없이 `github_unverified`. 토큰은 지역 변수로만, `finally`에서 `revoke`(Task 1 G5 확인 시).
    6. `upsert(..., verified=True)`, 동시 저장 경합 처리와 블록 잇기는 지금처럼 → `github`.
  - `services_github_install_url`: 켬 모드이고 `github_oauth_ready`가 아니면 503 `'GitHub 연결 확인 설정이 없습니다. 서비스 운영자가 GitHub App 의 Client ID·Client secret 을 서버 .env 의 GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET 에 넣어야 합니다.'` (끔 모드는 지금처럼).
  - 웹 상수: `GITHUB_CALLBACK_UNVERIFIED='github_unverified'` → `'GitHub 계정으로 이 설치에 접근할 수 있는지 확인하지 못했습니다. GitHub 연결을 다시 시작해 주세요'`, `GITHUB_CALLBACK_REQUESTED='github_requested'` → `'조직 관리자의 승인을 기다리고 있습니다. 승인된 뒤 다시 연결해 주세요'` (`GITHUB_CALLBACK_ERROR_TEXT`에 추가).

- [ ] **Step 1: 실패하는 테스트** (켬 모드는 기존 `test_github_callback_signed_state`의 설정 방식; `Github_Oauth` 세 함수를 monkeypatch 한 가짜 GitHub — 받은 `code`·호출 수를 기록, 목록은 테스트가 정한 `set[int]`; 앱 설치 조회는 기존 `Fake_Async_Client`):
  - `test_github_callback_verified_saves` — state(u=A, c=A의 블록) + `code="c1"` + 목록 `{555}` → `github`, 행 주인 A, `claim_verified_at` 있음, 블록에 이어짐, 교환 1번·폐기 1번.
  - `test_github_callback_rejects_foreign_installation` — 목록 `{999}` → `github_unverified`, `github_installations` 0행, 앱 설치 조회 0번.
  - `test_github_callback_requires_code_on_mode` — `code` 없음 → `github_unverified`(저장 없음); `setup_action=update`+`code` 없음 → `/accounts`; `setup_action=request`(installation_id 없음) → `github_requested`.
  - `test_github_callback_oauth_failures` — 교환 `exchange_failed`, 목록 `list_failed`, `github_oauth_ready` 거짓 → 모두 `github_unverified`, 저장 없음, 500 아님.
  - `test_github_callback_taken_before_github_call` — 남의 행이 있는 `installation_id` → `github_taken`, 교환 0번.
  - `test_github_callback_never_leaks_code_or_token` — 성공·실패 모두 `location`에 `code`·토큰·state 가 없고, `github_installations` 모든 열 값과 `deploy_logs`에 토큰·`code` 문자열이 없다.
  - `test_github_callback_off_mode_ignores_code` — 끔 모드: `code` 있어도 교환 0번, 지금처럼 저장(`claim_verified_at` NULL); `code` 없는 기존 끔 모드 테스트(`test_github_callback_off_mode`)는 그대로 통과.
  - `test_github_install_url_requires_oauth_config_on_mode` — 켬 모드 + client secret 없음 → 503 한국어; 끔 모드 → 200.
  - 기존 켬 모드 콜백 테스트(`test_github_callback_signed_state`, `test_github_callback_race_*`, `test_github_callback_taken_by_other`)는 `code`와 가짜 목록을 더해 같은 단언을 유지하도록 고친다(단언을 약하게 바꾸지 않는다).
  - 웹: `accountsCallback.test.js`에 두 새 코드가 빨간 알림 문구로 풀리는지.
- [ ] **Step 2:** `.venv/Scripts/python.exe -m pytest tests/test_ownership_accounts.py tests/test_accounts_api.py -q` → 새 테스트 실패.
- [ ] **Step 3:** 구현 + `docs/api-spec.md` 콜백·install-url 줄(새 코드 2개, 켬 모드 `code` 필수, 503 조건, `claim_verified_at`) + `docs/ui-spec.md` 알림 문구.
- [ ] **Step 4:** 같은 명령 → 통과. `npm run test:web` → 통과.
- [ ] **Step 5:** 커밋 `feat(accounts): GitHub 설치 콜백이 사용자 인증으로 주인을 확인`.

### Task 4: 배포의 AWS 묶음(`aws_binding`)과 세션 판정 함수

**Files:**
- Modify: `features/deploys/models.py` (`aws_binding` 열 + 허용 값 주석), `features/deploys/scheme.py` (`Deploy_In_DB.aws_binding`), `features/deploys/crud.py` (`crud_deploy_create`에 `aws_binding`, 두 unlink 가 `aws_binding='account'`도 함께), `features/auth/models.py` (`users.server_aws_allowed`), `features/auth/services.py` (`services_auth_server_aws_allowed`), `features/accounts/services.py` (판정·세션 함수, 상수·문구), `shared/database.py` (`ENSURE_COLUMNS["deploys"]`에 `aws_binding`, 새 키 `"users": ["server_aws_allowed"]`)
- Test: `tests/test_aws_binding.py` (새), `tests/test_ensure_columns.py`

**Interfaces:**
- Produces:
  - 열 `deploys.aws_binding: Mapped[Optional[str]] = String(10)` — `# server|account` (NULL = 이 변경 전 행: `aws_account_id`가 있으면 account, 없으면 server 로 읽는다). 열 `users.server_aws_allowed: Mapped[bool]` (nullable=False, default=False, server_default `'0'` — 기존 `ENSURE_COLUMNS` bool 열 방식을 따른다).
  - `features/accounts/services.py` 상수: `AWS_BINDING_SERVER="server"`, `AWS_BINDING_ACCOUNT="account"`, `MESSAGE_AWS_UNLINKED="이 배포가 쓰던 AWS 계정 연결이 해제됐습니다. 서버 계정으로 대신 실행하지 않습니다 - 리소스가 남아 있다면 그 AWS 계정의 콘솔에서 직접 정리하고, 새 연결로 배포를 새로 만들어 주세요"`, `MESSAGE_SERVER_AWS_DENIED="이 계정에서는 서버의 AWS 계정으로 배포할 수 없습니다. AWS 계정을 연결한 블록을 골라 주세요"`.
  - `class Aws_Binding_Error(ValueError)` (accounts/services.py) — 메시지는 위 두 문구 중 하나. `ValueError`의 하위형이라 파이프라인·기존 `except ValueError` 가 한국어 그대로 보여준다.
  - `Auth_Service.services_auth_server_aws_allowed(db, u_id:int) -> bool` — 사용자 행의 플래그(없는 사용자·`deleted` 는 False).
  - `Aws_Account_Service.services_aws_account_server_allowed(db, u_id:int|None) -> bool` — 끔 모드 True, 켬 모드 `u_id is None` False, 아니면 위 함수(함수 안에서 임포트).
  - `Aws_Account_Service.services_aws_account_binding_check(db, aws_account_id:int|None, aws_binding:str|None, u_id:int|None, cleanup:bool=False) -> None` — AWS 를 부르지 않는 판정. 표:

    | `aws_account_id` | `aws_binding` | 끔 모드 | 켬 모드 |
    |---|---|---|---|
    | 있음 | 무엇이든 | 통과 | 통과 |
    | 없음 | `account` | 통과(지금처럼 서버 세션) | `Aws_Binding_Error(MESSAGE_AWS_UNLINKED)` — `cleanup`이어도 |
    | 없음 | `server`/NULL | 통과 | `cleanup` 또는 `server_allowed(u_id)` 면 통과, 아니면 `Aws_Binding_Error(MESSAGE_SERVER_AWS_DENIED)` |

    `cleanup=True`는 요금을 줄이는 동작(멈춤·삭제·session_end)만 쓴다 — 서버 계정에 떠 있는 것은 서버 계정에서만 내릴 수 있기 때문.
  - `Aws_Account_Service.services_aws_account_session_for_deploy(db, aws_account_id, aws_binding, u_id, cleanup:bool=False) -> boto3.Session` — `binding_check` 뒤, id 가 있으면 `services_aws_account_build_session(db, id)`, 없으면 `get_aws_session()`. `services_aws_account_build_session` 자체는 바꾸지 않는다(계정 화면·`scripts/session_end.py`의 "개발 계정" 점검용).
  - 배포 만들 때 `aws_binding` = `account`(id 있음) / `server`(없음). unlink 두 함수는 `aws_account_id=None, aws_binding='account'`.

- [ ] **Step 1: 실패하는 테스트** (`tests/test_aws_binding.py`, 판정 함수 단위 + `get_aws_session`·`get_assumed_session` monkeypatch 로 어느 쪽이 불렸는지 기록):
  - `test_binding_off_mode_unchanged` — 끔 모드: (없음, account), (없음, server), (없음, NULL) 모두 서버 세션, 예외 없음.
  - `test_binding_unlinked_fails_closed_on_mode` — 켬 모드 (없음, account): `cleanup` 거짓·참 모두 `Aws_Binding_Error`, 메시지에 `연결이 해제됐습니다`, `get_aws_session` 0번.
  - `test_binding_server_requires_flag_on_mode` — 켬 모드 (없음, server, u=A): A 플래그 거짓 → `MESSAGE_SERVER_AWS_DENIED`; 참 → 서버 세션; NULL binding 도 같다.
  - `test_binding_ownerless_denied_except_cleanup` — 켬 모드 u_id None: 만들기·갱신용(`cleanup` 거짓) 거절, `cleanup=True` 통과.
  - `test_binding_linked_uses_assumed` — id 있으면 두 모드 모두 위임 세션, `get_aws_session` 0번(위임 내부 기본 세션은 제외하도록 `get_assumed_session`을 가짜로).
  - `test_unlink_marks_account_binding` — binding NULL·id 있는 행을 `services_deploy_unlink_aws_account`/`_accounts`로 떼면 `aws_binding == "account"`, id NULL.
  - `test_deploy_create_sets_binding` — 끔 모드 API 로 연결 없이 만들면 `aws_binding == "server"`, 있으면 `"account"` (파이프라인 시작은 기존 테스트처럼 막는다).
  - `test_ensure_columns_adds_binding_and_flag` — 옛 스키마에 두 열이 더해진다(기존 방식).
- [ ] **Step 2:** `.venv/Scripts/python.exe -m pytest tests/test_aws_binding.py tests/test_ensure_columns.py -q` → 실패.
- [ ] **Step 3:** 구현(`CLAUDE.md` 상태 표는 바뀌지 않는다; `aws_binding`은 상태값이 아니다).
- [ ] **Step 4:** 같은 명령 → 통과.
- [ ] **Step 5:** 커밋 `feat(accounts): 배포의 AWS 묶음과 서버 계정 판정`.

### Task 5: 세션을 만드는 모든 곳을 판정 함수로, 요청 시점 검사

**Files:**
- Modify: `features/deploys/pipeline.py` (`pipeline_get_aws_session`), `features/deploys/services.py` (create·redeploy·start·env_continue·stop·delete·session_end, 새 헬퍼), `features/incidents/recovery.py`, `features/accounts/services.py` (`services_aws_account_delete` 켬 모드 409), `features/accounts/router.py` (`GET /api/accounts/server-aws`), `docs/api-spec.md`
- Test: `tests/test_ownership_deploys.py`, `tests/test_recovery.py`, `tests/test_pipeline.py`, `tests/test_ownership_accounts.py`, `tests/test_aws_binding.py`(구조 테스트)

**Interfaces:**
- Consumes: Task 4 `services_aws_account_session_for_deploy`, `services_aws_account_binding_check`, `services_aws_account_server_allowed`, `Aws_Binding_Error`.
- Produces:
  - `Deploy_Service.services_deploy_session(db, deploy, cleanup:bool=False) -> boto3.Session` — `session_for_deploy(db, deploy.aws_account_id, deploy.aws_binding, deploy.u_id, cleanup)`.
  - `Deploy_Service.services_deploy_check_aws_ready(db, deploy) -> None` — `binding_check(..., cleanup=False)`; `Aws_Binding_Error` → `HTTPException(409, detail=str(e))`.
  - `Deploy_Pipeline.pipeline_get_aws_session(deploy)` — 배포 행을 받아 `services_deploy_session(db, deploy)` (`cleanup` 거짓). `Aws_Binding_Error`는 기존 실패 처리로 `failed` + 한국어 `error_msg`(AWS 호출 0번).
  - 만들기: 켬 모드에서 `aws_account_id`가 없고 `server_allowed(u_id)`가 거짓이면 400 `MESSAGE_SERVER_AWS_DENIED` (배포 행 안 생김).
  - redeploy·start·env_continue: 상태를 `queued`로 바꾸기 전에 `check_aws_ready` → 409 (상태 그대로).
  - stop·delete·`services_deploy_session_end`: `services_deploy_session(..., cleanup=True)`. 켬 모드 끊긴 연결이면 stop·delete 는 409 `MESSAGE_AWS_UNLINKED`(기록 그대로), session_end 는 `report["failed"]`에 그 문구. delete 에서 지울 AWS 리소스(`service_arn`·`repository_name`)가 없으면 지금처럼 세션 없이 `deleted`.
  - recovery: `services_deploy_session(db, deploy)` (`cleanup` 거짓) — 거절이면 AWS 호출 없이 그 시도 `failed`, 인시던트는 기존 실패 경로(`needs_action`).
  - incidents 증거 수집(`services_incident_collect_evidence`)은 지금처럼 id 가 있을 때만 세션을 만든다 — 바꾸지 않는다.
  - `services_aws_account_delete`: 켬 모드에서 그 계정을 쓰는 `deleted`가 아닌 배포 중 `service_arn` 또는 `repository_name`이 남은 것이 있으면 409 `'이 AWS 계정을 쓰는 배포에 아직 AWS 리소스(서비스·이미지)가 남아 있습니다. 배포를 먼저 삭제한 뒤 연결을 해제하세요'` (열린 결정 D5; 끔 모드는 지금처럼). 블록 삭제도 이 함수를 거치므로 같이 막힌다. `Deploy_Service.services_deploy_count_with_resources(db, a_id:int) -> int` 추가.
  - `GET /api/accounts/server-aws` (인증 의존성 있음) → `{"allowed": bool}` (`server_allowed(user.u_id)`; 끔 모드 항상 true).

- [ ] **Step 1: 실패하는 테스트**
  - `test_deploy_create_without_account_on_mode` — 켬 모드 사용자 B(플래그 거짓) 연결 없이 `POST /api/deploys` → 400, `detail`에 `블록을 골라`, 배포 0개; 플래그 참이면 201 `aws_binding="server"`.
  - `test_deploy_actions_on_unlinked_on_mode` — 켬 모드, binding account·id NULL·`service_arn` 있는 `stopped`/`running`/`needs_input` 배포: redeploy·start·env-continue → 409(상태 그대로, 파이프라인 시작 0번), stop·delete → 409 `연결이 해제됐습니다`, `get_aws_session` 0번, Express 가짜 호출 0번.
  - `test_deploy_stop_server_bound_cleanup_allowed` — 켬 모드, 플래그 거짓 사용자의 binding server `running` 배포 → stop 200(서버 세션으로 내림).
  - `test_pipeline_unlinked_fails_without_aws` — 켬 모드 끊긴 배포로 파이프라인(가짜 단계, 기존 `tests/test_pipeline.py` 구성) → `failed`, `error_msg`가 `MESSAGE_AWS_UNLINKED`, 푸시·Express 0번.
  - `test_recovery_unlinked_no_aws_call` — 켬 모드 끊긴 배포의 재시작 시도 → 시도 `failed`, 업데이트 함수 0번, 인시던트 `needs_action`.
  - `test_session_end_reports_unlinked` — 켬 모드 `services_deploy_session_end` → 끊긴 배포는 `failed`에 문구, 서버 계정 배포는 `stopped`.
  - `test_aws_account_delete_blocked_with_resources_on_mode` — 켬 모드: 리소스 남은 배포가 쓰는 계정 삭제 → 409, 배포 `aws_account_id` 그대로; 리소스 없으면 200 + 배포 binding `account`; 끔 모드는 리소스가 있어도 200.
  - `test_server_aws_endpoint` — 끔 모드 `{"allowed": true}`, 켬 모드 플래그 따라 true/false, 토큰 없으면 401.
  - `test_no_direct_deploy_session_build` — 구조 테스트: `features/` 아래 `.py` 에서 `services_aws_account_build_session(db, deploy.` 패턴이 0개, `get_aws_session(` 사용은 `features/accounts/services.py`에만.
  - 끔 모드 기존 테스트(멈춤·삭제·파이프라인·복구·session_end)는 그대로 통과.
- [ ] **Step 2:** `.venv/Scripts/python.exe -m pytest tests/test_ownership_deploys.py tests/test_aws_binding.py tests/test_recovery.py tests/test_pipeline.py -q` → 새 테스트 실패.
- [ ] **Step 3:** 구현 + `docs/api-spec.md`(배포 생성 400 조건, redeploy/start/env-continue/stop/delete 409 조건, `aws_binding` 필드, 계정 삭제 409, `GET /api/accounts/server-aws`).
- [ ] **Step 4:** 같은 명령 + `tests/test_ownership_accounts.py tests/test_auth_current_user.py` → 통과.
- [ ] **Step 5:** 커밋 `feat(deploys): 로그인 켬 모드에서 서버 AWS 계정으로 새지 않게`.

### Task 6: 이전 스크립트 — 서버 계정 허락과 점검 보고

**Files:**
- Modify: `shared/migrate.py`, `scripts/migrate_login.py`, `scripts/README` 또는 기존 이전 안내가 있는 곳(로그인 계획 Task 8 이 적은 위치)
- Test: `tests/test_migrate_login.py`

**Interfaces:**
- Produces:
  - `migrate_server_aws_set(conn, u_id:int, allowed:bool, dry_run:bool=True) -> bool` (`shared/migrate.py`) — 바뀌는지 돌려준다. 없는 사용자 `ValueError` 한국어.
  - `assign-owner --email X --yes`가 주인 지정과 같은 트랜잭션에서 그 사용자의 `server_aws_allowed=1`(열린 결정 D1 기본값 B). 출력에 한 줄 `서버 AWS 계정 사용 허락: <이메일>`. dry-run 은 계획만.
  - 새 하위 명령 `server-aws --email X (--allow|--deny) [--yes]` — 백업 후 변경(다른 쓰기 명령과 같은 백업·서버 켜짐 확인 규칙).
  - `status`에 두 줄 추가(보고만): `확인 안 된 GitHub 설치(claim_verified_at 없음) N`, `서버 계정 배포(aws_binding server 또는 NULL·계정 없음) N`, `연결이 끊긴 배포(aws_binding account·계정 없음) N`.
- [ ] **Step 1: 실패하는 테스트** — `test_migrate_assign_owner_grants_server_aws`, `test_migrate_server_aws_allow_deny`(백업 파일 생김, `--yes` 없으면 안 바뀜, 없는 이메일 한국어 오류·exit 1), `test_migrate_status_reports_gates`(세 숫자). 기존 이전 테스트의 임시 DB 구성 방식을 따른다.
- [ ] **Step 2:** `.venv/Scripts/python.exe -m pytest tests/test_migrate_login.py -q` → 실패. **Step 3:** 구현 + 안내 문서에 P3 순서. **Step 4:** 통과. **Step 5:** 커밋 `feat(migrate): 서버 AWS 계정 허락과 관문 점검`.

### Task 7: MCP — 연결 없는 배포 미리 막기

**Files:**
- Modify: `features/mcp/services.py` (`services_mcp_deploy`), `features/mcp/server.py` (`deploy` 도구 설명 한 줄)
- Test: `tests/test_mcp.py`, `tests/test_mcp_server.py`

**Interfaces:**
- Consumes: `GET /api/accounts/server-aws`(Task 5), 배포 생성 400·redeploy/start 409(Task 5).
- Produces:
  - `services_mcp_deploy`: 연결을 풀어 본 뒤 `aws_id is None`(블록 없음 또는 AWS 없는 블록)이면 `GET /api/accounts/server-aws`; `allowed`가 거짓이면 미리보기·실행 모두 `Wizard_Error('연결 블록 없이 배포할 수 없습니다 (이 서버는 서버 AWS 계정 사용을 허락하지 않았습니다). list_connections 로 AWS 가 연결된 블록을 고른 뒤 connection_id 를 넣어 주세요.')` — 토큰 발급 0, `POST` 0. 끔 모드 서버는 true 라 지금과 같다.
  - redeploy·start_deploy 의 409 는 기존 오류 전달 방식 그대로 REST `detail`을 보여 준다(새 코드 없음, 테스트로 고정).
  - `deploy` 도구 설명에 "로그인 켬 서버에서는 AWS 가 연결된 블록(connection_id)이 필요할 수 있다" 한 줄.
- [ ] **Step 1: 실패하는 테스트** (`MockTransport`): `test_mcp_deploy_requires_connection_when_server_aws_denied`(미리보기 거절, `/api/deploys` 요청 0), `test_mcp_deploy_server_aws_allowed_unchanged`(true 면 지금 미리보기 그대로), `test_mcp_deploy_with_connection_skips_check`(AWS 있는 블록이면 `/server-aws` 요청 0), `test_mcp_start_unlinked_shows_detail`(409 `detail`이 결과 오류에 그대로, 토큰 문자열 없음), `test_server_deploy_tool_mentions_connection`.
- [ ] **Step 2:** `.venv/Scripts/python.exe -m pytest tests/test_mcp.py tests/test_mcp_server.py -q` → 실패. **Step 3:** 구현. **Step 4:** 통과. **Step 5:** 커밋 `feat(mcp): 서버 계정을 못 쓰면 연결 블록을 요구`.

### Task 8: 문서와 전체 확인

**Files:**
- Modify: `docs/architecture.md`("로그인과 소유권"에 설치 주인 증명 흐름·`aws_binding` 판정 표), `docs/features.md`(accounts 행에 `github_oauth.py`), `docs/app-web/04-api-spec.md`(GitHub 콜백·server-aws, 해당 절이 있으면), `docs/superpowers/specs/2026-11-16-mcp-design.md` 상태 줄(있으면), `docs/milestones.md`, `docs/worklog/2026-11-17.md`(영문 간결: OPEN OWNER ITEMS 3·4 → "closed in code, owner steps P1–P4 pending"), `HISTORY.md` 한 줄, `README`의 로그인 켜기 순서(P1–P3 추가)
- 웹·앱 화면: 새 배포 폼이 `GET /api/accounts/server-aws`로 "연결 없음" 선택지를 숨기는 것은 **로그인 화면 계획으로 넘긴다** — `docs/ui-spec.md`에 TODO 한 줄만(지금은 400 한국어 문구가 그대로 보인다).

- [ ] **Step 1:** 문서 갱신.
- [ ] **Step 2:** 전체 테스트 한 번 `.venv/Scripts/python.exe -m pytest -q -p no:warnings` → 이전 1002 passed / 2 skipped 에 새 테스트가 더해져 모두 통과. `npm run test:web` 통과. 실패 시 출력 보고(`tests/test_watches.py` 불안정이면 단독 재실행 결과도).
- [ ] **Step 3:** 전체 브랜치 서브에이전트 리뷰(Review Focus 5개를 리뷰 지시에 그대로) → 지적 수정 → `docs: 보안 관문 문서`로 커밋.
- [ ] **Step 4:** `test`에 `--no-ff` 병합, 브랜치 삭제, push 하지 않음.

---

## 열린 결정 (소유자, 실행은 기본값으로 진행하고 `Ruling:`으로 기록)

| # | 결정 | 선택지 | 기본값(추천)과 이유 |
|---|---|---|---|
| D1 | 켬 모드에서 연결 없는 배포 | **B. 사용자별 허락 플래그 `users.server_aws_allowed`(기본 거짓, 소유자만 스크립트로 켬)** / A. 켬 모드에서는 `aws_account_id` 필수(누구도 서버 계정 못 씀) | **B** — 소유자 개발 배포(연결 없음)가 assign-owner 뒤에도 그대로 돌고, 다른 사용자는 A 와 똑같이 막힌다. A 를 고르면 assign-owner 가 플래그를 켜지 않을 뿐 코드는 같다(소유자 기존 배포는 만들기·갱신이 막히고 멈춤·삭제만 된다) |
| D2 | 이 변경 전에 저장된 GitHub 설치(`claim_verified_at` 없음) | **그대로 사용** / 켬 모드에서 다시 연결할 때까지 사용 금지 | **그대로** — 지금까지 켬 모드는 소유자만 썼으므로 옛 행은 소유자가 직접 설치한 것. `status`가 수를 보여 준다 |
| D3 | 끔 모드에서 연결이 끊긴 배포 | **지금처럼 서버 세션** / 끔 모드도 실패 | **지금처럼** — 지시("끔 모드는 오늘 동작")대로. 다만 끊긴 배포가 엉뚱한 계정을 부르는 것은 끔 모드에서도 버그라 나중에 바꿀 만하다 |
| D4 | 연결이 끊겼는데 AWS 리소스가 남은 배포 | **안내만(409, 콘솔에서 직접 정리)** / [기록만 지우기] 버튼 추가 | **안내만** — D5 가 새로 생기는 것을 막고, 기록 삭제는 되돌릴 수 없어 따로 정한다 |
| D5 | 켬 모드에서 리소스가 남은 배포가 쓰는 AWS 계정 연결 해제 | **막기(409)** / 지금처럼 떼고 보고만 | **막기** — 떼는 순간 우리가 그 리소스를 다시 못 내리게 되어 요금이 계속 나간다 |
| D6 | 확인 뒤 사용자 토큰 폐기 | **폐기(G5 확인 시)** / 그냥 버림 | **폐기** — 토큰을 저장하지 않더라도 GitHub 쪽 유효 기간을 남기지 않는다 |
