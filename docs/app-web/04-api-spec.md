# API 명세서 (신규·변경분)

기존 엔드포인트는 `docs/api-spec.md`와 같다. 여기에는 **새로 생기는 것**과 **기존 것의 변경**만 적는다. 에러는 지금처럼 `{ "detail": "한국어 메시지" }`.

## 0. 공통

**Base URL**: 개발 `http://localhost:8081` · 상용 `https://<서버 주소>` (D7 미정)

> **구현 상태 (2026-11-17)**: 이 절과 §1 은 로그인 계획(`feat/login-backend`)으로 구현되었다. 실제 동작·상태 코드·문구의 기준은 [`docs/api-spec.md`](../api-spec.md)의 "인증 공통"·"Auth"다. 아래는 설계 기록이고 달라진 곳을 표시했다. `AUTH_ENABLED` 기본은 `false`(웹 로그인 화면이 생기기 전까지)이다.

**인증**: `AUTH_ENABLED=true` 일 때 `Authorization: Bearer <access_token 또는 개인 토큰(dwp_…)>`. 웹은 리프레시 토큰을 httpOnly 쿠키(`dw_refresh`)로, 앱은 본문으로 주고받는다. MCP 는 개인 토큰(PAT)을 `WIZARD_API_TOKEN` 으로 보낸다.

**로그인 끔 (`AUTH_ENABLED=false`, 기본)**: 인증 헤더를 요구하지 않고 소유권 필터도 없다. 서버는 "현재 사용자"를 한 의존성(`current_user`)으로만 얻으므로, 켜면 모든 `/api/*`가 토큰 검증을 거친다 (공개 경로는 `PUBLIC_PATHS`).

**소유권 (`AUTH_ENABLED=true`)**: 모든 목록은 현재 사용자의 것만 돌려준다. 남의 `d_id`, `c_id` 등을 부르면 **404** (존재 여부를 숨긴다).

| 코드 | 의미 |
|---|---|
| 401 | 토큰이 없거나 만료 → 클라이언트가 리프레시를 한 번 시도하고, 실패하면 로그인 화면 |
| 404 | 없거나 내 것이 아님 |
| 409 | 지금 상태에서 할 수 없는 동작 |
| 429 | 요청이 너무 많음 (상용 단계) |

## 1. Auth (3단계) — 구현됨

| Method | Endpoint | 설명 | 성공 |
|---|---|---|---|
| POST | `/api/auth/google` | Google `id_token`을 검증하고 사용자를 만들거나 찾아 토큰 발급 | 200 `Auth_Token` |
| POST | `/api/auth/refresh` | 리프레시 토큰으로 새 토큰 발급 (회전: 쓴 토큰은 폐기) | 200 `Auth_Token` |
| POST | `/api/auth/logout` | 현재 리프레시 토큰 폐기 | 200 `{message}` |
| GET | `/api/me` | 내 정보 | 200 `User_Read` |
| ~~PATCH~~ | ~~`/api/me/settings`~~ | **만들지 않았다** — 알림 설정은 기존 `GET`·`PATCH /api/notifications/settings` 를 사용자별 한 줄로 쓴다 | - |
| POST·GET·DELETE | `/api/auth/tokens`, `/api/auth/tokens/{a_t_id}` | **신규** 개인 토큰(PAT) 만들기·목록·폐기. 로그인(액세스 토큰)으로만 부를 수 있다 | 201·200 |
| DELETE | `/api/me` | 계정 삭제. 본문 `{confirm: true}`. 살아 있는 배포가 있으면 409와 목록 | 200 `{message}` |

### POST `/api/auth/google`
```json
{ "id_token": "<Google이 발급한 ID 토큰>", "platform": "web" }
```
- 서버는 서명, `aud`(우리 클라이언트 ID), `exp`, `iss`를 검증한다. 하나라도 어긋나면 401.
- `platform`: `web|android` (ios 추가 가능). 클라이언트 ID가 플랫폼마다 다르다 (`GOOGLE_CLIENT_ID_WEB`·`GOOGLE_CLIENT_ID_ANDROID`). 허용 플랫폼은 `features/auth/scheme.py` 의 `LOGIN_PLATFORMS` 매핑 하나가 정한다 — iOS 를 더할 때는 그 매핑에 한 줄, `GOOGLE_CLIENT_ID_IOS` 설정, 푸시 기기용 `SUPPORTED_PUSH_PLATFORMS`(`features/notifications/scheme.py`)에 `ios` 를 넣는다 ([iOS 제거](./README.md#ios-제거-2026-11-16-사용자-결정)).
- 로그인은 `AUTH_ALLOWED_EMAILS` 허용 목록의 이메일만 된다 (D-L1, 비면 아무도 못 한다).

### `Auth_Token`
```json
{ "access_token": "…", "expires_in": 900, "refresh_token": "…", "user": { "u_id": 1, "email": "…", "name": "…" } }
```
웹 응답에서는 `refresh_token`을 본문에 넣지 않고 `Set-Cookie`로 준다 `[가정]`. 리프레시 토큰이 이미 쓴 것이면 그 계열 전체를 폐기하고 401.

### `User_Read`
```json
{ "u_id": 1, "email": "me@example.com", "name": "홍길동", "picture_url": "…" }
```
`notify_email`·`notify_push` 는 `User_Read` 에 없다 (알림 설정 API 로 본다).

## 2. Deploys (변경)

| 변경 | 내용 |
|---|---|
| 모든 엔드포인트 | 3단계부터 인증 필요, 소유권 필터 |
| `Deploy_Read` 필드 추가 | `auto_recover`(bool), `health_state`(`healthy\|unhealthy\|unknown`), `last_health_at`, `open_incident_id`(없으면 null), `open_incident_status`(`open\|recovering\|needs_action`, 없으면 null) |
| **신규** `PATCH /api/deploys/{d_id}/settings` | `{auto_redeploy?, auto_recover?}` — 보내지 않은 쪽은 그대로 | 200 `Deploy_Read` |
| **신규** `GET /api/deploys/{d_id}/health-history?hours=24` | 헬스 결과를 시간순으로 (최대 1440건) | 200 `Health_Check_Read[]` |
| **신규** `GET /api/deploys/{d_id}/releases` | 배포된 버전 목록 (되돌리기 대상 확인용) | 200 `Release_Read[]` |

`status` 값은 늘리지 않는다 (복구 중인지는 인시던트가 가진다).

### `Health_Check_Read`
```json
{ "h_c_id": 9001, "ok": false, "status_code": 502, "latency_ms": 5000, "detail": "시간 초과", "checked_at": "2026-11-09T03:12:00" }
```

### `Release_Read`
```json
{ "d_r_id": 4, "commit_sha": "089917e", "image_uri": "…", "state": "previous", "healthy_since": "2026-11-08T10:00:00", "created_at": "…" }
```

### 배포 수준·비용 추천 (1단계)

| Method | Endpoint | 설명 | 성공 |
|---|---|---|---|
| POST | `/api/deploys/advice` | 레포를 읽기만 해서 추천을 돌려준다. 배포 기록을 만들지 않고 AWS를 부르지 않는다 | 200 `Deploy_Advice` |
| POST | `/api/deploys` (변경) | 선택 필드 `size_tier`를 받는다. 없으면 추천 수준을 쓴다 | 201 `Deploy_Read` |

`POST /api/deploys/advice` 본문은 배포 만들기와 같은 `{repo_url, branch?, aws_account_id?, github_installation_id?}`. 서버는 임시 폴더에 얕게 클론해 분석하고 지운다 (`repo_url|커밋` 기준 캐시 `[가정]`). 주소·브랜치 검증은 배포 만들기와 같다 (400). private 레포는 연결된 설치 토큰으로 읽는다.

`Deploy_Advice`:
```json
{
  "tier": "medium",
  "confidence": "medium",
  "cpu": null, "memory": null,
  "cost": { "monthly_min": null, "monthly_max": null, "currency": "USD", "basis_date": null, "note": "트래픽에 따라 늘어납니다" },
  "reasons": ["pandas와 numpy를 사용해 메모리를 넉넉히 잡았습니다 (requirements.txt)"],
  "needs": [
    { "kind": "database", "supported": false, "message": "DB를 쓰는 것으로 보입니다. 마법사가 아직 DB를 만들어 주지 못합니다." },
    { "kind": "env_vars", "supported": true, "count": 4 }
  ],
  "unknowns": ["환경변수 MY_THING_URL의 종류를 알 수 없습니다"],
  "language": "python", "support_level": "official", "app_dir": "backend"
}
```
- `cpu`, `memory`, `cost`의 숫자는 **Express Mode 허용 조합과 단가를 검증하기 전까지 null**이다. 클라이언트는 null이면 "아직 계산할 수 없음"을 보여 준다.
- `needs[].kind`: `database cache worker env_vars disk_write static_site`
- 읽기 전용 요청이라 3단계부터도 소유권 필터(연결 블록)만 거친다.

### 환경변수 (1단계)

| Method | Endpoint | 설명 | 성공 |
|---|---|---|---|
| GET | `/api/deploys/{d_id}/env` | 찾은 환경변수 목록. 값은 절대 포함하지 않는다 | 200 `Deploy_Env_Read[]` |
| PUT | `/api/deploys/{d_id}/env/{name}` | 값 입력 또는 종류 지정 또는 건너뛰기. 목록에 없는 이름이면 직접 추가(`source=user`) | 200 `Deploy_Env_Read` |
| DELETE | `/api/deploys/{d_id}/env/{name}/value` | 저장된 값 지우기 (우리가 만든 보안 저장소 항목 포함) | 200 `Deploy_Env_Read` |
| POST | `/api/deploys/{d_id}/env/continue` | 입력을 마치고 이어서 배포. 값 없는 필수 변수가 남았으면 409와 목록 | 200 `Deploy_Read` |

`PUT` 본문 (보낸 필드만 바뀐다):
```json
{ "value": "…", "kind": "database", "skip": false }
```
- `value`는 쓰기 전용이다. 서버는 로그·에러·응답 어디에도 값을 싣지 않는다.
- `skip: true`는 "필수로 보이지만 이 배포에는 필요 없다"는 뜻이다.
- `kind`는 사용자가 `unknown`을 직접 분류할 때 쓴다. 허용 값은 `database cache external_api secret config`.
- 배포가 `deploying` 이후(`running`, `stopped`)일 때 값을 바꾸면 응답에 `needs_redeploy: true`를 담는다. 서버가 자동으로 재배포하지 않는다 (규칙 3).

`Deploy_Env_Read`:
```json
{ "d_e_id": 3, "name": "MY_THING_URL", "required": true, "has_default": false, "kind": "unknown",
  "source": "code", "source_hint": "app/config.py:12", "status": "detected", "has_value": false, "needs_redeploy": false }
```
`source`: `code compose example readme runtime_error user` · `status`: `detected set skipped`

환경변수 목록은 `Deploy_Read`에 `env_pending`(값이 없는 필수 변수 수)을 추가해서 목록 화면이 배지로 알릴 수 있게 한다.

## 3. Incidents (2단계)

| Method | Endpoint | 설명 | 성공 |
|---|---|---|---|
| GET | `/api/incidents?status=&d_id=&after=` | 내 인시던트 목록 (최신순) | 200 `Incident_Read[]` |
| GET | `/api/incidents/{i_id}` | 인시던트 한 건과 복구 시도 이력 | 200 `Incident_Detail` |
| GET | `/api/deploys/{d_id}/incidents` | 한 배포의 인시던트들 | 200 `Incident_Read[]` |

인시던트는 서버가 만들고 닫는다. 사용자가 직접 만들거나 지우는 API는 없다. 사용자가 할 수 있는 동작은 기존 [다시 배포] [멈춤] [삭제]이고, 이것들은 확인 대화상자를 거친다.

### `Incident_Detail`
```json
{
  "i_id": 7, "d_id": 2, "kind": "unhealthy", "status": "resolved",
  "summary": "서비스가 응답하지 않아 재시작했습니다",
  "explain": {
    "summary": "앱이 시작 직후 종료되고 있었습니다.",
    "cause": "환경변수 DATABASE_URL이 없어 시작 중 예외가 발생했습니다.",
    "fix_where": "app/config.py 의 DATABASE_URL 읽는 부분, 또는 배포 환경변수 설정",
    "actions": ["환경변수를 추가한 뒤 [다시 배포]를 누르세요."],
    "source": "rule"
  },
  "detected_at": "2026-11-09T03:12:30", "resolved_at": "2026-11-09T03:16:10",
  "actions": [
    { "r_a_id": 11, "action": "restart", "result": "failed", "detail": "재시작 후에도 응답 없음", "started_at": "…", "finished_at": "…" },
    { "r_a_id": 12, "action": "rollback", "d_r_id": 3, "result": "ok", "detail": null, "started_at": "…", "finished_at": "…" }
  ]
}
```
`fix_where`는 사용자 레포의 파일·설정을 가리키는 **안내 문장**이다. 마법사가 사용자 코드를 고치지는 않는다 `[가정]`.

`kind`: `unhealthy` `crash_loop` `bad_release` `unknown` · `status`: `open` `recovering` `resolved` `needs_action`

## 4. Notifications (2단계)

| Method | Endpoint | 설명 | 성공 |
|---|---|---|---|
| GET | `/api/notifications?after=&unread=` | 앱 안 알림 목록 (`channel=inapp`) | 200 `Notification_Read[]` |
| GET | `/api/notifications/unread-count` | 읽지 않은 수 (탭 뱃지용) | 200 `{count}` |
| POST | `/api/notifications/{n_id}/read` | 읽음 | 200 `Notification_Read` |
| POST | `/api/notifications/read-all` | 모두 읽음 | 200 `{updated}` |

### `Notification_Read`
```json
{ "n_id": 31, "kind": "incident_recovered", "title": "서비스를 되돌려 복구했습니다", "body": "…", "d_id": 2, "i_id": 7, "read_at": null, "created_at": "…" }
```

## 5. Devices (2단계, 앱)

| Method | Endpoint | 설명 | 성공 |
|---|---|---|---|
| POST | `/api/devices` | 푸시 토큰 등록 (같은 토큰이면 갱신) `{expo_token, platform}` | 201 `Device_Read` |
| DELETE | `/api/devices/{p_d_id}` | 등록 해제 (로그아웃·알림 끔) | 200 `{message}` |

발송이 "기기 없음/토큰 무효"로 실패하면 서버가 그 기기를 정리한다.

## 6. Accounts (변경)

기존 엔드포인트는 그대로이고, 앱을 위해 두 가지가 바뀐다.

| 변경 | 내용 |
|---|---|
| `GET /api/accounts/github/install-url` | `?return=app\|web` 추가. 앱이면 `state`에 담아 두었다가, 콜백이 `deploywizard://accounts?connected=github`로 보낸다 |
| `GET /api/accounts/github/callback` | `state`로 돌려보낼 곳(웹 주소 또는 앱 딥링크)을 정한다. 지금은 웹 `/accounts`만 |
| `Aws_Account_Setup.our_account_id` 등 | 변경 없음 |

모든 계정·연결 엔드포인트는 3단계부터 인증과 소유권 필터가 붙는다. `installation_id`는 이미 다른 사용자가 연결한 것이면 콜백이 저장 없이 `/accounts?connected=github_taken` 으로 돌려보낸다 (구현: 409 가 아니라 리다이렉트 쿼리). 콜백은 서명된 `state`(HS256, 15분)로 보호하고 공개 경로다.

## 7. 서버가 보내는 것 (클라이언트가 부르는 API가 아님)

### 푸시 (Expo Push)
```json
{ "to": "ExponentPushToken[…]", "title": "서비스를 되돌려 복구했습니다", "body": "my-api · 직전 버전으로 되돌림", "data": { "link": "deploywizard://incidents/7" } }
```
`data.link`로 알림 탭 이동(E-06). 본문에는 토큰·키·원문 로그를 넣지 않는다.

### 메일
제목: `[배포 마법사] my-api 서비스를 되돌려 복구했습니다`
본문 순서: ① 무슨 일이 있었나 ② 왜 ③ **어디를 고쳐야 하나**(`fix_where`) ④ 마법사가 자동으로 한 일과 결과 ⑤ 앱·웹 링크. 내용은 `mask_text`를 거친 `incident.explain`과 같은 원천을 쓴다.

## 8. 웹훅·내부 (변경 없음)

`POST /api/watches/webhook`은 인증 대신 HMAC 서명을 쓰므로 로그인 대상이 아니다.
`GET /api/health`는 인증 없이 열어 둔다 (로드밸런서·감시용).
