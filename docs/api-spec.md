# API 스펙

Base URL: `http://localhost:8081` · 전부 JSON · 인증은 `AUTH_ENABLED`에 따른다(기본 `false` = 지금처럼 인증 없음, 로컬 전용. 아래 "인증 공통") · 대화형 문서 `/docs`

에러는 FastAPI 기본 형태다. `detail`은 한국어이며 화면에 그대로 보여 준다.

```json
{ "detail": "해당 id의 배포가 없습니다" }
```

## 인증 공통 (로그인 계획 Task 4)

- **`AUTH_ENABLED=false` (기본)**: 지금처럼 토큰 없이 모든 API 가 동작한다(소유권 필터 없음). 웹·앱·MCP stdio 서버가 로그인 화면 전까지 그대로 쓴다. 보내온 `Authorization` 헤더는 무시한다 — 단 `/api/me`·`/api/auth/tokens*`는 꺼진 모드에서도 로그인 사용자가 있어야 한다.
- **`AUTH_ENABLED=true`**: 아래 공개 경로를 뺀 모든 `/api/*`에 `Authorization: Bearer <토큰>`이 필요하다. 토큰은 액세스 JWT(`POST /api/auth/google`·`/refresh`가 준 것) 또는 개인 토큰(`dwp_…`, MCP 용). 사용자가 없거나 `active`가 아니면 401. 개인 토큰은 사용자의 이메일이 `AUTH_ALLOWED_EMAILS`에 아직 있어야 한다.
- `SECRET_KEY`·`BLIND_INDEX_KEY`는 **어느 모드에서나** `.env`에 있어야 한다(암호화 열·블라인드 인덱스를 늘 쓴다). 없으면 서버가 시작하지 않는다(`서버를 시작하려면 .env 에 … 가 필요합니다` + 생성 명령). 켤 때는 `AUTH_JWT_KEY`도 있어야 한다(`로그인을 켜려면 .env 에 AUTH_JWT_KEY 가 필요합니다`).
- **공개 경로** (`features/auth/services.py`의 `PUBLIC_PATHS`): `/api/health`, `/api/watches/webhook`(서명 검증), `/api/accounts/github/callback`(서명된 `state`로 보호, 아래 Accounts), `/api/accounts/aws/template`(사용자 정보 없는 정적 파일), `/api/auth/google`, `/api/auth/refresh`, `/api/auth/logout`. 그 밖의 경로는 `tests/test_auth_current_user.py`가 모든 라우트를 훑어 인증 의존성이 걸려 있는지 확인한다 — 새 라우트도 빠지면 시험이 실패한다.
- 401 응답에는 언제나 `WWW-Authenticate: Bearer` 헤더가 붙고 `detail`은 `로그인이 필요합니다`. 남의 자원은 403 이 아니라 **404**(존재를 숨긴다).

### 소유권 (로그인 계획 Task 5)

- 최상위 표(`deploys`·`aws_accounts`·`github_installations`·`connections`·`notifications`·`push_devices`·`notification_settings`)에 주인 `u_id`가 있다 (알림 쪽은 Task 7, 아래 Notifications). 자식 표(로그·이슈·릴리스·환경변수·헬스·인시던트·복구 시도)는 부모 배포를 따라간다.
- `AUTH_ENABLED=true`: 목록은 내 것만, `d_id`·`i_id`를 받는 경로는 남의 것이면 없는 것과 같이 **404**. 배포 만들기·분석·브랜치 조회 본문의 `aws_account_id`·`github_installation_id`도 내 것이어야 한다 (남의 것·없는 것 404, 그 자격증명은 쓰이지 않는다). 새 배포의 주인은 만든 사용자.
- `AUTH_ENABLED=false`: 주인을 보지 않는다 (주인 없는 옛 기록도 전부 보인다). 단 본문의 `aws_account_id`·`github_installation_id`는 있는 것이어야 한다 (없으면 404).
- 서버 안 백그라운드(파이프라인·헬스 점검·감시·자동 복구)는 주인과 상관없이 모든 배포를 다룬다.
- 계정 라우터(`/api/accounts/*`, 로그인 계획 Task 6): `AUTH_ENABLED=true`면 AWS 계정·GitHub 설치·연결 블록 목록은 내 것만, `a_id`·`g_id`·`c_id`를 받는 경로는 남의 것이면 **404** — AWS(AssumeRole·S3·IAM)·GitHub 호출 전에 막는다. 블록에 잇는 계정·설치(`PATCH /connections/{c_id}` 본문)도 내 것이어야 한다. 새로 만든 계정·블록·설치의 주인은 만든 사용자. 공개로 남는 것은 `/aws/template`(정적 파일)과 `/github/callback`(서명된 `state`).
- 연결 정보 암호화: `aws_accounts.role_arn`·`aws_accounts.aws_account_id`·`github_installations.account_login`은 DB 에 Fernet 암호문으로 저장된다(`Encrypted_Text`). API 응답은 지금처럼 주인에게만 평문으로 보인다(필드 변화 없음). `installation_id`는 평문(웹훅·콜백이 이 값으로 찾는다). 이전 전 평문이 남은 DB 를 읽으면 `암호화 전 값이 DB 에 남아 있습니다. 서버를 끄고 python scripts/migrate_login.py backup → encrypt --yes 를 실행하세요` 오류가 난다(값을 섞어 읽지 않는다).

### 개인 토큰 (PAT, MCP 용)

| Method | Endpoint | 설명 | 성공 |
|--------|----------|------|------|
| POST | `/api/auth/tokens` | 본문 `Api_Token_Create`. 원문 `token`은 이 응답에만 나간다. 로그인(액세스 토큰)으로만 — 개인 토큰으로 부르면 403 | 201 `Api_Token_Issued` |
| GET | `/api/auth/tokens` | 내 토큰 중 폐기 전 것 (만료된 것 포함), 최근 것부터. 원문 없이 끝 4자리만 | 200 `list[Api_Token_Read]` |
| DELETE | `/api/auth/tokens/{a_t_id}` | 폐기. 남의 것·없는 것·이미 폐기한 것은 404 | 200 `{"message": "개인 토큰을 폐기했습니다"}` |

- `Api_Token_Create`: `{ "name": "mcp", "expires_in_days": 30 }` — `name` 앞뒤 공백 제거 후 1~50자(밖이면 422), `expires_in_days`는 생략하면 `AUTH_PAT_DEFAULT_DAYS`(30), 1 미만 422, `AUTH_PAT_MAX_DAYS`(90) 초과 400 `개인 토큰 기간은 최대 90일입니다`.
- `Api_Token_Read`: `{ "a_t_id": 1, "name": "mcp", "last4": "AbCd", "expires_at": "…", "last_used_at": null, "created_at": "…" }` · `Api_Token_Issued` = `Api_Token_Read` + `"token": "dwp_…"`.
- 서버는 SHA-256 해시와 끝 4자리만 저장한다. `last_used_at`은 1분에 한 번까지만 갱신한다. 폐기·만료된 토큰은 401.
- 웹 로그인 화면 전에 MCP 토큰 받기: `python scripts/auth_token.py create --email <주소> --name mcp [--days 30]` (표준 출력에 원문 한 번) · `list --email <주소>` · `revoke --id <a_t_id>`. DB 는 `DB_URL`. 사용자는 먼저 Google 로그인으로 만들어져 있어야 한다. MCP 서버는 `.env`(또는 MCP 등록의 `-e WIZARD_API_TOKEN=…`)의 `WIZARD_API_TOKEN`에 이 토큰을 두면 Bearer 로 보낸다. 로그인이 켜진 서버가 401 을 내면 MCP 는 `배포 마법사 로그인 토큰이 없거나 만료되었습니다. python scripts/auth_token.py create --email <주소> --name mcp 로 만들어 WIZARD_API_TOKEN 에 넣으세요` 로 안내한다 (토큰 원문은 싣지 않는다). 로그인이 꺼진 서버는 토큰이 없어도 그대로 동작한다.

## Auth (로그인 - 백엔드, 실제 Google 로그인 미확인)

Google `id_token`으로 로그인해 액세스 토큰(JWT, 900초)과 리프레시 토큰(`dwr_…`, 30일, 회전)을 받는다. 로그인은 `AUTH_ALLOWED_EMAILS`(쉼표)에 있는 이메일만 된다. 다른 라우터의 인증은 위 "인증 공통"을 따른다.

| Method | Endpoint | 설명 | 성공 |
|--------|----------|------|------|
| POST | `/api/auth/google` | 본문 `{id_token, platform}`. Google 서명·`aud`(그 플랫폼의 클라이언트 ID)·`iss`·`exp`·`email_verified` 검증 → 사용자를 찾거나(`google_sub`) 만들고 새 계열로 토큰 발급. 있는 사용자는 이메일·이름·사진을 갱신 | 200 `Auth_Token` |
| POST | `/api/auth/refresh` | 본문 `{refresh_token}`(앱) 또는 쿠키 `dw_refresh`(웹, 본문 생략·`null`). 쓴 토큰은 폐기하고 같은 계열의 새 토큰 발급. **이미 폐기된 토큰이 다시 오면 그 계열 전체를 폐기하고 401.** 같은 토큰으로 동시에 두 번 오면 하나만 200 | 200 `Auth_Token` |
| POST | `/api/auth/logout` | 그 토큰의 계열 폐기 + 쿠키 삭제. 토큰이 없거나 몰라도 200 | 200 `{"message": "로그아웃했습니다"}` |
| GET | `/api/me` | 헤더 `Authorization: Bearer <액세스 토큰 또는 개인 토큰>` 필수 (`AUTH_ENABLED`와 무관) | 200 `User_Read` |
| DELETE | `/api/me` | 계정 삭제 (A-04) - 본문 `{"confirm": true}` 필수. 로그인(액세스 토큰)으로만, 개인 토큰은 403. 아래 "DELETE /api/me" | 200 `Auth_Delete_Read` |

- `platform`: `web` | `android`. 그 밖(`ios` 포함)은 422. 플랫폼마다 `aud`가 다르다 — `web`은 `GOOGLE_CLIENT_ID_WEB`, `android`는 `GOOGLE_CLIENT_ID_ANDROID`만 받는다. iOS 는 `features/auth/scheme.py`의 `LOGIN_PLATFORMS`에 한 줄 + `GOOGLE_CLIENT_ID_IOS` 설정 + 푸시 기기용 `SUPPORTED_PUSH_PLATFORMS`(`features/notifications/scheme.py`)로 더한다.
- **웹 (`platform="web"` 또는 쿠키로 온 refresh)**: 리프레시는 본문에 싣지 않고(`refresh_token: null`) `Set-Cookie: dw_refresh=…; HttpOnly; SameSite=strict; Path=/api/auth; Max-Age=2592000`(`AUTH_COOKIE_SECURE=true`이면 `Secure`). **앱**: 본문 `refresh_token`에 싣고, 앱이 안전한 저장소에 둔다.
- **쿠키로 온 refresh·logout 과 `platform="web"` 로그인은 `Origin` 헤더가 `CORS_ORIGINS`에 있어야 한다.** 없거나 밖이면 403 (Google 검증도 토큰 사용도 하지 않는다). `android` 로그인은 `Origin`을 보지 않는다. 본문에 `refresh_token`이 있으면 쿠키보다 본문을 쓰고(이때는 `Origin` 확인이 없고 쿠키 토큰도 회전하지 않는다), 응답도 본문으로 준다.
- 같은 Google 계정의 첫 로그인이 동시에 오면 한쪽은 유일 키에 막히지만, 되돌린 뒤 다시 읽어 있는 사용자로 이어 가므로 둘 다 200 이다. `AUTH_JWT_KEY`가 없으면 로그인·refresh 는 커밋 전에 503 으로 끝나 사용자·토큰 회전이 남지 않는다 (옛 리프레시 토큰이 그대로 살아 있다).
- 서버는 리프레시 토큰을 SHA-256 해시로만 저장한다. 원문은 발급 응답에 한 번만 나간다. 사용자 이메일·이름·사진·`google_sub`는 DB 에 암호화해 둔다.

### DELETE `/api/me` (계정 삭제)

본문 `{"confirm": true}` 만 받는다 (`true` 가 아닌 값·본문 없음·깨진 JSON 은 모두 400). **DB 기록만 지운다. AWS·GitHub 는 한 번도 부르지 않는다** (Hard rule 3) — CloudFormation 스택·IAM 역할·GitHub 앱 설치는 사용자가 직접 지운다.

- **막는 경우 (409)**: 살아 있는 배포가 하나라도 있으면 아무것도 지우지 않는다. 살아 있는 배포 = 상태가 `queued`·`cloning`·`analyzing`·`generating`·`building`·`pushing`·`deploying`·`needs_input`·`running`·`deleting`, 또는 `failed` 인데 `service_arn` 이 남은 것 (MCP 의 "살아 있는" 정의와 같다). `detail` 문자열 끝에 `#<d_id> <서비스 이름>`이 쉼표로 나열된다 (서비스 이름이 없으면 레포 주소). 먼저 멈추거나(`POST /api/deploys/{d_id}/stop`) 삭제(`DELETE /api/deploys/{d_id}`)한 뒤 다시 부른다.
- **지우는 것 (한 트랜잭션, 하나라도 실패하면 전부 되돌림)**: 남은 배포 기록(`stopped`·`deleted`·서비스 없는 `failed`)과 딸린 로그·이슈·릴리스·환경변수·헬스체크·인시던트·복구 기록, 연결 블록·AWS 계정·GitHub 설치 기록, 알림·푸시 기기·알림 설정. 지울 배포는 id 목록이 아니라 지우는 순간의 조건(내 것이고 살아 있지 않음)으로 고르고, 맨 처음에 쓰기 잠금을 잡은 뒤 살아 있는 배포를 확인하므로(그 사이 "다시 켜기" 같은 쓰기가 끼어들 수 없다) 확인 뒤에 살아난 배포는 지워지지 않는다. 삭제 뒤에도 살아 있는 배포가 보이면 409 로 전부 되돌린다.
- **참조 정리**: 지우는 AWS 계정·GitHub 설치를 가리키던 다른 기록은 주인이 누구든(주인 없는 옛 배포, 다른 사용자의 배포·블록 포함) 그 참조만 `null` 로 떼고 남긴다. id 가 다시 쓰여도 남의 자격증명에 닿지 않게 하려는 것이다.
- **남는 ECR 저장소**: `stopped`·서비스 없는 `failed` 배포가 남긴 ECR 저장소(`repository_name`, 없으면 `image_uri` 의 저장소 부분)는 지우지 않는다(자동 삭제 금지). 기록이 사라지면 목록을 잃으므로 지우기 전에 모아 응답 `leftover_ecr_repositories`(중복 없이 정렬)로 돌려준다. 이미 `deleted` 인 배포의 저장소는 뺀다. 이 목록이 비어 있지 않으면 `message` 에 안내가 붙는다. (저장소가 남은 멈춘 배포가 있을 때 막는 쪽으로 바꿀지는 소유자 결정 사항 - 지금은 막지 않는다.)
- **사용자 행은 남기고 개인 정보를 지운다**: `status="deleted"`, `name`·`picture_url` 은 `null`, `google_sub`·`email` 은 상수 `"deleted"`(암호화 저장), 두 블라인드 인덱스는 `blind_index("deleted", u_id)` 로 바꾼다. 같은 Google 계정으로 다시 로그인하면 **새 사용자**(새 `u_id`, 이전 기록 없음)가 된다.
- 리프레시 토큰·개인 토큰은 모두 폐기된다. 이미 받은 액세스 토큰은 만료 전이어도 다음 요청부터 401 이다 (`status != active`).
- 응답: `{"message": "계정을 삭제했습니다. AWS CloudFormation 스택과 GitHub 앱 설치는 직접 지워 주세요. 남아 있는 ECR 이미지 저장소(a, b)도 AWS 콘솔에서 직접 지워 주세요", "deleted": {"deploys": n, "accounts": n, "notifications": n}, "leftover_ecr_repositories": ["a", "b"]}` (`accounts` 는 연결 블록 + AWS 계정 + GitHub 설치 기록 수, `notifications` 는 알림 + 기기 + 설정 줄 수. 남는 저장소가 없으면 목록은 `[]` 이고 `message` 는 앞 문장만).

### `Auth_Token`
```json
{ "access_token": "eyJ…", "expires_in": 900, "refresh_token": "dwr_…", "user": { "u_id": 1, "email": "me@example.com", "name": "홍길동", "picture_url": "https://…" } }
```
웹 응답은 `refresh_token: null` (쿠키로 간다). 액세스 토큰: HS256(`AUTH_JWT_KEY`), 클레임 `sub`(u_id 문자열)·`typ="access"`·`iss="deploy-wizard"`·`aud="deploy-wizard-api"`·`iat`·`exp`.

### `User_Read`
```json
{ "u_id": 1, "email": "me@example.com", "name": "홍길동", "picture_url": "https://…" }
```
`name`·`picture_url`은 `null`일 수 있다.

### 상태 코드와 `detail`

| 코드 | 언제 | `detail` |
|------|------|----------|
| 401 | Google `id_token`이 틀림·만료·`aud`/`iss` 불일치·이메일 미확인 | `Google 로그인 정보를 확인할 수 없습니다. 다시 로그인해 주세요` |
| 403 | 허용 목록 밖의 이메일 또는 탈퇴한 사용자 | `로그인이 허용된 계정이 아닙니다` |
| 422 | `platform`이 `web`·`android`가 아님, 본문 타입이 틀림 (`/api/auth/*` 전체) | FastAPI 검증 오류 목록 - 단, 보낸 값을 되돌려 주는 `input` 항목은 뺀다 (`id_token`·리프레시 토큰이 응답에 실리지 않게) |
| 503 | Google 공개키를 못 받음 / 그 플랫폼의 클라이언트 ID 미설정 / `AUTH_JWT_KEY` 없음 | `Google 로그인 서버에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요` / `Google 로그인이 아직 설정되지 않았습니다 (GOOGLE_CLIENT_ID_* 확인)` / `로그인 설정이 완료되지 않았습니다 (AUTH_JWT_KEY 확인)` |
| 401 | refresh: 토큰 없음·모름·만료·폐기됨(재사용 → 계열 폐기)·동시 요청에서 짐·탈퇴한 사용자 | `로그인이 만료되었습니다. 다시 로그인해 주세요` |
| 403 | 쿠키로 온 refresh·logout, 또는 `platform="web"` 로그인의 `Origin`이 없거나 허용 목록 밖 | `허용되지 않은 출처입니다` |
| 401 | 보호 경로(`AUTH_ENABLED=true`)·`/api/me`·`/api/auth/tokens*`: 토큰 없음·틀림·만료·다른 용도(`typ`)·폐기된 개인 토큰·없는/탈퇴한 사용자 (응답 헤더 `WWW-Authenticate: Bearer`) | `로그인이 필요합니다` |
| 403 | `/api/auth/tokens*`를 개인 토큰으로 부름 | `개인 토큰으로는 개인 토큰을 관리할 수 없습니다. 로그인해서 관리해 주세요` |
| 403 | `DELETE /api/me`를 개인 토큰으로 부름 | `개인 토큰으로는 계정을 삭제할 수 없습니다. 로그인한 앱이나 웹에서 삭제해 주세요` |
| 400 | `DELETE /api/me`: 본문이 `{"confirm": true}` 가 아님 | `계정을 삭제하려면 confirm 에 true 를 보내야 합니다` |
| 409 | `DELETE /api/me`: 살아 있는 배포가 있음 | `먼저 멈추거나 삭제해야 하는 서비스가 있습니다: #3 my-app, #5 other` |
| 503 | `DELETE /api/me`: 다른 작업이 DB 쓰기 잠금을 쥐고 있음 (`database is locked`, 아무것도 지워지지 않음 - 잠시 뒤 다시 시도) | `지금 다른 작업이 DB를 쓰고 있습니다. 잠시 뒤 다시 시도해 주세요` |
| 500 | `DELETE /api/me`: 삭제 중 실패 (전부 되돌려 아무것도 지워지지 않음) | `계정 삭제 실패 :…` |
| 400 | `POST /api/auth/tokens`: `expires_in_days`가 상한 초과 | `개인 토큰 기간은 최대 90일입니다` |
| 404 | `DELETE /api/auth/tokens/{a_t_id}`: 남의 것·없음·이미 폐기 | `개인 토큰을 찾을 수 없습니다` |

## Deploy

| Method | Endpoint | 설명 | 성공 |
|--------|----------|------|------|
| GET | `/api/deploys` | 전 배포 조회 (삭제된 것 제외, 최신순). 인증 켬이면 내 것만 | 200 `Deploy_Read[]` |
| GET | `/api/deploys/remote?repo_url=&github_installation_id=` | 레포의 브랜치 목록과 기본 브랜치 (`git ls-remote`). `github_installation_id`(M6, 선택) 주면 그 설치 토큰으로 private 레포도 조회 | 200 `Repo_Remote` |
| POST | `/api/deploys` | 배포 생성 → 파이프라인 시작 | 201 `Deploy_Read` |
| GET | `/api/deploys/{d_id}` | 특정 배포 조회 | 200 `Deploy_Read` |
| GET | `/api/deploys/{d_id}/logs?after=` | `d_l_id > after`인 로그 (최대 500줄) | 200 `Deploy_Log_Read[]` |
| GET | `/api/deploys/{d_id}/issues` | 문제 이력 - 다시 배포해도 지워지지 않는 지난 실패들 (최신순) | 200 `Deploy_Issue_Read[]` |
| GET | `/api/deploys/{d_id}/health` | 공개 주소에 GET을 보내 본다 (AWS 권한 불필요) | 200 `Deploy_Health` |
| GET | `/api/deploys/{d_id}/health-history?hours=24` | 서버가 1분마다 남긴 헬스체크 이력 - 최근 `hours`시간(1~168), 최신 1440건을 오래된 것부터 | 200 `Health_Check_Read[]` |
| PATCH | `/api/deploys/{d_id}/settings` | 배포별 설정 변경 - 보낸 항목만 바뀐다 (아래 "Settings") | 200 `Deploy_Read` |
| POST | `/api/deploys/{d_id}/redeploy` | 다시 배포. 서비스가 있으면 새 이미지로 갱신 | 200 `Deploy_Read` |
| POST | `/api/deploys/{d_id}/env/continue` | 이어서 배포 - 환경변수 입력을 마친 `needs_input` 배포를 `deploying` 단계부터 다시 돌린다 (아래 "Env"). `needs_input`이 아니면 409 → `queued` | 200 `Deploy_Read` |
| POST | `/api/deploys/advice` | 배포 전 분석 - 레포를 읽기만 하고 사양 수준·필요한 것·확신도를 돌려준다. 배포 기록·AWS 호출 없음 (아래 "Advice") | 200 `Deploy_Advice` |
| POST | `/api/deploys/{d_id}/stop` | 멈춤 - ECS 서비스만 삭제(요금 중단), 이미지·기록 유지. `running`만 가능(아니면 409) → `stopped` | 200 `Deploy_Read` |
| POST | `/api/deploys/{d_id}/start` | 다시 켜기 - 남겨 둔 이미지로 배포 단계만 다시. `stopped`만 가능(아니면 409) → `queued` | 200 `Deploy_Read` |
| DELETE | `/api/deploys/{d_id}` | ECS 서비스·ECR 리포지토리 삭제 후 기록을 `deleted`로 (`stopped`에서도 가능) | 200 `{message, deleted[]}` |

| 상태 코드 | 언제 |
|-----------|------|
| 400 | 레포 주소·브랜치 형식이 틀림, 레포 조회 실패, 설정 변경 본문이 비어 있음 |
| 404 | 없는 `d_id`, 이미 삭제된 배포, **남의 배포**(인증 켬) / 본문·쿼리의 `aws_account_id`·`github_installation_id`가 없거나 남의 것 (`해당 id의 AWS 계정이 없습니다` / `해당 id의 GitHub 설치가 없습니다`) |
| 409 | 진행 중인 배포에 다시 배포·삭제 요청 |
| 500 | AWS 삭제 실패 등 |
| 501 | 시크릿 종류 환경변수에 값을 보냄 (저장 미지원 - 아래 "Env") |

### POST `/api/deploys`

```json
{ "repo_url": "https://github.com/kjfcvx12/middle_project_4", "branch": "kjfcvx12" }
```

- `repo_url`: `https://github.com/소유자/레포` 형식만. 끝의 `/`와 `.git`은 허용.
- `branch`: 생략하면 레포의 기본 브랜치.
- `aws_account_id`(M6, 선택): 생략하면 개발 세션으로 배포(M1~M5 동작). `/api/accounts/aws`로 연결한 계정의 `a_id`.
- `github_installation_id`(M6, 선택): 넣으면 클론·브랜치 조회에 그 설치의 토큰을 쓴다 (private 레포 가능). 생략하면 지금까지처럼 public 클론.
- 비용 확인용 옵션(모두 선택, 생략하면 지금까지처럼 기본 사양·증설 없음·계획 없음). 타입은 엄격하다 - 정수 칸에 글자·불리언·소수를 넣으면 422:
  - `cpu`·`memory`(문자열): `GET /api/pricing/options`의 사양 프리셋 조합이어야 한다. 둘 다 생략하거나 둘 다 보낸다 (한쪽만·프리셋이 아닌 조합은 400 `사양이 올바르지 않습니다 ...`).
  - `planned_hours`(숫자): 0보다 크고 8760 이하의 유한한 수 (아니면 400 `예정 사용 시간은 ...`).
  - `min_tasks`·`max_tasks`(정수)·`scale_metric`(`AVERAGE_CPU`|`AVERAGE_MEMORY`|`REQUEST_COUNT_PER_TARGET`)·`scale_target`(정수, CPU·메모리는 1~100, 요청 수는 1~100000): 자동 증설. 4개를 모두 보내거나 모두 생략한다. `1 ≤ min ≤ max ≤ MAX_TASKS_CAP`(기본 4). 위반하면 400 + 한국어 `detail`. 4개가 다 있을 때만 Express 서비스를 만들 때 `scalingTarget`으로 보낸다.
  - 이 값들은 서비스를 **처음 만들 때** 적용된다. 이미 떠 있는 서비스를 다시 배포(`redeploy`)할 때는 사양·증설을 바꾸지 않는다.

### `Deploy_Read`

```json
{
  "d_id": 2,
  "repo_url": "https://github.com/kjfcvx12/middle_project_4",
  "branch": "kjfcvx12",
  "commit_sha": "089917e2486d0e09f188474cb23fe93eec652751",
  "language": "python",
  "support_level": "official",
  "app_dir": "backend",
  "status": "failed",
  "dockerfile": "FROM python:3.12-slim\n...",
  "dockerfile_source": "template_rule",
  "fix_count": 0,
  "service_name": null,
  "service_arn": null,
  "image_uri": null,
  "port": 8000,
  "health_check_path": "/",
  "endpoint": null,
  "error_step": "pushing",
  "error_msg": "Unable to locate credentials",
  "explain": {
    "summary": "AWS 자격증명을 찾지 못했거나 만료되었습니다.",
    "cause": "이 컴퓨터에 AWS 자격증명이 설정되어 있지 않거나, 임시 자격증명의 수명이 끝났습니다.",
    "actions": ["aws login 으로 로그인합니다 (액세스 키를 만들지 않아도 됩니다).", "..."],
    "source": "rule",
    "cached": false
  },
  "aws_account_id": null,
  "github_installation_id": null,
  "auto_redeploy": true,
  "watch_commit_sha": null,
  "watch_checked_at": null,
  "env_pending": 0,
  "auto_recover": true,
  "health_state": "unknown",
  "last_health_at": null,
  "open_incident_id": null,
  "open_incident_status": null,
  "cpu": null,
  "memory": null,
  "min_tasks": null,
  "max_tasks": null,
  "scale_metric": null,
  "scale_target": null,
  "planned_hours": null,
  "running_since": null,
  "plan_notified_at": null,
  "created_at": "2026-09-21T06:10:00",
  "updated_at": "2026-09-21T06:11:02"
}
```

`env_pending`: 값이 비어 있는 필수 환경변수 수 (`required`이고 `status`가 `detected`인 것). DB 열이 아니라 조회할 때마다 센다. 환경변수가 없으면 0. `needs_input` 배포를 화면에 알리는 용도다.

`auto_recover`: 배포별 자동 복구 스위치 (기본 `true`). `health_state`: `healthy` `unhealthy` `unknown` — 마지막 헬스체크 요약이며 아직 한 번도 확인하지 않았으면 `unknown`. `last_health_at`: 마지막 헬스체크 시각(없으면 null). `open_incident_id`: 아직 끝나지 않은(`open`·`recovering`·`needs_action`) 인시던트 번호, 없으면 null (배포마다 끝나지 않은 인시던트는 하나뿐). `open_incident_status`: 그 인시던트의 `status`(`open` `recovering` `needs_action`), 없으면 null. 둘 다 DB 열이 아니라 조회할 때마다 같은 조회로 채운다. 앞의 셋은 `deploys` 열이다 (옛 DB는 서버 시작 때 `ensure_columns`가 열을 더한다). 같은 때 더해지는 네 번째 열 `bad_commit_sha`(자동 되돌리기가 기억해 둔 나쁜 커밋, 감시가 같은 커밋을 다시 배포하지 않게 하는 내부용)는 응답에 싣지 않는다.

`cpu` `memory` `min_tasks` `max_tasks` `scale_metric` `scale_target` `planned_hours`: 만들 때 고른 사양·자동 증설·예정 사용 시간 (고르지 않았으면 모두 null = 기본 사양). `running_since`: `running`이 된 시각(UTC, 시간대 표시 없음). `running`이 될 때 비어 있으면 지금 시각으로 채우고(이때 `plan_notified_at`도 비운다), 멈춤·삭제·서비스 없는 실패 때 비운다. 살아 있는 서비스의 재배포·재시작·복구는 시간을 이어서 센다. 멈춤 후 다시 켜면 처음부터 다시 센다. `plan_notified_at`: 예정 사용 시간을 넘겼다는 알림을 보낸 시각 (아직 안 보냈으면 null, `running_since`를 새로 채울 때와 `planned_hours`를 바꿀 때 비운다). 모두 `deploys` 열이며 옛 DB는 서버 시작 때 `ensure_columns`가 더한다.

### 값 목록

| 필드 | 값 |
|------|-----|
| `status` | `queued` `cloning` `analyzing` `generating` `building` `pushing` `needs_input` `deploying` `running` `failed` `stopped` `deleting` `deleted` |
| `support_level` | `official` `experimental` |
| `dockerfile_source` | `template_llm` `template_rule` `llm_raw` `llm_fix` `repo` |
| `explain.source` | `rule` `llm` `none` |
| `Deploy_Log_Read.level` | `info` `cmd` `warn` `error` |
| `Deploy_Health.health` | `healthy` `unhealthy` `unknown` |

### `Deploy_Log_Read`

```json
{ "d_l_id": 41, "d_id": 2, "step": "building", "level": "info", "message": "#8 DONE 12.4s", "created_at": "..." }
```

화면은 마지막으로 받은 `d_l_id`를 `after`로 넘겨 새 줄만 받는다. 로그는 저장 전에 토큰이 마스킹된다.

### `Deploy_Issue_Read`

```json
{
  "d_i_id": 3,
  "d_id": 2,
  "step": "pushing",
  "error_msg": "Unable to locate credentials",
  "explain": { "summary": "AWS 자격증명을 찾지 못했거나 만료되었습니다.", "cause": "...", "actions": ["..."], "source": "rule" },
  "created_at": "2026-09-21T06:11:02"
}
```

실패마다 하나씩 쌓인다 (`pipeline_fail`, 서버 재시작 복구 포함). `deploys.error_step`/`error_msg`/`explain`은 항상 최신 실패만 보여주고, 지난 실패들은 여기서 본다.

### `Repo_Remote`

```json
{ "default_branch": "main", "branches": ["main", "kjfcvx12", "oxo"] }
```

### PATCH `/api/deploys/{d_id}/settings`

```json
{ "auto_redeploy": false, "auto_recover": true, "planned_hours": 6 }
```

- 세 항목 모두 선택. `auto_redeploy`·`auto_recover`는 보내지 않은(또는 `null`) 항목을 그대로 둔다. 하나도 없으면(빈 본문) 400 `변경할 설정을 하나 이상 보내 주세요`.
- `planned_hours`(예정 사용 시간): 숫자를 보내면 바뀌고 **`null`을 보내면 계획을 지운다**. 보내지 않으면 그대로. 값은 생성 때와 같은 검사(0 초과 8760 이하, 아니면 400 한국어). 보낼 때마다 `plan_notified_at`을 null로 비워 시간 초과 알림을 다시 켠다.
- 사양(`cpu`·`memory`)과 증설 값은 여기서 바꿀 수 없다 (422) - 확인을 거친 재배포 몫이다.
- 모르는 항목은 422 (`extra=forbid`) - `status` 같은 값은 여기서 못 바꾼다.
- 없는 `d_id`, 삭제된 배포는 404. 응답은 바뀐 `Deploy_Read`.

### GET `/api/deploys/{d_id}/health-history`

`hours`는 1~168 (기본 24, 범위 밖은 422). `HEALTH_INTERVAL_SECONDS`(기본 60초)마다 `running` 이면서 주소가 있는 배포의 `endpoint + health_check_path`에 GET을 보내 남긴 기록이며, `HEALTH_RETENTION_DAYS`(기본 7일)보다 오래된 것은 지워진다. 응답은 시간순(오래된 것부터), 기간 안에 1440건을 넘으면 최신 1440건. 없는 배포는 404.

### `Health_Check_Read`

```json
{ "h_c_id": 9001, "d_id": 2, "ok": false, "status_code": 502, "latency_ms": 5000, "detail": "HTTP 502", "checked_at": "2026-11-09T03:12:00" }
```

`ok`: 상태코드 400 미만이면 정상 (`GET /health`와 같은 기준). `status_code`/`latency_ms`는 응답이 없으면 null. `detail`은 실패 사유 한 줄(`HTTP 503`, `시간 초과`, `연결 실패` 등, 마스킹 후 저장, 응답 헤더·본문은 넣지 않는다). `checked_at`은 UTC. 리다이렉트는 같은 호스트 안에서만 따라간다.

### `Deploy_Health`

```json
{ "d_id": 2, "health": "healthy", "status_code": 200, "detail": null }
```

## Env (환경변수 - 1단계 백엔드, 실제 AWS 검증 전)

배포가 `analyzing`에서 소스를 읽어 환경변수 **이름**만 찾아 `deploy_env_vars`에 넣는다 (값은 읽지 않는다). 사용자가 값을 넣거나 건너뛴다. 첫 배포에서 값이 빈 필수 변수가 남아 있으면 `deploying` 직전에 `needs_input`으로 멈추고, 사용자가 `POST /env/continue`를 눌러야 이어 간다. 이미 서비스가 있는 재배포는 멈추지 않고 경고 로그만 남긴다.

| Method | Endpoint | 설명 | 성공 |
|--------|----------|------|------|
| GET | `/api/deploys/{d_id}/env` | 배포의 환경변수 목록 (이름순). 값은 싣지 않는다 | 200 `Env_Read[]` |
| PUT | `/api/deploys/{d_id}/env/{name}` | 값 입력 · 종류 지정 · 건너뛰기. 없는 이름이면 사용자가 직접 추가한 것(`source: "user"`, 필수)으로 만든다 | 200 `Env_Read` |
| DELETE | `/api/deploys/{d_id}/env/{name}/value` | 저장된 값만 지운다. 변수 행은 남는다 | 200 `Env_Read` |
| POST | `/api/deploys/{d_id}/env/continue` | 이어서 배포 (위 Deploy 표). 값이 빈 필수 변수가 남았으면 409 | 200 `Deploy_Read` |

남의 배포(인증 켬)의 환경변수 경로는 모두 404 `해당 id의 배포가 없습니다` — 이름 형식 검사(400)보다 먼저 본다.

### PUT `/api/deploys/{d_id}/env/{name}` 본문 `Env_Update`

```json
{ "value": "INFO", "kind": "config", "skip": null }
```

세 필드 모두 선택이다. 보낸 것만 바뀐다.

- `value`: 값 (최대 2000자). **쓰기 전용** - 어떤 응답에도 다시 나오지 않는다. 일반 설정(`config`)만 저장한다.
- `kind`: `database` `cache` `external_api` `secret` `config` `unknown` 중 하나. `unknown`인 변수는 종류를 먼저 고른 뒤에만 값을 넣을 수 있다. 시크릿 종류(`database` `cache` `external_api` `secret`)로 바꾸면 이미 저장된 일반 값은 지워지고 상태가 `detected`로 돌아간다.
- `skip`: `true`면 `skipped`(이번에는 값 없이 간다 - 첫 배포 멈춤 조건에서 빠진다). `false`면 건너뛰기를 취소한다 (값이 있으면 `set`, 없으면 `detected`). `value`와 함께 보낼 수 없다.

### `Env_Read`

```json
{
  "d_e_id": 3, "d_id": 2, "name": "LOG_LEVEL", "required": true, "has_default": false,
  "kind": "config", "source": "code", "source_hint": "app/main.py:12",
  "status": "set", "has_value": true, "needs_redeploy": false
}
```

| 필드 | 값 |
|------|-----|
| `kind` | `database` `cache` `external_api` `secret` `config` `unknown` |
| `source` | `code` `compose` `example` `runtime_error` `user` |
| `status` | `detected`(값 없음) `set`(값 있음) `skipped` |
| `has_value` | 값이 저장돼 있는지만 알려 준다. **값 자체는 어디에도 돌려주지 않는다** |
| `needs_redeploy` | PUT·DELETE 응답에서만 의미가 있다. 서비스가 이미 떠 있는 배포에서 값이 바뀌었으면 `true` (바뀐 값은 다시 배포해야 반영된다). 건너뛰기만 바꾼 경우는 `false` |

`source_hint`는 `파일:줄` 위치다 (코드 줄 내용은 아니다). compose·예시 파일에서 찾았거나 직접 추가했으면 줄 번호가 없거나 `null`이다.

### 상태 코드와 `detail`

| 코드 | 언제 | `detail` |
|------|------|----------|
| 400 | 이름이 `[A-Za-z_][A-Za-z0-9_]*` 100자 이내가 아님 | `환경변수 이름이 올바르지 않습니다` |
| 400 | `kind`가 목록에 없음 | `환경변수 종류가 올바르지 않습니다` |
| 400 | `value`가 2000자 초과 | `값은 2000자까지 입력할 수 있습니다` |
| 400 | `value`와 `skip: true`를 함께 보냄 | `건너뛰기와 값은 함께 보낼 수 없습니다` |
| 400 | 종류가 `unknown`인데 `value`를 보냄 | `종류를 먼저 골라 주세요` |
| 404 | 없는(또는 삭제된) `d_id` | `해당 id의 배포가 없습니다` |
| 404 | DELETE `/value`에서 없는 이름 | `해당 환경변수가 없습니다` |
| 409 | `/env/continue`인데 `needs_input`이 아님 | `입력이 필요한 상태의 배포만 이어서 배포할 수 있습니다` |
| 409 | `/env/continue`인데 값이 빈 필수 변수가 남음 | `필수 환경변수에 값이 없습니다 :A, B` (이름만 나열) |
| 409 | `/env/continue`인데 이전 작업이 아직 정리 중이라 시작하지 못함 (상태는 `needs_input` 그대로) | `잠시 후 다시 눌러 주세요 (이전 작업을 정리하는 중입니다)` |
| 501 | 시크릿 종류(`database` `cache` `external_api` `secret`)에 `value`를 보냄 | `시크릿 값 저장은 아직 지원하지 않습니다 (사용자 AWS 보안 저장소 검증 후 지원)` |
| 500 | 저장 실패 | `환경변수 저장 실패 :<예외 종류>` / `환경변수 값 삭제 실패 :<예외 종류>` / `이어서 배포 실패 :...` (값은 에러에 싣지 않는다) |

**시크릿 값은 아직 받지 않는다 (결정 D8 검증 대기).** 시크릿은 사용자 AWS의 보안 저장소에 두기로 했지만, Express Mode가 컨테이너에 `secrets`를 넘기는 방식과 CloudFormation 템플릿(v3) 권한이 검증되지 않았다 (규칙 2). 그래서 시크릿 종류는 종류 지정·건너뛰기만 되고 값은 501이다. 일반 설정(`config`)만 `primaryContainer.environment`로 컨테이너에 들어간다.

### 파이프라인과의 관계

- `analyzing`: 소스에서 이름 찾기 → 규칙으로 종류 분류 → 모르는 것만 AI가 목록 중 하나를 고름 (AI를 못 쓰면 `unknown`으로 둔다. 정식 언어는 AI 없이도 끝까지 간다). 로그에는 개수만 남긴다 (`환경변수 N개를 찾았습니다 (필수 M개)`).
- `needs_input`: 첫 배포에서 값이 빈 필수 변수가 있으면 `deploying` 직전에 멈춘다. 실패가 아니라 대기라 `error_step`/`error_msg`는 비어 있고 로컬 이미지는 그대로다. 경고 로그는 이름만 적는다 (`환경변수 입력이 필요합니다 :A, B`). 서버를 다시 켜도 그대로 남는다 (`pipeline_recover`가 건드리지 않는다).
- `POST /env/continue`: 상태를 `queued`로 바꾸고 `deploying` 단계부터 돌린다. 이미지가 지워졌으면(작업 종료 뒤) 처음부터 다시 만든다. `[다시 배포]`는 `needs_input`에서 멈춘 지점이 아니라 `cloning`부터 다시 한다.
- 배포가 환경변수 때문에 실패하면(`KeyError: 'X'`, `Missing required environment variable X`, `X is not defined`) 에러 글에서 대문자 이름만 뽑아 `source: "runtime_error"`, 필수, 종류 `unknown`으로 목록에 올리고 "필요한 환경변수가 설정되지 않았습니다." 해설을 보여 준다.

## Advice (배포 전 분석 - 1단계 백엔드)

레포를 임시 폴더에 얕게 클론해 읽기만 하고 바로 지운다. 배포 기록·AWS 호출·DB 쓰기가 없다. 같은 레포·같은 커밋이면 서버 메모리 캐시(최대 100개)에서 돌려준다. 판정은 규칙이 하고 AI는 환경변수 종류를 고를 때만 쓴다.

### POST `/api/deploys/advice`

```json
{ "repo_url": "https://github.com/kjfcvx12/private-test", "branch": "main", "github_installation_id": 1 }
```

본문은 `POST /api/deploys`와 같다 (`repo_url` 필수, `branch`·`aws_account_id`·`github_installation_id` 선택). `github_installation_id`를 주면 그 설치의 토큰으로 private 레포도 읽는다. `aws_account_id`는 받기만 하고 쓰지 않는다 (AWS 호출이 없다). 둘 다 내 것이어야 한다 — 없거나 남의 것이면 404 (레포를 읽지 않는다).

### `Deploy_Advice`

```json
{
  "tier": "medium",
  "confidence": "medium",
  "cpu": null,
  "memory": null,
  "cost": {
    "monthly_min": 26.79, "monthly_max": 26.79, "currency": "USD", "basis_date": "2026-11-11", "note": "트래픽에 따라 늘어납니다",
    "hourly_usd": 0.0367,
    "components": [
      { "name": "Fargate (vCPU·메모리)", "hourly_usd": 0.0142, "note": "0.25 vCPU / 0.5 GB" },
      { "name": "ALB (고정 시간당)", "hourly_usd": 0.0225, "note": "트래픽에 따른 LCU 요금은 제외" }
    ],
    "not_included": ["트래픽에 따른 LCU 요금 (ALB 사용량)", "데이터 전송 요금 (인터넷으로 나가는 트래픽)", "로그 저장·조회 요금 (CloudWatch Logs)", "ECR 이미지 저장 요금"],
    "arm64_hourly_usd": 0.0338, "spec_label": "0.25 vCPU / 0.5 GB", "spec_is_default": true
  },
  "reasons": ["sqlalchemy, psycopg2-binary 라이브러리를 사용해 중간 사양으로 잡았습니다 (requirements.txt)"],
  "needs": [
    { "kind": "database", "supported": false, "message": "마법사가 아직 만들어 주지 못합니다", "count": null },
    { "kind": "env_vars", "supported": true, "message": null, "count": 3 }
  ],
  "unknowns": ["환경변수 FOO의 종류를 알 수 없습니다"],
  "language": "python",
  "support_level": "official",
  "app_dir": ".",
  "commit_sha": "089917e2486d0e09f188474cb23fe93eec652751"
}
```

| 필드 | 값 |
|------|-----|
| `tier` | `small` `medium` `large`. 정적 사이트 → small, 무거운 라이브러리(torch, pandas, puppeteer 등) → large, DB·캐시·워커 라이브러리나 의존성 40개 초과 → medium, 나머지 small (정적 사이트 판정이 먼저) |
| `confidence` | `high` `medium` `low`. 의존성 파일을 못 읽었거나 종류를 모르는 환경변수가 2개 이상이면 low, 1개이거나 실험 지원 언어면 medium, 나머지 high |
| `needs[].kind` | `database` `cache` `worker` `env_vars` `disk_write` `static_site`. `supported: false`는 마법사가 아직 만들어 주지 못하는 것 (`message`로 이유). `env_vars`는 `count`가 있고 1개 이상일 때만 나온다 |
| `cpu` `memory` | **항상 `null`.** Express Mode가 허용하는 CPU·메모리 조합을 실제 배포로 확인하기 전이다 (결정 D10) |
| `cost` | AWS 공개 가격 파일에서 읽은 단가로 **기본 사양(0.25 vCPU / 0.5 GB)** 의 온디맨드 추정치를 응답 직전에 채운다. 분석 결과 캐시에는 넣지 않고 매 요청마다 다시 계산한다(가격이 바뀌어도 낡은 값이 나가지 않게). `monthly_min` = `monthly_max` = 한 달(730시간) 금액, `hourly_usd` = 시간당, `components[]` = `{name, hourly_usd, note}`(Fargate·ALB), `not_included[]` = 빠진 요금(LCU·데이터 전송·로그·ECR), `arm64_hourly_usd` = ARM64일 때 시간당(가격이 없으면 `null`), `spec_label`·`spec_is_default` = 어떤 사양으로 계산했는지. **가격을 못 얻으면** 숫자와 `basis_date`·`hourly_usd`·`arm64_hourly_usd`·`spec_label`·`spec_is_default`는 `null`, `components`·`not_included`는 `[]`이고 `note`만 채운다 |

### 상태 코드와 `detail`

| 코드 | 언제 | `detail` |
|------|------|----------|
| 400 | 주소 형식이 틀림 | `https://github.com/소유자/레포 형식의 주소만 받습니다.` |
| 400 | 브랜치 형식이 틀림 | `브랜치 이름이 올바르지 않습니다.` |
| 400 | 커밋 조회 실패 | `레포를 조회할 수 없습니다 :<마스킹된 사유>` |
| 400 | 클론 실패 | `레포를 가져올 수 없습니다 :<마스킹된 사유>` |
| 404 | `aws_account_id`·`github_installation_id`가 없거나 남의 것 | `해당 id의 AWS 계정이 없습니다` / `해당 id의 GitHub 설치가 없습니다` |
| 400 | 지원하는 프로젝트가 아님 | `매니페스트 파일을 찾지 못했습니다. 지원하는 형식의 프로젝트가 아닙니다.` |
| 500 | 그 밖의 분석 실패 | `분석 실패 :<마스킹된 사유>` |

`disk_write`는 소스에서 파일을 쓰는 코드 흔적(`open(..., "w")`, `write_text`, `fs.writeFile` 등)을 정규식·AST로 찾는 **추정**이다. 테스트 파일은 건너뛰며, 임시 파일·로그 쓰기를 잘못 잡을 수 있다.

## Pricing (비용 확인 - 백엔드)

AWS 공개 가격 파일(인증 없음)에서 Fargate·ALB 시간당 단가를 읽어 추정한다. 단가는 서버 파일 캐시(`PRICING_CACHE_HOURS`, 기본 24시간)에 두고, 읽기에 실패하면 낡은 캐시를 쓴다. 리전은 서버 설정(`AWS_REGION`)을 따른다. AWS 호출·DB 쓰기는 없다. 금액은 전부 USD 온디맨드 **추정치**다. 사용자 데이터가 없어 소유권 필터는 없고, 인증 켬이면 로그인만 필요하다.

| Method | Endpoint | 설명 | 응답 |
|--------|----------|------|------|
| GET | `/api/pricing/options` | 사양 프리셋 4개와 사용 기간 선택지 | 200 `Pricing_Options` |
| POST | `/api/pricing/estimate` | 사양·사용 시간·최대 작업 수로 비용 추정 | 200 `Cost_Estimate` |

### GET `/api/pricing/options`

```json
{
  "specs": [{ "label": "0.25 vCPU / 0.5 GB", "cpu": "256", "memory": "512", "vcpu": 0.25, "memory_gb": 0.5 }],
  "plans": [{ "label": "4시간", "hours": 4 }, { "label": "하루", "hours": 24 }, { "label": "일주일", "hours": 168 }, { "label": "계속", "hours": null }],
  "max_tasks_cap": 4,
  "scale_metrics": [
    { "value": "AVERAGE_CPU", "label": "CPU 사용률" },
    { "value": "AVERAGE_MEMORY", "label": "메모리 사용률" },
    { "value": "REQUEST_COUNT_PER_TARGET", "label": "요청 수" }
  ]
}
```

`specs`는 항상 4개(0.25/0.5, 0.5/1, 1/2, 2/4 vCPU/GB). `plans`의 마지막 `hours: null`은 "계속"(기간을 정하지 않음). `max_tasks_cap`은 최대 작업 수 상한(`MAX_TASKS_CAP`, 기본 4)이고, `scale_metrics`는 자동 증설 기준 지표 3개(`value`는 AWS 값, `label`은 화면에 보일 이름 — 서버가 한 곳에서 정한다)다.

### POST `/api/pricing/estimate` 본문 `Estimate_Request`

```json
{ "cpu": "1024", "memory": "2048", "planned_hours": 24, "max_tasks": 3 }
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `cpu` `memory` | 글자, 선택 | 둘 다 비우면(생략·`""`·공백만) 기본 사양 — 서버 `.env`의 `ECS_CPU`/`ECS_MEMORY`가 둘 다 있고 프리셋 쌍이면 그 값(`spec_is_default`는 true, `assumptions`에 `.env` 설정이라고 적는다), 아니면 256/512. 값을 주면 `options`의 프리셋 조합이어야 한다. 한쪽만 주면 400 |
| `planned_hours` | 숫자, 선택 | 사용할 시간. 0보다 크고 8760 이하. 주면 `planned_usd`를 채운다 |
| `max_tasks` | 정수, 선택 | 자동 증설 최대 작업 수. 1 이상 `MAX_TASKS_CAP`(기본 4) 이하. 주면 `max_hourly_usd`·`max_monthly_usd`를 채운다 |

### `Cost_Estimate`

```json
{
  "basis_date": "2026-11-11", "region": "ap-northeast-2", "currency": "USD",
  "cpu": "1024", "memory": "2048", "spec_label": "1 vCPU / 2 GB", "spec_is_default": false,
  "components": [{ "name": "Fargate (vCPU·메모리)", "hourly_usd": 0.0568, "note": "1 vCPU / 2 GB" }, { "name": "ALB (고정 시간당)", "hourly_usd": 0.0225, "note": "트래픽에 따른 LCU 요금은 제외" }],
  "hourly_usd": 0.0793,
  "periods": [{ "label": "1시간", "hours": 1, "usd": 0.08 }, { "label": "1일", "hours": 24, "usd": 1.9 }, { "label": "1주", "hours": 168, "usd": 13.32 }, { "label": "한 달", "hours": 730, "usd": 57.87 }],
  "planned_hours": 24, "planned_usd": 1.9,
  "max_tasks": 3, "max_hourly_usd": 0.1928, "max_monthly_usd": 140.77,
  "arm64_hourly_usd": 0.0678, "arm64_saving_percent": 14.5,
  "assumptions": ["금액은 AWS 가격 목록(2026-11-11 기준)의 온디맨드 USD 추정치입니다"],
  "not_included": ["트래픽에 따른 LCU 요금 (ALB 사용량)"]
}
```

`planned_*`·`max_*`는 해당 입력이 없으면 `null`. `arm64_*`는 ARM64 단가가 없으면 `null`. 한 달은 730시간. 서비스마다 ALB가 하나씩 생긴다고 보고 계산한다(가장 비싼 경우).

### 상태 코드와 `detail`

| 코드 | 언제 | `detail` |
|------|------|----------|
| 400 | 프리셋이 아니거나 한쪽만 줌 | `지원하지 않는 사양입니다. CPU와 메모리를 정해진 사양 중에서 함께 골라 주세요` |
| 400 | `planned_hours`가 숫자가 아니거나(NaN·무한대) 0 이하 또는 8760 초과 | `사용 시간이 올바른 숫자가 아닙니다` / `사용 시간은 0보다 크고 8760시간(1년) 이하여야 합니다` |
| 400 | `max_tasks`가 범위 밖 | `최대 작업 수는 1 이상 {상한} 이하여야 합니다 (요금이 크게 늘지 않도록 정한 상한)` |
| 422 | JSON 타입이 틀림 (`max_tasks`가 불리언·소수·글자, `planned_hours`가 불리언·글자, `cpu`가 숫자 등) | FastAPI 기본 검증 오류 목록 |
| 503 | 가격 파일을 못 읽고 쓸 캐시도 없음 | `가격 정보를 가져오지 못했습니다. 잠시 뒤 다시 시도하세요` |

## Accounts (M6 - 진행 중)

| Method | Endpoint | 설명 | 성공 |
|--------|----------|------|------|
| GET | `/api/accounts/connections` | 전 연결 블록 조회 (블록 = AWS 계정 하나 + GitHub 설치 하나). 블록이 하나도 없는데 AWS 계정만 있으면 여기서 블록이 생긴다. 블록이 있을 때 어느 블록에도 안 이어진 계정은 그대로 둔다(`GET /aws`에 보이고 블록에서 고를 수 있다) | 200 `Connection_Read[]` |
| POST | `/api/accounts/connections` | 빈 블록 생성 (`{label}`) | 201 `Connection_Read` |
| POST | `/api/accounts/connections/{c_id}/aws` | 블록의 AWS 연결 시작 - 블록 이름으로 계정을 만들어 잇고 external_id 발급. 이미 있으면 409 | 201 `Aws_Account_Setup` |
| PATCH | `/api/accounts/connections/{c_id}` | 블록에 이미 연결한 AWS 계정(`{aws_account_id}`)·GitHub 설치(`{github_installation_id}`)를 잇거나 뗀다(`null`). 보내지 않은 쪽은 그대로. 여러 블록이 같은 계정·설치를 가리킬 수 있다. 없는 id는 404 | 200 `Connection_Read` |
| DELETE | `/api/accounts/connections/{c_id}` | 블록 삭제 - 그 블록의 AWS 계정 연결도 삭제(다른 블록이 같이 쓰는 계정은 남긴다), GitHub 설치는 남긴다 | 200 `dict` |
| POST | `/api/accounts/aws` | AWS 계정 연결 시작 - external_id 발급 (화면은 블록 경로를 쓴다) | 201 `Aws_Account_Setup` |
| GET | `/api/accounts/aws` | 전 AWS 계정 조회 | 200 `Aws_Account_Read[]` |
| GET | `/api/accounts/aws/template` | CloudFormation 템플릿 다운로드 | 200 yaml 파일 |
| GET | `/api/accounts/aws/{a_id}` | 특정 AWS 계정 조회 | 200 `Aws_Account_Read` |
| PATCH | `/api/accounts/aws/{a_id}/role-arn` | 역할 ARN 등록 + 검증 (`sts:AssumeRole`) | 200 `Aws_Account_Read` |
| POST | `/api/accounts/aws/{a_id}/reverify` | 저장된 role_arn 으로 다시 검증 | 200 `Aws_Account_Read` |
| GET | `/api/accounts/aws/{a_id}/template-status` | 사용자 계정 스택의 템플릿 버전(위임 역할의 `template-version` 태그)과 최신 버전 비교. 역할 미등록·조회 실패 400 | 200 `Aws_Account_Template_Status` |
| DELETE | `/api/accounts/aws/{a_id}/template-files` | 사용자 계정 S3(`cf-templates-*`)에 남은 `deploy_wizard_role.yaml`만 삭제. 역할 미등록 400, 역할에 권한 없음(옛 템플릿 스택) 403 | 200 `{message, deleted}` |
| DELETE | `/api/accounts/aws/{a_id}` | 연결 삭제 (쓰던 배포는 연결만 해제) | 200 `dict` |
| GET | `/api/accounts/github/install-url` | GitHub App 설치 화면 주소. 주소에 언제나 서명된 `state`(HS256 JWT, `typ="gh_state"`, `u`=현재 사용자(끔 모드 `null`), `c`=`?c_id=`(없으면 `null`), 15분)가 붙고, 콜백이 그 사용자에게 설치를 주고 그 블록에 잇는다. 서명 키는 `AUTH_JWT_KEY`, 없으면(끔 모드) `SECRET_KEY`에서 HMAC-SHA256(용도 이름 `deploy-wizard:github-install-state`)으로 파생한 키 — 새 환경변수 없이 동작. 둘 다 없으면 503. 남의 `c_id` 404. 운영자가 앱을 등록하지 않았으면(`GITHUB_APP_SLUG` 없음) 503 | 200 `{"url": str}` |
| GET | `/api/accounts/github/callback` | GitHub 설치 콜백 (공개, `installation_id`·`state` 쿼리) - `state` 서명·만료·종류를 확인해 설치를 `u`에게 저장하고 `c`가 그 사용자 블록이면 잇는다. 서명 불량·만료·옛 숫자 형식 `state` → 저장 없이 `/accounts?connected=github_error`. 이미 다른 사용자(또는 주인 없는 옛 설치)의 `installation_id`면 바꾸지 않고 `/accounts?connected=github_taken`(GitHub 조회 전). 같은 새 `installation_id`를 두 콜백이 동시에 처음 저장하려 해도 500 이 아니다 - 진 쪽은 유일 제약에 걸리면 되돌리고 다시 읽어, 같은 사용자면 `github`, 다른 사용자면 `github_taken`. `state` 없음은 끔 모드에서만 받는다(GitHub 쪽에서 설치를 바꾸고 돌아온 경우, 블록 없이 저장); 켬 모드는 `github_error` - 단 `setup_action=update`(GitHub 가 설치 변경 뒤 돌려보낸 요청)면 오류 없이 아무것도 저장하지 않고 `/accounts` 로 보낸다. GitHub 연결에는 `AUTH_ENABLED=false` 에서도 `SECRET_KEY` 또는 `AUTH_JWT_KEY` 가 필요하다(없으면 install-url 이 503). 리다이렉트 주소에 `state`·토큰을 싣지 않는다 | 302 → `/accounts?connected=github` |
| GET | `/api/accounts/github/{g_id}/check` | 연결 확인 - 설치 토큰을 실제로 받아 접근 가능한 레포 수·이름(앞 5개). 끊겼으면 400 | 200 `Github_Installation_Check` |
| GET | `/api/accounts/github/{g_id}/repositories` | 설치가 읽을 수 있는 레포 전부 (`full_name`, `html_url`, `private`, `default_branch`) - 새 배포 폼의 주소 목록. 100개씩 최대 1000개. 끊겼으면 400 | 200 `Github_Repository_Read[]` |
| GET | `/api/accounts/github` | 전 GitHub 설치 조회 | 200 `Github_Installation_Read[]` |
| DELETE | `/api/accounts/github/{g_id}` | 연결 삭제 (앱 설치 자체는 안 지운다 - github.com에서 직접) | 200 `dict` |

### `Aws_Account_Setup` (POST 응답 - 이때만 평문 external_id 를 보여준다)
```json
{ "a_id": 1, "label": "운영 계정", "external_id": "…", "our_account_id": "111111111111", "template_download_url": "/api/accounts/aws/template",
  "stack_create_url": "https://ap-northeast-2.console.aws.amazon.com/cloudformation/home?region=ap-northeast-2#/stacks/create" }
```

### `Connection_Read`
```json
{ "c_id": 1, "label": "test", "aws": { "a_id": 1, "status": "verified", "…": "Aws_Account_Read" }, "github": { "g_id": 1, "account_login": "kjfcvx12", "…": "Github_Installation_Read" } }
```
`aws`·`github`는 아직 연결 전이면 `null`.

### `Github_Installation_Check`
```json
{ "g_id": 1, "account_login": "kjfcvx12", "repository_selection": "selected", "repository_count": 1, "repositories": ["kjfcvx12/CARD-N"] }
```

### `Aws_Account_Template_Status`
```json
{ "a_id": 1, "current_version": 0, "latest_version": 2, "update_needed": true, "template_file_count": 0,
  "template_download_url": "/api/accounts/aws/template",
  "stack_list_url": "https://ap-northeast-2.console.aws.amazon.com/cloudformation/home?region=ap-northeast-2#/stacks" }
```
`current_version` 0 = 버전 태그가 없거나 읽을 권한이 없는 옛 템플릿. `template_file_count` = 사용자 계정 S3에 남은 업로드 사본 수(버전 2 미만이거나 못 세면 0).

### `Aws_Account_Read` (external_id 는 절대 포함하지 않는다)
```json
{
  "a_id": 1, "label": "운영 계정",
  "role_arn": "arn:aws:iam::222222222222:role/DeployWizardCrossAccountRole",
  "aws_account_id": "222222222222", "region": null,
  "status": "verified", "last_verified_at": "2026-09-22T...", "last_error": null,
  "created_at": "...", "updated_at": "..."
}
```
`status`: `pending`(역할 ARN 대기) `verified`(AssumeRole 성공) `invalid`(마지막 시도 실패, `last_error` 참고).

### `Github_Installation_Read`
```json
{
  "g_id": 1, "installation_id": 555, "account_login": "kjfcvx12", "account_type": "User",
  "repository_selection": "selected", "status": "active",
  "created_at": "...", "updated_at": "..."
}
```
`status`: `active` `suspended` `revoked`(다음 토큰 발급 시도가 실패하면 갱신). 설치 액세스 토큰은 저장하지 않는다 - 클론 직전에 매번 새로 발급.

## Watches (M6 - 코드 완료, 실제 GitHub App 미검증)

| Method | Endpoint | 설명 | 성공 |
|--------|----------|------|------|
| POST | `/api/watches/webhook` | GitHub 웹훅 수신 (`X-Hub-Signature-256`, `X-GitHub-Event` 헤더) | 200 `Watch_Ack` |

문서에는 안 올린다(`include_in_schema=False`) - GitHub이 직접 부르는 내부용. `/docs`에 안 뜬다.

### `Watch_Ack`
```json
{ "matched": 1, "debounced": 1 }
```
`matched`: 이 push의 레포+브랜치와 일치하는 배포 수. `debounced`: 그중 `auto_redeploy`가 켜져 있어 디바운스(`WATCH_DEBOUNCE_SECONDS`, 기본 30초) 예약된 수 - 나머지(`matched - debounced`)는 "새 커밋 있음" 표시만 되고 자동 배포되지 않는다.

서명이 안 맞거나(`GITHUB_WEBHOOK_SECRET` 미설정 포함) `push` 이벤트가 아니면 각각 401 또는 `{"matched": 0, "debounced": 0}`.

폴링(`Watch_Service.services_watch_poll_loop`, `WATCH_POLL_SECONDS` 기본 3600초)은 API가 없다 - `main.py` 백그라운드 태스크로만 돈다.

## Incidents (D1 - 장애 감지·원인 설명·자동 복구 기록, 조회만)

서버가 만들고 닫는다. 사용자가 만들거나 지우는 API는 없다. 모든 시간은 UTC. 실제 AWS·SMTP·Expo 에는 아직 돌려 보지 않았다 (`docs/worklog/2026-11-10.md`). 설계는 `docs/app-web/04-api-spec.md` §3.

| Method | Endpoint | 설명 | 성공 |
|--------|----------|------|------|
| GET | `/api/incidents?status=&d_id=&after=` | 인시던트 목록, 최신순 100건 | 200 `Incident_Read[]` |
| GET | `/api/incidents/{i_id}` | 한 건과 복구 시도 이력 | 200 `Incident_Detail` |
| GET | `/api/deploys/{d_id}/incidents?after=` | 한 배포의 인시던트들, 최신순 100건 | 200 `Incident_Read[]` |

- `status`는 `open` `recovering` `resolved` `needs_action` 중 하나 (그 밖의 값은 400). `d_id`는 선택 필터. `after`는 `i_id` 커서(1 이상, 아니면 422) - 그보다 오래된(`i_id`가 작은) 것부터 최신순으로 100건.
- `/api/deploys/{d_id}/incidents` 는 인시던트 라우터(`features/incidents/router.py`)가 받는다. 없는 배포(삭제된 배포 포함)는 404 `해당 id의 배포가 없습니다`. 없는 `i_id`는 404 `해당 id의 인시던트가 없습니다`.
- 인증 켬: 목록은 내 배포의 인시던트만 (`incidents`에는 주인 열이 없고 `deploys.u_id`로 거른다). 남의 배포의 `d_id`·`i_id`는 404 (`d_id` 필터는 빈 목록).

### 인시던트가 열리고 닫히는 때

- 헬스 감시가 `running` 배포의 점검 결과를 저장한 직후 훅이 불린다. **마지막 성공 이후 연속 실패가 `HEALTH_FAILURE_THRESHOLD`(기본 3)번이 되면** `open` 인시던트를 만든다. 끝나지 않은(`open`·`recovering`·`needs_action`) 인시던트가 이미 있으면 새로 만들지 않는다 (배포마다 하나).
- `kind`: 새 버전 배포 후 `NEW_RELEASE_WINDOW_SECONDS`(기본 900초) 안이고 되돌릴 이전 릴리스가 있으면 `bad_release`, 최근 실패가 모두 연결 거부면 `crash_loop`, 그 밖에는 `unhealthy`.
- 원인 수집·설명·알림은 백그라운드 태스크가 한다 (모니터를 붙잡지 않는다). 서비스 상태 조회(`describe`, 읽기 전용)와 최근 헬스체크 5줄을 마스킹해 `evidence`(4000자 이하)에 저장하고, 규칙 표로 `explain`을 만든다. 규칙에 없으면 `source: "none"` 기본 안내. 처리 중 오류가 나면 `needs_action`으로 돌리고 마스킹한 오류를 `evidence` 끝에 덧붙인다.
- 자동 복구가 꺼져 있으면(`auto_recover=false`) AWS 쓰기(update) 호출 없이 바로 `needs_action` (원인 수집용 읽기 전용 `describe` 는 그 전에 한 번 부른다). 켜져 있으면 같은 백그라운드 태스크 안에서 아래 "자동 복구"로 넘어간다.
- **마지막 실패 이후 연속 정상이 `RECOVERY_VERIFY_OK_COUNT`(기본 3)번**이 되면 `open`·`needs_action` 인시던트를 `resolved`(+`resolved_at`)로 닫는다 (한 번 정상으로 닫지 않는다 - 자주 죽었다 살아나는 앱이 알림을 쏟아내지 않게). `recovering`은 감시가 닫지 않는다 (복구 쪽이 검증 뒤에 직접 닫는다).
- 새 버전이 배포되어 새 릴리스가 쌓이면 그 배포의 `needs_action` 인시던트는 `resolved` 로 닫히고 `summary` 끝에 " (새 버전 배포로 종료)" 가 붙는다 (알림 없음). `open`·`recovering` 은 건드리지 않는다.
- 헬스체크 주소가 배포의 `endpoint` 와 호스트가 다르면(예: `health_check_path` 가 `@evil.tld/`) 요청하지 않고 실패(`주소가 올바르지 않습니다`)로 기록한다.
- 서버를 다시 켤 때 끊긴 인시던트를 정리한다: `recovering` 은 `needs_action`(진행 중이던 조치는 `failed`, 사유 "서버가 다시 시작되어 …"), 처리 중이던 `open` 은 배포가 `running` 이고 자동 복구가 켜져 있으면 처리를 다시 띄우고 아니면 `needs_action`.

### 자동 복구 (서버 안 - API 아님)

Hard rule 3 의 자동 조치는 두 가지뿐이다. **재시작**(서비스를 같은 이미지로 갱신)과 **이전 정상 이미지로 되돌리기**. 삭제·사양 변경·크기 조절은 하지 않는다. 호출하는 AWS 쓰기는 `update_express_gateway_service` 하나다.

| 인시던트 `kind` | 순서 |
|---|---|
| `bad_release` | 되돌리기만. 되돌릴 대상이 없으면 AWS 호출 없이 `needs_action` |
| 그 밖 (`unhealthy` `crash_loop`) | 재시작 -> 안 풀리면 되돌리기. 되돌릴 대상이 없으면 재시작만 해 보고 `needs_action` |

- 되돌릴 대상: `deploy_releases` 의 `previous` 중 정상으로 확인된 적이 있고(`healthy_since`) 이미지가 남아 있으며 현재 이미지와 다른 것.
- 매 조치 직전(그리고 AWS 갱신 호출 바로 앞에서 한 번 더) 코드가 다시 확인한다: 인시던트가 `open`·`recovering`, 배포가 `running`, `auto_recover` 켜짐, `service_arn` 있음, 한도 안. 하나라도 어긋나면 AWS 쓰기(update) 호출 없이 사유를 `evidence` 끝에 적고 `needs_action`.
- 한도(설정): 인시던트당 `RECOVERY_MAX_ATTEMPTS_PER_INCIDENT`(2 - 재시작 1 + 되돌리기 1), 배포당 24시간에 `RECOVERY_DAILY_LIMIT`(6). 배포마다 잠금이 있어 같은 배포에 재시작·되돌리기가 겹쳐 돌지 않는다.
- 조치마다 `recovery_actions` 한 줄(`running` -> `ok|failed`, 사유 마스킹): 갱신 호출 -> 완료 대기 -> `RECOVERY_WAIT_SECONDS`(120초) 기다린 뒤 15초마다 같은 주소를 점검해 `RECOVERY_VERIFY_SECONDS`(300초) 안에 `RECOVERY_VERIFY_OK_COUNT`(3)번 연속 정상이면 성공 -> 인시던트 `resolved` + `incident_recovered` 알림. 실패하면 다음 조치, 더 없으면 `needs_action` + `incident_needs_action` 알림.
- 되돌리기가 성공하면 배포의 `image_uri`·`commit_sha` 가 이전 릴리스 값으로 바뀌고, 나쁜 릴리스는 `failed`, 이전 릴리스는 `current`, 나쁜 커밋은 `deploys.bad_commit_sha` 에 기억된다. 감시(폴링·웹훅)는 그 커밋을 다시 배포하지 않고 "새 커밋 있음" 표시만 한다. 더 새로운 커밋이 오면 막힘이 풀린다.
- 되돌리기 중 AWS 는 이전 이미지가 됐는데 배포 기록 반영이 3번 모두 실패하면 조치를 `failed`(사유에 이 사실을 적는다) + `needs_action`. 사용자가 새로 배포하기 전까지 자동 복구는 다시 돌지 않는다. 복구 도중 사용자가 배포를 바꿨으면(상태·이미지가 달라짐) 기록을 덮어쓰지 않고 `needs_action`.
- **미검증**: 같은 이미지로 갱신했을 때 Express Mode 가 실제로 작업을 다시 시작하는지, 이미지 갱신으로 되돌리기가 실제로 되는지는 실제 AWS 에서 확인하지 않았다 (`docs/aws-notes.md` "운영 복구"). 로그·이벤트 수집과 운영 에이전트(`docs/app-web` D12)는 아직 없다 - 원인 설명은 규칙 표(`source: "rule"|"none"`)뿐이다.

### `Incident_Read` / `Incident_Detail`

```json
{
  "i_id": 7, "d_id": 2, "kind": "unhealthy", "status": "open",
  "summary": "앱이 오류로 응답하고 있습니다.",
  "explain": {
    "summary": "앱이 오류로 응답하고 있습니다.",
    "cause": "앱이 떠 있지만 헬스체크 요청에 서버 오류(5xx)로 답하고 있습니다. …",
    "fix_where": "AWS 콘솔 ECS 서비스의 로그 탭(CloudWatch Logs)에서 오류 메시지를 확인하고, 해당 코드가 있는 레포 파일을 고칩니다.",
    "actions": ["로그에서 마지막 오류 줄을 확인합니다."],
    "source": "rule"
  },
  "evidence": "서비스 상태: ACTIVE (-)\n최근 헬스체크:\n- 2026-11-09 03:12:00 실패 코드=503 …",
  "detected_at": "2026-11-09T03:12:30", "resolved_at": null,
  "created_at": "…", "updated_at": "…",
  "actions": [
    { "r_a_id": 11, "i_id": 7, "action": "restart", "d_r_id": null, "result": "failed", "detail": "…", "started_at": "…", "finished_at": "…" }
  ]
}
```

- `Incident_Read`는 `actions`만 없다. `explain`은 저장된 JSON을 푼 객체이고, 아직 만들어지기 전(또는 읽을 수 없으면)이면 null. `source`: `rule` `llm` `none`.
- `fix_where`는 사용자 레포·설정·콘솔 위치를 가리키는 안내 문장이다. 마법사가 사용자 코드를 고치지는 않는다.
- `explain`·`evidence`·`summary`는 저장 전에 마스킹한다 (토큰이 섞여 나가지 않는다).
- `actions[]`는 `started_at` 순서 (자동 복구가 한 재시작·되돌리기 기록).

## Notifications · Devices (D1 - 알림, 앱 안·메일·Expo 푸시)

설계는 `docs/app-web/04-api-spec.md` §4·5·7.

소유권 (로그인 계획 Task 7):
- `AUTH_ENABLED=true`: 알림 목록·읽지 않은 수·읽음·모두 읽음은 내 것만 (`notifications.u_id` = 대상 배포의 주인). 남의 `n_id`·`p_d_id`는 404. 설정은 사용자마다 한 줄 (처음 읽을 때 기본값으로 만든다; 같은 사용자의 첫 읽기가 동시에 와도 500 없이 먼저 만든 줄을 읽는다).
- 모드를 바꿔도 알림 대상은 배포에 저장된 주인(`deploys.u_id`)을 따른다: 로그인을 켠 동안 만든 배포는 `AUTH_ENABLED=false` 로 되돌려도 주인을 그대로 가지므로, 그 배포의 알림은 계속 그 주인의 설정·기기·이메일로 간다 (끔 모드의 id=1 설정·`MAIL_TO`·전체 기기는 주인 없는 배포에만 쓰인다). 주인 없는 배포의 알림은 켬 모드에서 주인 없는 기기에만 간다.
- 계정 삭제(`DELETE /api/me`)는 지우는 배포·인시던트를 가리키는 알림을 주인이 누구든(주인 없음 포함) 함께 지운다.
- `POST /api/devices`는 기기의 주인을 현재 사용자로 저장한다. 같은 토큰을 다른 사용자가 등록하면 그 사용자 기기로 옮긴다 (행은 하나). 토큰은 DB 에 Fernet 암호문(`Encrypted_Text`)으로, 찾기는 `expo_token_bidx`(블라인드 인덱스)로만 한다. 응답은 그대로 (끝 6자리만).
- 발송: 배포·인시던트 알림은 그 배포 주인의 설정·기기·이메일(로그인한 Google 이메일)로만 간다. 주인 없는 배포(옛 기록·인증 끔)는 `id=1` 설정과 `MAIL_TO`. 푸시는 인증 끔이면 지금처럼 전체 기기, 인증 켬이면 주인 없는(`u_id` null) 기기에만 간다 (사용자 기기에는 가지 않는다). 이메일 주소는 알림 줄·오류 문장·로그에 남지 않는다.
- `AUTH_ENABLED=false`: 사용자 필터 없이 지금과 같다 (설정은 `id=1` 줄).

| Method | Endpoint | 설명 | 성공 |
|--------|----------|------|------|
| GET | `/api/notifications?after=&unread=` | 앱 안 알림 목록(`channel=inapp`), 최신순 100건 | 200 `Notification_Read[]` |
| GET | `/api/notifications/unread-count` | 읽지 않은 수 | 200 `{ "count": 2 }` |
| POST | `/api/notifications/{n_id}/read` | 한 건 읽음 (이미 읽은 건 그대로) | 200 `Notification_Read` |
| POST | `/api/notifications/read-all` | 모두 읽음 | 200 `{ "updated": 3 }` |
| GET | `/api/notifications/settings` | 알림 설정 | 200 `Notification_Setting_Read` |
| PATCH | `/api/notifications/settings` | 알림 설정 일부 수정 | 200 `Notification_Setting_Read` |
| POST | `/api/devices` | 푸시 기기 등록 `{expo_token, platform}` (같은 토큰이면 갱신) | 201 `Device_Read` |
| DELETE | `/api/devices/{p_d_id}` | 기기 등록 해제 | 200 `{ "message": "…" }` |

- `after` 는 `n_id` 커서(1 이상, 아니면 422) - 그보다 오래된 것부터 최신순 100건. `unread=true` 면 읽지 않은 것만. 없는 `n_id`(또는 앱 안 알림이 아닌 줄)는 404 `해당 id의 알림이 없습니다`.
- `expo_token` 은 `^(Exponent|Expo)PushToken\[.+\]$` 형식, `platform` 은 `android` 만 (아니면 422. 허용 값은 `features/notifications/scheme.py` 의 `SUPPORTED_PUSH_PLATFORMS`, iOS 는 2026-11-16 에 뺐다). 없는(또는 남의) `p_d_id` 는 404 `해당 id의 기기가 없습니다`.
- 설정은 사용자마다(인증 끔이면 `id=1`) 한 줄이고 처음 읽을 때 기본값(메일 켬, 푸시 켬, 일곱 종류 모두)으로 만든다. PATCH 본문에 모르는 항목이나 모르는 `kinds` 값이 있으면 422.

### `Notification_Read`
```json
{ "n_id": 31, "d_id": 2, "i_id": 7, "kind": "incident_recovered", "channel": "inapp", "title": "서비스를 되돌려 복구했습니다",
  "body": "무슨 일: …", "status": "sent", "read_at": null, "sent_at": "…", "created_at": "…" }
```

### `Device_Read` (토큰 전체는 응답에 없다 - 끝 6자리만)
```json
{ "p_d_id": 1, "platform": "android", "token_tail": "yz789]", "created_at": "…", "last_seen_at": "…" }
```

### `Notification_Setting_Read` / PATCH 본문
```json
{ "notify_email": true, "notify_push": false, "kinds": ["incident_opened", "incident_recovered", "incident_needs_action", "deploy_succeeded", "deploy_failed", "new_commit", "plan_exceeded"] }
```
PATCH 는 보낸 항목만 바꾼다 (`notify_email`·`notify_push` 는 true/false, `kinds` 는 위 일곱 가지 중 일부).

옛 설정 보정: `plan_exceeded` 가 생기기 전에 저장된 설정(내부 `kinds_version` 이 비어 있음)을 처음 읽을 때, 목록이 예전 기본 여섯 가지와 같으면 `plan_exceeded` 를 더해 일곱 가지로 바꾼다 (한 번만). 일부 종류를 일부러 끈 목록은 그대로 둔다. `kinds` 를 PATCH 하면 그 선택이 최종이라 이후 여섯 가지만 보내 `plan_exceeded` 를 끄면 다시 켜지지 않는다. `kinds_version` 은 응답에 나오지 않는다.

### 알림이 만들어지는 때 (서버 안 - API 아님)

| `kind` | 언제 |
|--------|------|
| `incident_opened` | 인시던트의 원인 설명이 저장된 직후 |
| `incident_recovered` | 복구 시도가 있었던 인시던트가 정상으로 돌아왔을 때 |
| `incident_needs_action` | 자동 복구로 풀지 못했거나 자동 복구가 꺼져 있어 사람이 봐야 할 때 |
| `deploy_succeeded` | 파이프라인이 `running` 에 닿았을 때 |
| `deploy_failed` | 파이프라인이 `failed` 로 멈췄을 때 |
| `new_commit` | 자동 재배포가 꺼진 배포에서 새 커밋을 처음 봤을 때 (커밋마다 한 번) |
| `plan_exceeded` | `running` 배포가 예정한 사용 시간(`planned_hours`)을 `running_since` 부터 넘겼을 때 (감시 루프가 1분마다 점검, 알림만 - 멈추거나 지우지 않는다). 시작 기록이 새로 생기거나 예정 시간을 바꾸면 다시 알린다 |

- 종류가 설정에서 꺼져 있으면 아무것도 만들지 않는다. 켜져 있으면 `inapp` 줄을 항상 남기고, `notify_email` 이 켜져 있고 `MAIL_HOST`·`MAIL_TO` 가 있으면 `email` 줄, `notify_push` 가 켜져 있고 등록된 기기가 있으면 `push` 줄을 남긴다 (`queued` -> `sent|failed`, 실패 이유는 마스킹한 `error`). 메일 설정이 없으면 줄도 남기지 않는다.
- 인시던트 알림은 (인시던트, `kind`, 채널)마다 한 줄 - 같은 알림을 다시 보내려 해도 건너뛴다. `new_commit` 은 (배포, 커밋, 채널)마다 한 줄.
- 본문 순서: 무슨 일 -> 왜 -> 어디를 고치나(`explain.fix_where`) -> 자동으로 한 일과 결과(`recovery_actions`) -> 앱 링크(`APP_LINK_BASE` + `incidents/{i_id}` 또는 `deploys/{d_id}`). 제목·본문은 모두 `mask_text` 를 거친다.
- 메일: STARTTLS + 로그인, 제목 `[배포 마법사] {서비스 이름} {제목}`, 제한 시간 `MAIL_TIMEOUT_SECONDS`(10초).
- 푸시: `EXPO_PUSH_URL` 로 기기마다 `{to, title, body, data:{link}}` 한 건씩 100건 묶음 POST (제한 시간 `EXPO_PUSH_TIMEOUT_SECONDS`, 10초). 본문은 120자 이하 한 줄이고 로그 원문은 넣지 않는다. 응답 표의 `details.error == "DeviceNotRegistered"` 인 기기는 지운다.
- 느린 SMTP·Expo 가 흐름을 붙잡지 않는다 - 헬스 감시 경로의 복구 알림과 파이프라인·폴링·웹훅의 알림은 백그라운드 태스크로 보낸다. 어떤 채널이 실패해도 인시던트 처리·파이프라인·폴링은 멈추지 않는다.

## 기타

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/health` | 서버 확인 `{ "message": "ok" }` |
| GET | `/*` | `dist/`가 있으면 빌드된 화면을 서빙 (SPA 대체 경로 포함) |
