# 로그인 백엔드 (Google 로그인 · 소유권 · 사용자 정보 암호화) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google `id_token`으로 로그인해 짧은 액세스 토큰·회전하는 리프레시 토큰(웹은 httpOnly 쿠키, 앱은 본문)·MCP용 개인 토큰을 발급하고, 모든 기존 테이블에 소유자(`u_id`)를 붙여 모든 라우터가 현재 사용자 것만 보이게 하며, 사용자 관련 정보를 DB 에 암호화해 저장한다. 기존 `data/wizard.db`는 백업 → 단계별 이전으로 잃지 않고 옮긴다.

**Architecture:** 새 기능 폴더 `features/auth/`(users·refresh_tokens·api_tokens 표, Google 검증 `google.py`, 토큰 발급·회전, 현재 사용자 의존성, 라우터). 암호화는 `shared/secrets.py`(MultiFernet·블라인드 인덱스)와 SQLAlchemy 타입 `shared/crypto_types.py`의 `Encrypted_Text`로 저장 계층에서만 일어난다. 소유권은 최상위 표(`deploys`·`aws_accounts`·`github_installations`·`connections`·`notifications`·`push_devices`·`notification_settings`)의 `u_id`로 걸고, 자식 표는 부모를 따라간다. `AUTH_ENABLED=false`(기본)에서는 지금처럼 인증 없이 동작해 웹·앱·MCP가 로그인 화면 계획 전까지 깨지지 않는다.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0(async), PyJWT[crypto](이미 `requirements.txt`에 있음), cryptography(Fernet/MultiFernet, 테스트용 RSA 키), httpx, pytest(`ASGITransport`, 주입한 가짜 JWKS — 네트워크 없음).

**Spec:** `docs/superpowers/specs/2026-11-16-mcp-design.md` §6(2단계)·§6.1(G4 암호화) + `docs/app-web/02-feature-spec.md` A-01~05, `docs/app-web/03-db-erd.md`(users·refresh_tokens), `docs/app-web/04-api-spec.md` §0·§1(인증·소유권 404 규칙). 실행자는 모두 읽는다.

## Global Constraints

- 브랜치 `feat/login-backend` (`test`에서). 끝나면 `test`에 `--no-ff` 로컬 병합. push·`main`은 소유자의 명시적 허락 후에만.
- **`data/wizard.db`를 이 계획의 어느 Task 도 직접 열거나 고치지 않는다.** 실제 DB 이전은 Task 8 의 스크립트를 소유자가 서버를 끈 뒤 직접(또는 승인 후) 실행한다. 테스트는 `tests/.data`·`tmp_path`의 DB 만 쓴다.
- `create_all`은 기존 표를 바꾸지 못한다: 새 열은 `ENSURE_COLUMNS`, 새 인덱스는 새 `ENSURE_INDEXES`(`CREATE [UNIQUE] INDEX IF NOT EXISTS`)로만 더한다. 열 삭제·이름 변경·타입 변경 DDL 없음. 기존 열을 암호화할 때도 같은 열에 암호문을 넣는다(SQLite 는 길이를 강제하지 않는다).
- Google 은 표준 OIDC 만 쓴다: 발견 문서 `https://accounts.google.com/.well-known/openid-configuration`의 `jwks_uri`로 공개키(JWKS)를 받아 `id_token`(RS256)을 검증한다. `iss` 허용값 `https://accounts.google.com`·`accounts.google.com`, `aud` ∈ 설정한 클라이언트 ID, `exp`, `email_verified == true`. **이 값들과 플랫폼별 `aud`는 구현 때 Google 문서로 다시 확인한다** (지어내지 않는다). 서버는 클라이언트 시크릿을 쓰지 않는다(클라이언트가 `id_token`을 받아 보낸다).
- 토큰 (내가 정한 값, `docs/app-web/04-api-spec.md`와 맞춤): 액세스 JWT HS256 `AUTH_JWT_KEY`, 900초, 클레임 `sub`(u_id 문자열)·`typ="access"`·`iss="deploy-wizard"`·`aud="deploy-wizard-api"`·`iat`·`exp`. 리프레시 `dwr_` + `secrets.token_urlsafe(32)`, 30일, 회전(쓴 것 폐기), 폐기된 것이 다시 오면 **계열(`family_id`) 전체 폐기 + 401**. 개인 토큰(PAT, MCP용) `dwp_` + `token_urlsafe(32)`, 기본 30일·최대 90일. 리프레시·PAT 는 **SHA-256 hex 만 저장**(원문 저장 금지, 발급 응답에 한 번만).
- 키는 서로 분리한다: `SECRET_KEY`(Fernet, 기존) + `SECRET_KEYS_OLD`(회전용, 쉼표), `BLIND_INDEX_KEY`(HMAC), `AUTH_JWT_KEY`(JWT). `AUTH_ENABLED=true`인데 셋 중 하나라도 없으면 서버 시작을 한국어 오류로 멈춘다.
- 소유권 위반은 **404**(존재를 숨김, `04-api-spec.md` §0). 남의 `aws_account_id`·`github_installation_id`·`connection` 을 본문에 넣어도 404.
- Hard rules: 토큰·`id_token`·키는 로그·DB 오류문·알림에 싣지 않는다 — `mask_text`가 `dwr_`·`dwp_`·Fernet 암호문(`gAAAAA…`)도 가리게 확장한다(JWT 는 이미 가린다). 외부 호출은 주입 가능한 함수로(테스트는 가짜). 새 AWS 호출 없음.
- 이름: 클래스 Pascal_Snake(`Auth_Service`, `Auth_Crud`, `User`, `Refresh_Token`, `Api_Token`), 함수 `<계층>_<도메인>_<동작>`, 함수 위 한 줄 한국어 주석, docstring 없음, 기존 `=` 공백 유지, 사용자에게 보이는 문자열 한국어, 기존 파일 줄바꿈(CRLF) 보존. 기능 간 호출은 services 로만, `shared/*` → `features/*` 금지. 다른 기능의 services 는 사용자 객체가 아니라 **`u_id:int|None`** 만 받는다.
- API 변경은 같은 Task 에서 `docs/api-spec.md`를 고친다. `deploys.status` 값은 바뀌지 않는다.
- 테스트는 네트워크·AWS·Google 없이 `pytest`. pytest 는 한 번에 하나, 범위를 좁혀 돌리고 전체는 Task 10 에서 한 번. 다른 프로젝트의 프로세스를 이름으로 끄지 않는다.
- 소유자 지시: 질문은 `AskUserQuestion`으로만. 실행 중 아래 "열린 결정"이 필요해지면 기본값으로 진행하고 `Ruling:`으로 남긴다.

## 소유자 쪽 선행 작업 (코드 Task 와 별개, 계획 실행을 막지 않음)

| # | 할 일 | 필요한 시점 |
|---|---|---|
| O1 | Google Cloud 콘솔에서 OAuth 동의 화면 + OAuth 클라이언트 ID 등록: 웹(승인된 JavaScript 원본 `http://localhost:5173`·상용 주소), iOS·Android(번들 ID·패키지 이름은 EAS 설정과 같아야 함). 받은 ID 를 `.env`의 `GOOGLE_CLIENT_ID_WEB`·`GOOGLE_CLIENT_ID_IOS`·`GOOGLE_CLIENT_ID_ANDROID`에. 이 설계에선 클라이언트 시크릿을 서버에 두지 않는다 | 실제 로그인 확인 때 (테스트는 가짜) |
| O2 | `.env`에 새 키 생성: `BLIND_INDEX_KEY`, `AUTH_JWT_KEY` (생성 명령은 Task 1 이 README 에 적는다). **`SECRET_KEY`·`BLIND_INDEX_KEY`를 잃으면 암호화된 사용자 정보를 되살릴 수 없다** — 비밀번호 관리자 등에 백업 | Task 8 실행 전 |
| O3 | EAS: 앱 번들 ID·리다이렉트 스킴 확정, 개발 빌드 (앱 로그인 화면 계획에서) | 앱 로그인 계획 |
| O4 | 실제 이전 실행: 서버 종료 → `python scripts/migrate_login.py backup` → `encrypt --yes` → 서버 켜고 본인 Google 로그인 → `assign-owner --email <본인> --yes` → `AUTH_ENABLED=true` | 계획 병합 후 |

## Review Focus

1. **남의 계정으로 배포**: 사용자 B 가 `POST /api/deploys`·`/advice`·`/remote`·`/connections/{c_id}/aws`에 A 의 `aws_account_id`·`github_installation_id`·`c_id`를 넣으면 404 이고 A 의 AWS·GitHub 자격증명이 쓰이지 않는가 → Task 5, 6.
2. **새 라우트의 인증 누락**: 앞으로 추가될 엔드포인트도 공개 허용 목록에 없으면 인증이 걸리는가 (구조 테스트가 모든 `APIRoute`를 훑는다) → Task 4.
3. **리프레시 토큰 재사용·경쟁**: 같은 리프레시 토큰을 두 번(또는 동시에 두 요청) 쓰면 두 번째가 계열 전체를 폐기하고 401 인가, 만료·로그아웃 뒤 토큰, 삭제된 사용자의 유효한 액세스 토큰이 401 인가 → Task 3, 4.
4. **이전 중 데이터 손실**: 평문이 남은 옛 DB 로 서버를 켜면 500 이 아니라 시작 전에 한국어 안내로 멈추는가, `encrypt`를 두 번 돌려도 이중 암호화되지 않는가, `assign-owner`가 이미 주인 있는 행을 바꾸지 않는가, 백업 파일이 실제로 열리는가 → Task 8.
5. **잘못된 `id_token`**: 서명 위조, `alg=none`/`HS256`, 다른 `aud`·`iss`, 만료, `email_verified=false`, 모르는 `kid`(한 번 다시 받기 후 실패), JWKS 를 못 받을 때 → 모두 401/503 한국어이며 예외 문구에 토큰이 없는가 → Task 2.
6. **웹 쿠키 CSRF**: 쿠키로 오는 `refresh`·`logout`이 `Origin` 없음·허용 목록 밖이면 403 인가 → Task 3.
7. **암호화 우회**: 평문 이메일·`role_arn`·계정 ID·GitHub 로그인·Expo 토큰이 DB 파일 바이트에 남지 않는가, 키 회전 뒤에도 읽히는가 → Task 1, 6, 7, 8.

---

### Task 1: 키 회전·블라인드 인덱스·암호화 열 타입·마스킹

**Files:**
- Modify: `shared/settings.py`, `shared/secrets.py`, `shared/masking.py`, `tests/conftest.py`(테스트 키 `BLIND_INDEX_KEY`·`AUTH_JWT_KEY` 환경변수 — 실제 키 아님 주석), `.env.example`, `README.md`(키 생성 명령: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`, `python -c "import secrets; print(secrets.token_urlsafe(48))"`)
- Create: `shared/crypto_types.py`
- Test: `tests/test_secrets.py`, `tests/test_shared.py`(마스킹)

**Interfaces:**
- Produces (`settings`): `secret_keys_old:str|None` (`SECRET_KEYS_OLD`), `blind_index_key:str|None` (`BLIND_INDEX_KEY`), `auth_enabled:bool=False` (`AUTH_ENABLED`), `auth_jwt_key:str|None` (`AUTH_JWT_KEY`), `auth_access_seconds:int=900`, `auth_refresh_days:int=30`, `auth_pat_default_days:int=30`, `auth_pat_max_days:int=90`, `auth_allowed_emails:str=""` (`AUTH_ALLOWED_EMAILS`, 쉼표), `auth_cookie_secure:bool=False` (`AUTH_COOKIE_SECURE`), `google_client_id_web/_ios/_android:str|None`, `google_jwks_cache_seconds:int=3600`. 파생 `@property google_client_ids -> set[str]`, `auth_allowed_email_set -> set[str]`(소문자).
- Produces (`shared/secrets.py`, 기존 `encrypt_secret`/`decrypt_secret`/`Secret_Error` 시그니처 유지): `secret_fernet() -> MultiFernet`(첫 키 = `SECRET_KEY`, 이어서 `SECRET_KEYS_OLD`), `secret_rotate(token:str) -> str`, `secret_is_encrypted(value:str) -> bool`(복호화 성공 여부, 예외 없음), `blind_index(kind:str, value:str) -> str`(HMAC-SHA256 hex 64자, 입력은 `strip()`, `kind == "email"`이면 `lower()`; 키 없으면 `Secret_Error("BLIND_INDEX_KEY가 설정되지 않았습니다 (.env 확인)")`), `token_hash(token:str) -> str`(SHA-256 hex).
- Produces (`shared/crypto_types.py`): `class Encrypted_Text(TypeDecorator)` — `impl=Text`, `cache_ok=True`, bind 에서 `encrypt_secret`, result 에서 `decrypt_secret`, `None`은 그대로. 이 타입의 열은 `==` 검색에 쓰지 않는다(블라인드 인덱스 열을 쓴다).

- [ ] **Step 1: 실패하는 테스트**
  - `test_secret_rotation_reads_old_key` — 키 A 로 암호화 → `SECRET_KEY=B`, `SECRET_KEYS_OLD=A` → 복호화 성공, `secret_rotate`한 값은 B 만으로 복호화된다. 키 목록에 A 가 없으면 `Secret_Error`(한국어).
  - `test_blind_index_stable_and_normalized` — `blind_index("email"," Me@Example.com ") == blind_index("email","me@example.com")`, `kind`가 다르면 값이 다르고, 키를 바꾸면 값이 다르다, 길이 64. 키 없으면 `Secret_Error`.
  - `test_encrypted_text_roundtrip_and_raw_bytes` — `tmp_path`의 sqlite 동기 엔진에 `Encrypted_Text` 열 하나짜리 표를 만들고 `"owner@example.com"` 저장 → ORM 으로 읽으면 평문, 표를 raw SQL 로 읽으면 `gAAAAA`로 시작, **DB 파일 바이트에 `b"owner@example.com"`이 없다**. `None` 저장·읽기 그대로.
  - `test_secret_is_encrypted` — 암호문 True, `"arn:aws:iam::123456789012:role/x"` False.
  - `test_mask_text_hides_auth_tokens` — `dwr_`·`dwp_` + 43자, `gAAAAA` + 80자 이상 base64url 이 `****`로, 기존 JWT 마스킹 유지, 일반 문장은 그대로.
- [ ] **Step 2:** `.venv/Scripts/python.exe -m pytest tests/test_secrets.py tests/test_shared.py -q` → 새 테스트 실패.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** 같은 명령 → 통과 (기존 `test_secrets.py`도 그대로 통과 — 시그니처 호환).
- [ ] **Step 5:** 커밋 `feat(shared): 키 회전·블라인드 인덱스·암호화 열 타입`.

### Task 2: Google `id_token` 검증 (네트워크 주입)

**Files:**
- Create: `features/auth/__init__.py`, `features/auth/google.py`
- Test: `tests/test_auth_google.py`

**Interfaces:**
- Produces (`google.py`):
  - `class Google_Auth_Error(Exception)` — `message`(한국어), `status_code`(401 또는 503).
  - `class Google_Identity(BaseModel)`: `sub:str`, `email:str`, `name:str|None`, `picture_url:str|None`.
  - `class Google_Verifier` — `__init__(self, fetch_json:Callable[[str], Awaitable[dict]]|None=None, now:Callable[[], float]|None=None)`; `fetch_json` 기본은 httpx GET(타임아웃 10초)→JSON. 메서드 `async verifier_google_verify(self, id_token:str, client_ids:set[str]) -> Google_Identity`. 발견 문서 → `jwks_uri` → JWKS 를 `settings.google_jwks_cache_seconds` 동안 캐시하고, 헤더의 `kid`가 캐시에 없으면 **한 번만** 다시 받는다. 키는 `jwt.PyJWK(jwk).key`, 검증은 `jwt.decode(..., algorithms=["RS256"], audience=list(client_ids), leeway=60)` 뒤 `iss`를 허용 두 값과 직접 비교 (PyJWT 의 `issuer` 목록 지원 여부는 설치 버전 소스로 확인하고, 불확실하면 직접 비교). `email_verified`가 `True`(또는 문자열 `"true"`)가 아니면 401.
  - 모듈 전역 `GOOGLE_VERIFIER=Google_Verifier()` — 테스트는 `monkeypatch`로 바꾼다.
  - 오류 문구: 401 `"Google 로그인 정보를 확인할 수 없습니다. 다시 로그인해 주세요"`, 503 `"Google 로그인 서버에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요"`. **문구·예외에 `id_token`을 넣지 않는다.**

- [ ] **Step 1: 실패하는 테스트** (테스트 안에서 `cryptography`로 RSA 키 2개 생성, 가짜 발견 문서·JWKS 를 돌려주는 `fetch_json`, 토큰은 `jwt.encode(..., algorithm="RS256", headers={"kid": ...})`)
  - `test_google_verify_ok` — 올바른 토큰 → `Google_Identity(sub="1234", email="me@example.com", ...)`. `fetch_json` 호출은 발견 1 + JWKS 1.
  - `test_google_verify_caches_jwks` — 두 번째 검증은 `fetch_json` 0번; 캐시 시간이 지난 뒤(`now` 주입)는 다시 받는다.
  - `test_google_verify_unknown_kid_refetches_once` — 새 `kid`로 서명 → 한 번 다시 받아 성공; 다시 받아도 없으면 401, 세 번째 요청을 하지 않는다.
  - `test_google_verify_rejects` (parametrize) — 다른 키로 서명, `alg=HS256`(공개키 문자열을 비밀로 쓴 토큰), `alg=none`, `aud` 다름, `iss="https://evil.example"`, 만료(`exp` = now-120), `email_verified=False` → 모두 `Google_Auth_Error` 401, `str(e)`에 토큰 문자열이 없다.
  - `test_google_verify_network_failure_503` — `fetch_json`이 `httpx.ConnectError` → 503.
  - `test_google_verify_no_client_ids` — `client_ids=set()` → 503 `"Google 로그인이 아직 설정되지 않았습니다 (GOOGLE_CLIENT_ID_* 확인)"`.
- [ ] **Step 2:** `pytest tests/test_auth_google.py -q` → 실패. **Step 3:** 구현. **Step 4:** 통과. **Step 5:** 커밋 `feat(auth): Google id_token 검증`.

### Task 3: 사용자·리프레시 토큰과 로그인 API (`/api/auth/*`, `/api/me`)

**Files:**
- Create: `features/auth/models.py`, `features/auth/scheme.py`, `features/auth/crud.py`, `features/auth/services.py`, `features/auth/router.py`
- Modify: `main.py`(모델 import, 라우터 등록), `docs/api-spec.md`(새 "Auth" 절)
- Test: `tests/test_auth_api.py`

**Interfaces:**
- Consumes: Task 1 `Encrypted_Text`, `blind_index`, `token_hash`; Task 2 `GOOGLE_VERIFIER.verifier_google_verify`.
- Produces (models):
  - `User` (`users`): `u_id` PK, `google_sub:Encrypted_Text` N, `google_sub_bidx:String(64)` N unique, `email:Encrypted_Text` N, `email_bidx:String(64)` N index, `name:Encrypted_Text`, `picture_url:Encrypted_Text`, `status:String(20)` N 기본 `active` (`# active|deleted`), `last_login_at`, `created_at`, `updated_at`.
  - `Refresh_Token` (`refresh_tokens`): `r_t_id` PK, `u_id` FK→`users.u_id` CASCADE index, `family_id:String(32)` index, `token_hash:String(64)` unique, `platform:String(10)` (`# web|ios|android`), `expires_at`, `revoked_at`, `replaced_by:int|None`, `created_at`.
  - (`notify_email`·`notify_push`는 `users`에 두지 않는다 — 알림 설정은 Task 7 의 사용자별 `notification_settings`. Ruling.)
- Produces (scheme): `Auth_Google_Request(id_token:str, platform:Literal["web","ios","android"])`, `Auth_Refresh_Request(refresh_token:str|None=None)`, `User_Read(u_id, email, name, picture_url)`, `Auth_Token(access_token:str, expires_in:int, refresh_token:str|None, user:User_Read)`.
- Produces (`Auth_Service`, `@staticmethod`):
  - `services_auth_google_login(db, id_token:str, platform:str) -> tuple[Auth_Token, str]` — 검증 → 이메일이 `settings.auth_allowed_email_set`에 없으면 403 `"로그인이 허용된 계정이 아닙니다"` → `google_sub_bidx`로 찾거나 만든다(있으면 email·name·picture 갱신, `last_login_at`) → 새 계열로 토큰 발급. 두 번째 값은 리프레시 원문(라우터가 웹이면 쿠키로).
  - `services_auth_refresh(db, refresh_token:str) -> tuple[Auth_Token, str]` — 해시로 찾음. 없음·만료 → 401 `"로그인이 만료되었습니다. 다시 로그인해 주세요"`. **이미 폐기된 토큰이면 같은 `family_id` 전부 `revoked_at=now` 후 401.** 정상이면 옛 것 폐기·`replaced_by` 기록·같은 계열 새 토큰. 사용자 `status != active`이면 401. 폐기 갱신은 `UPDATE ... WHERE revoked_at IS NULL`의 영향 행 수로 판정해 동시 요청 중 하나만 성공한다.
  - `services_auth_logout(db, refresh_token:str|None) -> None` — 그 계열 폐기. 없거나 모르는 토큰이어도 200(멱등).
  - `services_auth_access_issue(u_id:int, now:datetime|None=None) -> str`, `services_auth_access_decode(token:str) -> int` (u_id; 실패는 401).
  - `services_auth_me(db, u_id:int) -> User_Read`.
- Produces (router `prefix='/api'`): `POST /api/auth/google`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/me`. 웹(`platform=="web"` 또는 쿠키로 온 refresh): 리프레시는 쿠키 `dw_refresh`(`httponly`, `samesite="strict"`, `path="/api/auth"`, `secure=settings.auth_cookie_secure`, `max_age=auth_refresh_days*86400`)로만, 본문 `refresh_token=null`. 앱: 본문에. **쿠키로 온 refresh·logout 은 `Origin` 헤더가 `settings.cors_origin_list`에 있어야 한다(없거나 밖이면 403 `"허용되지 않은 출처입니다"`).** 로그아웃은 쿠키를 지운다.

- [ ] **Step 1: 실패하는 테스트** (`GOOGLE_VERIFIER`를 정해진 `Google_Identity`를 돌려주는 가짜로 교체, 허용 목록 `me@example.com`)
  - `test_auth_google_creates_user_and_tokens` — 앱(`ios`): 200, `refresh_token`이 `dwr_`로 시작, `expires_in == 900`, `user.email == "me@example.com"`; 두 번째 로그인은 같은 `u_id`(사용자 1명). DB 의 `refresh_tokens.token_hash`는 원문과 다르고 64자.
  - `test_auth_google_web_sets_cookie` — `web`: 본문 `refresh_token is None`, `Set-Cookie`에 `dw_refresh=`, `HttpOnly`, `SameSite=strict`, `Path=/api/auth`.
  - `test_auth_google_not_allowed_403` · `test_auth_google_bad_token_401`(가짜가 `Google_Auth_Error` 401).
  - `test_auth_refresh_rotates` — 새 리프레시 발급, 옛 것은 다시 쓰면 401 이고 **새 것도 그 뒤 401**(계열 폐기).
  - `test_auth_refresh_concurrent_only_one_wins` — 같은 토큰으로 `asyncio.gather` 두 요청 → 200 하나, 401 하나.
  - `test_auth_refresh_expired_401` (만료 시각을 과거로 둔 행), `test_auth_logout_revokes_family`.
  - `test_auth_cookie_refresh_origin_check` — 쿠키만 보내고 `Origin` 없음 → 403, `Origin: http://evil.example` → 403, `Origin: http://localhost:5173` → 200.
  - `test_auth_me` — 액세스 토큰으로 `GET /api/me` → `User_Read`; 토큰 없음 401 (이 엔드포인트는 `AUTH_ENABLED`와 무관하게 항상 인증 필요).
  - `test_auth_user_pii_encrypted_at_rest` — 로그인 뒤 raw SQL 로 `users.email`·`google_sub`·`name`이 `gAAAAA`로 시작하고 평문이 아니다.
- [ ] **Step 2:** `pytest tests/test_auth_api.py -q` → 실패. **Step 3:** 구현 + `docs/api-spec.md` Auth 절(엔드포인트 표, `Auth_Token`·`User_Read` 모양, 쿠키·Origin 규칙, 401/403 문구). **Step 4:** 통과. **Step 5:** 커밋 `feat(auth): Google 로그인·토큰 회전·내 정보`.

### Task 4: 현재 사용자 의존성·인증 모드·개인 토큰(MCP)·전 라우트 구조 테스트

**Files:**
- Modify: `features/auth/models.py`(`Api_Token`), `features/auth/scheme.py`, `features/auth/crud.py`, `features/auth/services.py`, `features/auth/router.py`, `main.py`(lifespan 시작 검사), `docs/api-spec.md`
- Create: `scripts/auth_token.py`
- Test: `tests/test_auth_current_user.py`

**Interfaces:**
- Produces (model) `Api_Token` (`api_tokens`): `a_t_id` PK, `u_id` FK CASCADE index, `name:String(50)` N, `token_hash:String(64)` unique, `last4:String(4)`, `expires_at` N, `last_used_at`, `revoked_at`, `created_at`.
- Produces (scheme): `Current_User(u_id:int|None, via:Literal["off","access","pat"])`, `Api_Token_Create(name:str 1~50자, expires_in_days:int|None)`, `Api_Token_Read(a_t_id, name, last4, expires_at, last_used_at, created_at)`, `Api_Token_Issued(Api_Token_Read + token:str)`.
- Produces (`Auth_Service`):
  - `async services_auth_current_user(request:Request, db:AsyncSession=Depends(get_db)) -> Current_User` — **모든 보호 라우트가 `Depends`로 쓰는 단 하나의 함수.** `settings.auth_enabled`가 False 이면 `Current_User(u_id=None, via="off")`(지금 동작 그대로, 필터 없음). True 이면 `Authorization: Bearer` 필수: `dwp_`로 시작하면 PAT(해시 조회, 폐기·만료 401, `last_used_at` 갱신은 1분에 한 번까지), 아니면 액세스 JWT. 사용자 `status != active` → 401. 401 응답에 `WWW-Authenticate: Bearer`.
  - `services_auth_require_user(user:Current_User) -> int` — `u_id`가 None 이면 401 (PAT 관리·`/api/me`처럼 로그인 모드와 무관하게 사용자가 꼭 필요한 곳).
  - `services_auth_token_create(db, u_id:int, data:Api_Token_Create) -> Api_Token_Issued` (기간 기본 `auth_pat_default_days`, 상한 `auth_pat_max_days` 초과 400), `services_auth_token_list(db, u_id) -> list[Api_Token_Read]`, `services_auth_token_revoke(db, u_id, a_t_id) -> dict` (남의 것 404).
  - `services_auth_startup_check() -> None` — `auth_enabled`인데 `AUTH_JWT_KEY`·`BLIND_INDEX_KEY`·`SECRET_KEY` 중 없는 것이 있으면 `RuntimeError("로그인을 켜려면 .env 에 ... 가 필요합니다")`. lifespan 첫 줄에서 부른다.
- Produces (router): `POST /api/auth/tokens` 201 `Api_Token_Issued`(원문은 이 응답에만), `GET /api/auth/tokens`, `DELETE /api/auth/tokens/{a_t_id}`.
- Produces (`scripts/auth_token.py`): `create --email <주소> --name mcp [--days 30]` → 표준 출력에 토큰 한 번, `list --email`, `revoke --id`. 웹 로그인 화면 전에 MCP 토큰을 얻는 길. 사용자 찾기는 `blind_index("email", ...)`. DB 경로는 `settings.db_url`.
- Produces (상수, `features/auth/services.py`): `PUBLIC_PATHS = {"/api/health", "/api/watches/webhook", "/api/accounts/github/callback", "/api/accounts/aws/template", "/api/auth/google", "/api/auth/refresh", "/api/auth/logout"}` (콜백은 Task 6 의 서명된 `state`로 보호, 템플릿은 사용자 정보 없는 정적 파일).

- [ ] **Step 1: 실패하는 테스트**
  - `test_current_user_off_mode` — `auth_enabled=False`: 토큰 없이 `GET /api/deploys` 200 (기존 동작).
  - `test_current_user_on_mode_requires_bearer` — `auth_enabled=True`: 없음·`Bearer garbage`·만료 액세스·`typ`이 다른 JWT·다른 키로 서명 → 401 + `WWW-Authenticate`; 정상 액세스 200.
  - `test_current_user_deleted_user_401` — `status="deleted"` 사용자의 유효한 액세스 토큰 → 401.
  - `test_pat_lifecycle` — 로그인 사용자로 `POST /api/auth/tokens {"name":"mcp"}` → `token`이 `dwp_`로 시작, 목록에는 `last4`만(원문 없음); 그 토큰으로 `GET /api/deploys` 200; 폐기 후 401; `expires_in_days=91` → 400; 남의 `a_t_id` 폐기 → 404.
  - `test_auth_every_route_requires_user` — `app.routes`의 모든 `APIRoute`에 대해 `route.dependant`를 재귀로 훑어 `services_auth_current_user`가 있는지 확인; 없으면 경로가 `PUBLIC_PATHS`에 있어야 한다. 실패 메시지에 빠진 경로 목록.
  - `test_auth_startup_check` — `auth_enabled=True` + `auth_jwt_key=None` → `RuntimeError`, 메시지 한국어; off 면 통과.
  - `test_auth_token_script_create` — `scripts/auth_token.py`의 함수(`script_token_create(email, name, days)`)를 테스트 DB 로 불러 토큰을 받고, 그 토큰이 API 에서 통한다.
- [ ] **Step 2:** `pytest tests/test_auth_current_user.py -q` → 실패. Step 3 에서 **기존 모든 보호 라우터에 `user:Current_User=Depends(Auth_Service.services_auth_current_user)`를 달아** 구조 테스트를 통과시킨다 (소유권 필터는 Task 5~7).
- [ ] **Step 3:** 구현 + `docs/api-spec.md`(인증 공통 절: `AUTH_ENABLED`, Bearer, PAT, 401/404 규칙; 맨 위 "인증 없음(로컬 전용)" 문구 갱신). **Step 4:** `pytest tests/test_auth_current_user.py tests/test_auth_api.py -q` 통과, 기존 API 테스트 한 파일(`tests/test_deploys_api.py`)도 off 모드로 통과. **Step 5:** 커밋 `feat(auth): 현재 사용자 의존성과 MCP 개인 토큰`.

### Task 5: 배포 계열 소유권 (`deploys`·`envvars`·`incidents`·`advice`·`pricing`)

**Files:**
- Modify: `shared/database.py`(`ENSURE_COLUMNS["deploys"]`에 `u_id`, 새 `ENSURE_INDEXES` + `ensure_indexes(conn)`를 `bootstrap_schema`에서 `ensure_columns` 뒤에), `features/deploys/models.py`(`u_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.u_id"), index=True)`), `features/deploys/crud.py`·`services.py`·`router.py`, `features/envvars/router.py`·`services.py`, `features/incidents/crud.py`·`services.py`·`router.py`, `features/advice/router.py`·`services.py`, `features/pricing/router.py`, `features/accounts/services.py`(소유 확인 함수만 — 아래), `docs/api-spec.md`
- Create: `shared/ownership.py`
- Test: `tests/test_ownership_deploys.py`, `tests/test_ensure_columns.py`(인덱스)

**Interfaces:**
- Consumes: Task 4 `Current_User`, 테스트 헬퍼(이 Task 에서 `tests/auth_helpers.py`에 만든다: `async make_user(db, email) -> int`, `auth_header(u_id) -> dict`).
- Produces:
  - `shared/ownership.py`: `owner_where(stmt, column, u_id:int|None)` — `u_id`가 None(인증 끔)이면 그대로, 아니면 `.where(column == u_id)`. **인증 켬 모드에서 None 이 오는 길은 없다** (Task 4 가 보장, 이 Task 테스트가 확인).
  - `ENSURE_INDEXES: dict[str, list[tuple[str, list[str], bool]]]` (이름, 열, unique) — 예 `("ix_deploys_u_id", ["u_id"], False)`. 표가 없으면 건너뛴다. 여러 번 안전.
  - `Deploy_Crud` 조회 함수에 `u_id:int|None=None` 인자(`crud_deploy_get_all`, `crud_deploy_get_by_d_id`). 백그라운드(파이프라인·헬스·감시·복구)는 인자 없이 부른다 → 변화 없음.
  - `Deploy_Service.services_deploy_get_owned(db, d_id:int, u_id:int|None) -> Deploy` — 없거나 남의 것 404 `"해당 id의 배포가 없습니다"`. `d_id`를 받는 모든 배포·환경변수·인시던트 라우트가 이것으로 먼저 확인한다.
  - 이 Task 가 `aws_accounts`·`github_installations`·`connections`에도 `u_id`(FK `users.u_id`, index) 열과 `ENSURE_COLUMNS`·`ENSURE_INDEXES` 줄을 더한다 (아래 확인 함수가 필요로 해서; 라우터 필터는 Task 6).
  - 생성(`services_deploy_create`)은 `u_id`를 저장하고, 본문의 `aws_account_id`·`github_installation_id`를 `Aws_Account_Service.services_aws_account_assert_owned(db, a_id, u_id)`·`Github_Service.services_github_assert_owned(db, g_id, u_id)`(이 Task 에서 `features/accounts/services.py`에 만든다, `u_id` None 이면 존재만 확인)로 확인 — 남의 것·없음 404.
  - `advice`·`GET /deploys/remote`도 같은 확인. `incidents` 목록은 `deploys`와 조인해 `Deploy.u_id`로 거른다(`incidents`에 `u_id`를 두지 않는다 — Ruling: 자식 표는 부모로 따라간다). `pricing`은 사용자 데이터가 없어 의존성만(인증 켬이면 로그인 필요).
- [ ] **Step 1: 실패하는 테스트** (`auth_enabled=True`, 사용자 A·B)
  - `test_ownership_deploy_list_only_mine` — A 배포 2, B 배포 1 → A 목록 2, B 목록 1.
  - `test_ownership_deploy_routes_404_for_other` (parametrize: `GET /{d_id}`, `/logs`, `/issues`, `/health`, `/health-history`, `PATCH /settings`, `POST /redeploy`, `/env/continue`, `/stop`, `/start`, `DELETE`, `GET /{d_id}/env`, `PUT /{d_id}/env/X`, `DELETE /{d_id}/env/X/value`, `GET /deploys/{d_id}/incidents`, `GET /incidents/{i_id}`) — B 의 토큰으로 A 의 id → 404, 파이프라인·AWS 가짜가 한 번도 불리지 않는다.
  - `test_ownership_create_with_others_account_404` — B 가 A 의 `aws_account_id`·`github_installation_id`로 `POST /api/deploys`·`/api/deploys/advice`·`GET /api/deploys/remote` → 404, 배포 행이 생기지 않는다.
  - `test_ownership_create_sets_u_id` — 만든 배포의 `u_id == A`.
  - `test_ownership_off_mode_unchanged` — off 모드에서 `u_id` null 배포가 전부 보인다.
  - `test_ownership_table_coverage` — `Base.metadata.tables`의 모든 표가 (a) `u_id` 열을 갖거나 (b) FK 사슬로 그런 표에 닿는다 (`users` 자신 제외). 새 표를 만들고 소유권을 잊으면 실패한다.
  - `test_ensure_indexes_on_old_db` — 옛 모양 `deploys`에서 `bootstrap` 후 `u_id` 열·`ix_deploys_u_id` 인덱스가 생기고 두 번째는 아무것도 안 한다.
- [ ] **Step 2:** `pytest tests/test_ownership_deploys.py tests/test_ensure_columns.py -q` → 실패. **Step 3:** 구현 + `docs/api-spec.md`(각 절에 "남의 것은 404"). **Step 4:** 위 + `tests/test_deploys_api.py tests/test_incident_api.py tests/test_envvars_api.py tests/test_advice.py -q` 통과. **Step 5:** 커밋 `feat(deploys): 배포·환경변수·인시던트 소유권`.

### Task 6: 계정 연결 소유권과 연결 정보 암호화 (`accounts`)

**Files:**
- Modify: `features/accounts/models.py`(`role_arn`·`aws_account_id`→`Encrypted_Text`, `account_login`→`Encrypted_Text`; `u_id`는 Task 5 에서 생김), `features/accounts/crud.py`·`services.py`·`router.py`, `docs/api-spec.md`
- Test: `tests/test_ownership_accounts.py`

**Interfaces:**
- Consumes: Task 5 `owner_where`, `services_*_assert_owned`.
- Produces:
  - 모든 `/api/accounts/aws*`, `/connections*`, `/github*` 라우트가 `u_id`로 걸러지고 남의 id 는 404. 생성은 `u_id`를 저장. `POST /connections/{c_id}/aws`, `PATCH /connections/{c_id}`의 대상 계정·설치도 소유 확인.
  - GitHub 설치 `state`: `services_github_install_url(c_id:int|None, u_id:int|None) -> str` — `state`를 `AUTH_JWT_KEY`로 서명한 짧은 JWT(`typ="gh_state"`, `u`, `c`, 15분)로 바꾼다. 인증 끔 모드에서도 같은 형식(`u=None`). 콜백은 `state`를 검증해 설치를 그 `u`에게 주고 `c`가 그 사용자 블록이면 잇는다. 서명 불량·만료 → 설치를 저장하지 않고 `/accounts?connected=github_error`로 보낸다. **이미 다른 사용자가 가진 `installation_id`면 409 대신 `/accounts?connected=github_taken`으로 보낸다**(브라우저 리다이렉트라서; Ruling).
  - `installation_id`는 평문 유지(웹훅이 이 값으로 찾는다, 개인 정보 아님 — Ruling).
  - API 응답의 `role_arn`·`aws_account_id`는 지금처럼 주인에게만 보인다 (필드 변화 없음).
- [ ] **Step 1: 실패하는 테스트**
  - `test_accounts_routes_404_for_other` (parametrize: aws `GET/PATCH role-arn/POST reverify/GET template-status/DELETE template-files/DELETE`, `PATCH/DELETE /connections/{c_id}`, `POST /connections/{c_id}/aws`, `GET /github/{g_id}/check`, `/repositories`, `DELETE /github/{g_id}`) — 404, AWS·GitHub 가짜 0번.
  - `test_accounts_lists_only_mine` — 세 목록 모두.
  - `test_github_callback_signed_state` — A 의 install-url 에서 꺼낸 `state`로 콜백 → 설치 `u_id == A`, 블록에 이어짐; 위조 `state`·만료 → 설치 없음, `github_error`로 리다이렉트; 숫자만 있는 옛 형식 `state=5` → 거절.
  - `test_github_callback_taken_by_other` — B 소유 `installation_id`로 A 가 콜백 → 소유자 바뀌지 않음, `github_taken`.
  - `test_accounts_fields_encrypted_at_rest` — raw SQL 로 `role_arn`·`aws_account_id`·`account_login`이 암호문, ORM·API 로는 평문.
- [ ] **Step 2:** `pytest tests/test_ownership_accounts.py -q` → 실패. **Step 3:** 구현 + `docs/api-spec.md`. **Step 4:** 위 + `tests/test_accounts_api.py -q` 통과. **Step 5:** 커밋 `feat(accounts): 연결 소유권·서명된 설치 state·연결 정보 암호화`.

### Task 7: 알림의 사용자별 수신 (`notifications`)

**Files:**
- Modify: `features/notifications/models.py`(`Notification_Setting.u_id` nullable unique, `id`의 `default=1` 제거; `Push_Device.expo_token`→`Encrypted_Text` + `expo_token_bidx:String(64)` unique, 기존 `unique=True` 제거), `shared/database.py`(`ENSURE_COLUMNS`: `notification_settings.u_id`, `push_devices.expo_token_bidx`; `ENSURE_INDEXES`: `ix_notification_settings_u_id`(unique), `ix_push_devices_expo_token_bidx`(unique)), `features/notifications/crud.py`·`services.py`·`inbox.py`·`dispatch.py`·`router.py`, `docs/api-spec.md`
- Test: `tests/test_notification_owner.py`

**Interfaces:**
- Consumes: `Auth_Service.services_auth_user_email(db, u_id:int) -> str|None` (이 Task 에서 `features/auth/services.py`에 추가, 활성 사용자의 복호화된 이메일).
- Produces:
  - `crud_notification_setting_get(db, u_id:int|None)` — `None`이면 지금의 `id=1` 줄(없으면 `id=1, u_id=None`으로 만든다), 값이 있으면 그 사용자 줄(없으면 만든다). `/api/notifications/settings`는 현재 사용자 것.
  - 앱 안 알림 목록·읽지 않은 수·읽음 표시·모두 읽음은 `u_id`로 거른다(남의 `n_id` 404). `inbox.py`의 "3단계에서 거른다" 주석을 실제 필터로.
  - 기기: `POST /api/devices`는 `u_id`와 `expo_token_bidx = blind_index("expo_token", token)`를 저장하고 조회·삭제는 bidx 로. 같은 토큰을 다른 사용자가 등록하면 그 사용자로 옮긴다(기기 주인이 바뀐 것; Ruling). 남의 `p_d_id` 삭제 404.
  - 발송: `services_notification_deploy_fire`·인시던트 알림은 대상 배포의 `u_id`를 알림 줄에 넣고, 그 사용자의 설정·기기·이메일(`services_auth_user_email`)로 보낸다. `u_id`가 None(옛 배포·인증 끔)이면 지금처럼 `id=1` 설정, 전체 기기, `MAIL_TO`. 이메일 주소는 로그·알림 `error`에 싣지 않는다(`mask_text` 후 저장 유지).
- [ ] **Step 1: 실패하는 테스트**
  - `test_notification_inbox_isolated` — A 배포 알림은 A 목록·수에만, B 가 A 의 `n_id` 읽음 → 404.
  - `test_notification_settings_per_user` — A 가 끈 종류가 B 설정에 영향 없음; off 모드는 `id=1` 줄.
  - `test_notification_fire_targets_owner` — 가짜 mailer·pusher: A 배포 실패 알림이 A 이메일·A 기기로만, B 기기로 가지 않는다; `u_id` None 배포는 `MAIL_TO`·전체 기기.
  - `test_device_token_encrypted_and_lookup` — raw 값은 암호문, 같은 토큰 재등록은 갱신(행 1개), 무효 토큰 정리(`delete_by_tokens`)가 bidx 로 동작.
  - `test_device_moves_to_new_user` — A 가 등록한 토큰을 B 가 등록 → 행 1개, `u_id == B`.
- [ ] **Step 2:** `pytest tests/test_notification_owner.py -q` → 실패. **Step 3:** 구현 + `docs/api-spec.md`. **Step 4:** 위 + `tests/test_notifications.py tests/test_notification_api.py tests/test_notification_dispatch.py tests/test_notification_hooks.py tests/test_notification_migration.py -q` 통과. **Step 5:** 커밋 `feat(notifications): 사용자별 알림·기기·설정`.

### Task 8: 기존 DB 이전 스크립트와 시작 검사 (백업 → 암호화 → 주인 지정)

**Files:**
- Create: `shared/migrate.py`, `scripts/migrate_login.py`
- Modify: `main.py`(lifespan: `bootstrap_schema` 뒤 평문 검사), `README.md`(이전 절차·되돌리기·키 백업), `docs/architecture.md`(키와 백업 절)
- Test: `tests/test_migrate_login.py`

**Interfaces:**
- Produces (`shared/migrate.py`, 모두 동기 `conn`/경로를 받는다 — `run_sync`로 쓴다):
  - `migrate_backup(db_path:Path, backup_dir:Path, now:datetime|None=None) -> Path` — `sqlite3` 백업 API 로 `wizard-YYYYmmdd-HHMMSS.db` 사본을 만들고 사본을 열어 `PRAGMA integrity_check == "ok"`를 확인한 뒤 경로를 돌려준다. 실패하면 예외(이전 단계로 넘어가지 않는다).
  - `migrate_encrypted_columns() -> list[tuple[str, str]]` — `Base.metadata`에서 `Encrypted_Text` 타입 열(표, 열) 목록.
  - `migrate_plaintext_count(conn) -> dict[str, int]` — 열마다 값이 있고 `secret_is_encrypted`가 False 인 행 수 (raw SQL).
  - `migrate_encrypt_plaintext(conn, dry_run:bool=True) -> dict[str, int]` — 평문인 값만 `encrypt_secret`으로 바꾼다(이미 암호문은 건드리지 않음 → 여러 번 안전).
  - `migrate_rotate(conn, dry_run:bool=True) -> dict[str, int]` — 모든 암호문을 `secret_rotate`로 새 키로.
  - `migrate_assign_owner(conn, u_id:int, dry_run:bool=True) -> dict[str, int]` — `u_id` 열이 있는 모든 표(`users`·`refresh_tokens`·`api_tokens` 제외)에서 `u_id IS NULL`인 행만 그 사용자로. 이미 주인 있는 행은 그대로.
  - `migrate_check_startup(conn) -> None` — 평문이 하나라도 있으면 `RuntimeError("암호화 전 값이 N건 있습니다. 서버를 끄고 python scripts/migrate_login.py backup → encrypt --yes 를 실행하세요")`.
- Produces (`scripts/migrate_login.py`, 기본은 보기만, `--yes`일 때만 씀, 쓰기 전 항상 백업을 먼저 만든다): `backup`, `status`(열마다 평문 수, `u_id` 없는 행 수), `encrypt [--yes]`(+ `push_devices.expo_token_bidx` 채우기), `assign-owner --email <주소> [--yes]`(사용자는 `email_bidx`로 찾음, 없으면 "먼저 그 계정으로 한 번 로그인하세요"), `rotate-keys [--yes]`, `restore --from <백업> [--yes]`(서버가 꺼져 있어야 함을 안내하고 파일을 되돌린다; `:8081` 리스너가 있으면 거절). 출력에 값 원문·토큰을 싣지 않는다(개수만).
- [ ] **Step 1: 실패하는 테스트** (`tmp_path`에 **지금 모양의 옛 DB**를 만든다: `aws_accounts`에 평문 `role_arn`·계정 ID, `github_installations`에 평문 `account_login`, `push_devices` 평문 토큰, `u_id` 열 없는 `deploys`·`connections`, `notification_settings` `id=1`)
  - `test_migrate_backup_is_openable` — 사본이 있고 `integrity_check` ok, 원본 행 수와 같다.
  - `test_migrate_full_flow_on_old_db` — `bootstrap`(열·인덱스 추가) → `status`가 평문 수를 센다 → `encrypt(dry_run=True)`는 바꾸지 않는다 → `encrypt(dry_run=False)` 후 평문 0, ORM 으로 원래 값이 읽힌다, **파일 바이트에 원래 `role_arn`·로그인 이름이 없다** → 다시 `encrypt` 해도 0건(이중 암호화 없음).
  - `test_migrate_assign_owner_only_nulls` — 주인 없는 배포·연결·계정·설치·알림·기기·`notification_settings id=1` 모두 주인 지정, 미리 B 가 주인인 행은 그대로.
  - `test_migrate_rotate_keys` — 키 A 로 암호화 → `SECRET_KEY=B, SECRET_KEYS_OLD=A`로 `rotate` → `SECRET_KEYS_OLD` 없이도 읽힌다.
  - `test_startup_refuses_plaintext` — 평문이 남은 DB 에서 `migrate_check_startup`이 한국어 `RuntimeError`; 암호화 후 통과; 새 DB(빈 표)는 통과.
  - `test_migrate_script_requires_yes` — `--yes` 없이 `encrypt`·`assign-owner`를 부르면 DB 가 바뀌지 않는다 (스크립트 진입 함수를 직접 호출).
- [ ] **Step 2:** `pytest tests/test_migrate_login.py -q` → 실패. **Step 3:** 구현 + README(순서: 서버 끄기 → `backup` → `status` → `encrypt --yes` → 서버 켜기·로그인 → `assign-owner --yes` → `AUTH_ENABLED=true`; 되돌리기 = `restore --from`; 키 백업 경고). **Step 4:** 통과. **Step 5:** 커밋 `feat(shared): 로그인 이전 스크립트와 평문 시작 검사`.

### Task 9: 계정 삭제 (`DELETE /api/me`, A-04)

**Files:**
- Modify: `features/auth/services.py`·`router.py`·`scheme.py`, `features/deploys/services.py`(살아 있는 배포 목록 함수), `features/accounts/services.py`(사용자 연결 기록 삭제 함수), `features/notifications/services.py`(사용자 알림·기기·설정 삭제 함수), `docs/api-spec.md`
- Test: `tests/test_auth_delete.py`

**Interfaces:**
- Consumes: 각 기능 services 의 새 함수 — `Deploy_Service.services_deploy_live_for_user(db, u_id) -> list[Deploy]`(`running`·진행 중·`needs_input`·`service_arn`이 남은 `failed`; MCP 의 "살아 있는" 정의와 같게), `Deploy_Service.services_deploy_forget_user(db, u_id) -> int`, `Aws_Account_Service.services_account_forget_user(db, u_id) -> int`, `Notification_Service.services_notification_forget_user(db, u_id) -> int`. 모두 flush 만, commit 은 `Auth_Service`가 한 번.
- Produces: `DELETE /api/me` 본문 `{"confirm": true}`. `confirm`이 아니면 400. 살아 있는 배포가 있으면 409 `{"detail": "먼저 멈추거나 삭제해야 하는 서비스가 있습니다", ...}` + 배포 `d_id`·`service_name` 목록(FastAPI `detail`에 dict 를 쓰는 기존 관례가 없으면 `detail` 문자열에 이름 나열). 아니면 사용자 행을 `status="deleted"`로 두고 개인 정보를 지운다: `name`·`picture_url`은 NULL, NOT NULL 인 `google_sub`·`email`은 상수 `"deleted"`(암호화되어 저장), `google_sub_bidx`·`email_bidx`는 `blind_index("deleted", str(u_id))`로 바꿔 같은 Google 계정이 새 사용자로 다시 가입할 수 있게 한다. 리프레시·PAT 폐기, 연결·계정·설치 **기록만** 지움(AWS 스택·GitHub 앱 설치는 지우지 않는다 — 응답 `message`에 "AWS CloudFormation 스택과 GitHub 앱 설치는 직접 지워 주세요"), 남은 배포 기록(`stopped`·`deleted`·서비스 없는 `failed`)·알림·기기·설정 삭제. **AWS 호출 0번.**
- [ ] **Step 1: 실패하는 테스트**
  - `test_delete_me_requires_confirm` (400), `test_delete_me_blocked_by_live_deploy` (409, 목록에 `d_id`, 아무것도 안 지워짐).
  - `test_delete_me_forgets_records_only` — 멈춘 배포·연결·알림이 있는 사용자 삭제 → 200, 그 행들 없음, AWS·GitHub 가짜 0번, 기존 액세스·리프레시·PAT 모두 401, 같은 Google 계정으로 다시 로그인하면 새 사용자(이전 기록 없음).
  - `test_delete_me_leaves_other_user` — B 의 데이터 그대로.
- [ ] **Step 2:** `pytest tests/test_auth_delete.py -q` → 실패. **Step 3:** 구현 + `docs/api-spec.md`. **Step 4:** 통과. **Step 5:** 커밋 `feat(auth): 계정 삭제 (기록만, AWS 는 건드리지 않음)`.

### Task 10: MCP 토큰 안내·문서·전체 확인

**Files:**
- Modify: `features/mcp/client.py`(401 을 한국어로: `"배포 마법사 로그인 토큰이 없거나 만료되었습니다. python scripts/auth_token.py create --email <주소> --name mcp 로 만들어 WIZARD_API_TOKEN 에 넣으세요"`, 404 는 기존대로), `README.md`(MCP 등록에 `WIZARD_API_TOKEN` 줄), `docs/architecture.md`(`auth` 기능, 토큰 흐름 웹·앱·MCP, 소유권 규칙, `AUTH_ENABLED` 전환), `docs/features.md`(`auth` 행), `docs/app-web/04-api-spec.md`(§0·§1 을 구현과 맞춤: `PATCH /api/me/settings` 대신 기존 알림 설정, PAT 엔드포인트, `github_taken`), `docs/app-web/03-db-erd.md`(`users` 열 변경: 블라인드 인덱스, `notify_*` 제거, `api_tokens`, `notification_settings.u_id`), `docs/superpowers/specs/2026-11-16-mcp-design.md` §6 상태 한 줄, `docs/milestones.md`, `docs/worklog/2026-11-17.md`(영문 간결), `HISTORY.md` 한 줄
- Test: `tests/test_mcp.py`(401 문구)

- [ ] **Step 1:** `test_mcp_client_401_message` — `MockTransport` 401 → `Wizard_Error` 메시지에 `auth_token.py`, 토큰 원문 없음. 실패 확인 → 구현 → `pytest tests/test_mcp.py -q` 통과.
- [ ] **Step 2:** 문서 갱신.
- [ ] **Step 3:** 전체 테스트 한 번 `.venv/Scripts/python.exe -m pytest -q` — 기존 통과 수 + 새 테스트 모두 통과(off 모드 기본이라 기존 테스트는 바뀌지 않아야 한다). 실패 시 출력 보고(`tests/test_watches.py` 불안정이면 단독 재실행 결과도).
- [ ] **Step 4:** 전체 브랜치 서브에이전트 리뷰(기본 방식, Review Focus 7개를 리뷰어에게 준다) → 지적 수정 → 커밋 `docs: 로그인 백엔드 문서`.
- [ ] **Step 5:** `test`에 `--no-ff` 병합, 브랜치 삭제, push 하지 않음. 실제 `data/wizard.db` 이전(O4)은 하지 않고 소유자에게 남긴다.

---

## 이 계획에서 내가 정한 것 (Ruling)

1. `AUTH_ENABLED` 기본 false — 웹·앱 로그인 화면 계획 전까지 지금 동작 유지. 켜는 것은 O4 이후.
2. 소유권 열은 최상위 표에만, 자식 표(`deploy_logs`·`deploy_issues`·`deploy_releases`·`deploy_env_vars`·`health_checks`·`incidents`·`recovery_actions`)는 부모를 따라간다. 커버리지 테스트가 빠짐을 막는다.
3. MCP stdio 는 개인 토큰(PAT, `dwp_`, 최대 90일)을 `WIZARD_API_TOKEN`으로 — 장치 코드 흐름·OAuth 2.1 은 원격 MCP(3단계)에서.
4. 서버는 Google 클라이언트 시크릿을 쓰지 않는다(`id_token`만 검증).
5. 리프레시·PAT 는 SHA-256 해시(고엔트로피라 HMAC 불필요), 사용자 찾기는 HMAC 블라인드 인덱스(별도 키).
6. GitHub `installation_id`·배포의 `image_uri`/`service_arn`(계정 ID 포함)은 평문 유지 — 검색·AWS 호출에 쓰이고, 응답 노출은 주인에게만.
7. 알림 설정은 `users`가 아니라 사용자별 `notification_settings` 줄.

## 열린 소유자 결정 (계획 실행 전·중에 소유자가 정할 것 — 정해지기 전에는 위 기본값)

| # | 결정 | 기본값(추천) | 다른 선택 |
|---|---|---|---|
| D-L1 | 누가 로그인할 수 있나 | `AUTH_ALLOWED_EMAILS` 허용 목록만 (비면 아무도 못 함) | 누구나 가입 (호스팅·격리 빌더·한도 전에는 위험) |
| D-L2 | 기존 데이터(주인 없는 배포·연결·계정)를 누구에게 | `assign-owner --email` 스크립트로 소유자가 직접 | 지정한 이메일의 첫 로그인 때 자동 |
| D-L3 | 토큰 수명 | 액세스 15분 · 리프레시 30일 · PAT 기본 30일/최대 90일 | 리프레시 7일 / PAT 만료 없음 |
| D-L4 | 계정 삭제(Task 9)를 이번에 넣을지 | 넣는다 (스토어 요구, AWS 는 안 건드림) | 앱 출시 계획으로 미룸 |
| D-L5 | 이전 실행(O4)을 언제, 누가 | 병합 후 소유자 승인 하에 에이전트가 단계별로 (매 단계 결과 보고) | 소유자가 직접 실행 |
| D-L6 | 상용 단계 키 보관 | 지금은 `.env` + 소유자 백업, 호스팅 때 KMS/Secrets Manager (별도 계획, 비용 발생) | 지금부터 Secrets Manager |
