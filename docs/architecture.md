# 아키텍처

## 구조 — 기능별로 나눈다

```
/
├── CLAUDE.md
├── README.md
├── docs/
├── main.py                     ← FastAPI 진입점. 라우터를 모으고 dist/ 를 서빙
├── index.html · vite.config.js · package.json   ← 화면 빌드 도구 (루트에서 실행)
│
├── features/                   ← ★ 기능 하나 = 폴더 하나 (서버 + 화면)
│   ├── deploys/                ← 배포 기록, 파이프라인 조립
│   │   ├── models.py  scheme.py  crud.py  services.py  router.py
│   │   ├── pipeline.py         ← 다른 기능의 services 를 순서대로 부른다
│   │   └── ui/                 ← DeployListPage, DeployDetailPage, …
│   ├── repos/                  ← scheme.py  services.py
│   ├── dockerfiles/            ← scheme.py  services.py  templates/
│   ├── builds/                 ← services.py
│   ├── express/                ← scheme.py  services.py
│   ├── explains/               ← scheme.py  services.py  ui/
│   ├── envvars/                ← models.py  scheme.py  crud.py  scan.py  services.py  router.py  (환경변수 이름 감지·입력)
│   ├── advice/                 ← scheme.py  services.py  router.py  (배포 전 분석, DB 없음)
│   ├── pricing/                ← scheme.py  services.py  router.py  ui/  (비용 확인 - AWS 공개 가격 파일 읽기·캐시·추정, DB·AWS 호출 없음)
│   ├── accounts/               ← scheme.py  crud.py  services.py  router.py  cloudformation/  ui/  (M6, 진행 중)
│   ├── watches/                ← services.py 만 (DB 없음, 상태는 Deploy에)  (M6, 진행 중 - 폴링만 완료)
│   ├── health/                 ← models.py  scheme.py  crud.py  services.py  (D1 - 1분마다 헬스체크 이력, 감시 루프)
│   ├── incidents/              ← models.py  scheme.py  crud.py  services.py  recovery.py  recovery_state.py  router.py  ui/  (D1 - 인시던트, 규칙 표 설명, 자동 복구; recovery_state 는 기록 반영 재시도·서버 재개. ui/ 는 계획 E)
│   ├── notifications/          ← models.py  scheme.py  crud.py  services.py  compose.py  dispatch.py  inbox.py  router.py  ui/  (D1 - 앱 안·메일·푸시 알림, 기기, 설정. ui/ 는 계획 E)
│   └── mcp/                    ← client.py  guard.py  scheme.py  services.py  server.py  __main__.py  (로컬 MCP 서버, DB·라우터 없음)
│
├── shared/                     ← 모든 기능이 쓰는 것
│   ├── settings.py             ← 환경변수 (pydantic-settings)
│   ├── database.py             ← async 엔진, 세션, Base, ensure_columns (옛 DB 열 보정), bootstrap_schema (서버 시작·scripts 가 같이 쓰는 표 만들기+열 보정)
│   ├── specs.py                ← 사양 프리셋 쌍 4개와 .env 기본 사양 검사 (features/pricing·express 가 같이 쓴다)
│   ├── aws_session.py          ← 세션 주입 (내 계정 / AssumeRole)
│   ├── llm.py                  ← 구조화 출력 전용 LLM 클라이언트
│   ├── masking.py              ← 토큰 마스킹
│   ├── proc.py                 ← git·docker 실행
│   └── ui/                     ← main.jsx, App.jsx, api.js, styles.css
│
├── app/                        ← Expo 모바일 앱 (독립 패키지, 서버·웹 코드를 가져오지 않음). src/components/ 에 한 화면 틀 FitScreen·FooterSlot, 설정 타일 SettingTile, ops/NotificationKinds (계획 F), 한글 어절 줄바꿈 `Text` 래퍼 `components/Text.js`, 인시던트 탭 `ops/IncidentTabs`·`ops/IncidentFacts` (계획 G, app/README.md)
├── scripts/                    ← setup_roles, m1_deploy, deploy_cli, cleanup
└── tests/                      ← pytest(*.py) + web/ (화면 로직 node:test, 계획 E)
```

### 왜 백/프론트로 나누지 않는가

"배포 목록에 헬스 상태를 붙인다" 같은 변경은 모델·서비스·라우터·화면을 한 번에 건드린다. 계층별로 나누면 네 폴더를 오가지만, 기능별로 나누면 `features/deploys/` 하나에서 끝난다. 기능을 통째로 지우거나 옮기기도 쉽다.

파이썬과 자바스크립트는 도구가 다르므로, 빌드 설정(`requirements.txt`, `package.json`, `vite.config.js`)만 루트에 나란히 둔다. Vite는 `@features`, `@shared` 별칭으로 각 기능의 `ui/`를 가져온다.

## 의존 방향

```
features/*  → shared/*      ✅
shared/*    → features/*    ❌
features/A  → features/B    services 끼리만 ✅ (B의 crud·models 를 직접 부르지 않는다)
ui/         → 같은 기능의 api.js, shared/ui, 다른 기능의 ui 컴포넌트 ✅
```

기능 조립은 `features/deploys/pipeline.py` 한 곳에서만 한다. `repos`·`dockerfiles`·`builds`·`express`·`explains`는 서로를 모른다 (예외: `dockerfiles`는 레포 요약을 위해 `repos`의 services 를 쓴다). `envvars`는 `deploys`가 파이프라인(분석 단계 저장, 배포 직전 값 확인, 컨테이너에 넣을 값)과 목록의 `env_pending`을 채우려고 services 로만 부른다. 반대로 `envvars`가 배포 존재를 확인하려고 `deploys`의 services 를 부르는데, 순환 임포트라 `envvars/services.py`에서는 함수 안에서 지연 임포트한다. `advice`는 DB에 쓰지 않고 `repos`·`envvars`·`accounts`(GitHub 토큰)·`pricing`(비용 채우기)의 services 만 부르며, 아무도 `advice`를 부르지 않는다 — 라우터만 있다. `pricing`은 `shared/settings`만 쓰고 다른 기능을 모른다 — `advice`(비용 채우기)와 `deploys`(만들 때 사양·증설 검사)가 `pricing`의 services 만 부른다 (MCP 는 REST 로 부른다). `accounts`·`watches`는 예외 — `deploys`가 배포에 쓸 AWS/GitHub 세션을 얻으려고 `accounts`의 services 를 부르고(M6, `pipeline.py`·`services_deploy_delete`·`services_deploy_get_remote`에 배선됨), `accounts`도 계정 삭제 시 연결을 끊으려고 `deploys`의 services 를 부른다(순환 임포트라 `accounts/services.py`에서는 함수 안에서 지연 임포트한다). `watches`는 `deploys`(폴링 대상 조회, 재배포 트리거)와 `accounts`(GitHub 토큰)의 services 만 부르고, 아무도 `watches`를 부르지 않는다 — `main.py`가 백그라운드 태스크로 직접 돌린다.

(D1) 운영 복구·알림 세 기능도 services 끼리만 부른다. `health.services`는 `deploys`(점검 대상 조회, 결과 반영)와 `incidents`(점검 결과 훅)를 부른다. `incidents.services`는 `express`(상태 조회)·`accounts`(세션)·`notifications`를, `incidents.recovery`는 거기에 `envvars`(복구 때도 환경변수를 같이 보낸다)를 더해 부르고, 필요할 때 `deploys`·`health`를 부른다. `deploys.services`는 목록의 `open_incident_id`를 채우려고 `incidents`를, `deploys.pipeline`과 `watches`는 알림을 보내려고 `notifications`를 부른다. `notifications.services`는 인시던트·배포를 읽으려고 `incidents`·`deploys`를 부른다. 순환 임포트가 되는 쪽(`incidents`↔`deploys`/`health`, `notifications`↔`incidents`/`deploys`)은 쓰는 함수 안에서 지연 임포트한다. 조립은 원래 `pipeline.py` 한 곳이라는 원칙의 예외가 하나 있다 — `incidents/recovery.py`가 복구 때 `express`의 갱신을 직접 부른다 (배포 파이프라인과 별개로, 이미 떠 있는 서비스에 두 가지 조치만 하는 자리라서).

## 로컬 MCP 서버 (`features/mcp`)

Claude 같은 MCP 클라이언트가 stdio 로 붙는 별도 프로세스(`python -m features.mcp`)다. 서버 모듈(`deploys`·`accounts` 등)을 **임포트하지 않고** `client.py`의 `Wizard_Client`가 REST API 를 HTTP 로 부른다 (주소 `WIZARD_API_URL`, 토큰 `WIZARD_API_TOKEN` 은 2단계용). 그래서 의존 방향은 `features/mcp -> shared/settings`(설정)와 `shared/masking`(`guard.py`의 마스킹) 둘뿐이고, 아무도 `mcp`를 부르지 않는다. 같은 REST 를 웹·앱과 함께 쓰므로 API 스펙은 바뀌지 않는다.

- `services.py`: 도구 로직 (첫 인자 `Wizard_Client`). 응답을 허용 목록 요약으로 줄이고, 로그·오류·해설은 `guard.py`로 마스킹·자른 뒤 "신뢰할 수 없는 데이터" 표시로 감싼다.
- `server.py`: 도구 13개 등록(읽기 8, 행동 5). 행동 도구는 `confirm_token` 이 없으면 미리보기를 만든 뒤, 클라이언트가 elicitation 을 지원하면 사용자에게 직접 묻고, 아니면 미리보기와 확인 토큰(`Confirm_Store`, 5분·1회용·도구와 인자에 묶임)을 돌려준다. 살아 있는 배포 한도(기본 3)는 서비스 한 곳에서 검사한다.
- 자동 조치는 늘리지 않는다 — 확인 없이 AWS 를 바꾸는 도구가 없다 (하드 규칙 3).
- `deploy` 도구는 사양(`cpu`·`memory`)·예정 시간(`planned_hours`)·자동 증설(`min_tasks`·`max_tasks`·`scale_metric`·`scale_target`) 인자를 받고, 미리보기에 `POST /api/pricing/estimate` 결과로 만든 비용 줄(시간당·한 달·예정 시간 금액, 증설 최대치, ARM64 비교, 포함되지 않는 것)을 붙인다. 가격을 못 얻으면 "가격을 가져오지 못했습니다" 한 줄을 넣고 미리보기는 그대로 만든다.
- 한계: elicitation 도 확인 토큰도 사람이 승인했다는 증거가 아니다 (에이전트형 클라이언트가 elicitation 에 스스로 답할 수 있고, 토큰 경로는 모델에게 주는 지시일 뿐이다). 실제 관문은 호스트의 도구별 승인 창이므로 행동 도구 5개를 자동 허용 목록에 넣지 않는다. 서버가 강제하는 것은 살아 있는 배포 한도(`deploy`·`start_deploy`·멈춘/실패한 배포의 `redeploy`)와 토큰 바인딩·만료뿐이다.

## 계층

```
Router → Service → CRUD → Model
```

| 계층 | 역할 | 규칙 |
|------|------|------|
| Router | 엔드포인트 | 로직 없음. `Depends(get_db)`, `response_model` 지정 |
| Service | 비즈니스 로직 | `commit` / `rollback` / `HTTPException` 은 여기서만 |
| CRUD | DB 처리 | `flush` 까지만. 예외를 삼키지 않는다 |
| Model | 테이블 정의 | SQLAlchemy 2.0 `Mapped` |

DB가 없는 기능(`repos`, `builds` …)은 `services.py`만 있다.

## 배포 파이프라인

`POST /api/deploys` → 기록 생성 → `Deploy_Pipeline.pipeline_start(d_id)`가 asyncio 태스크로 실행.

| # | status | 하는 일 | 담당 |
|---|--------|---------|------|
| 1 | `cloning` | `git clone --depth 1` → 커밋 해시. GitHub 연결 있으면 설치 토큰으로 (M6) | `repos`(+`accounts`) |
| 2 | `analyzing` | 매니페스트로 언어 판별(규칙), 인코딩 정리. 이어서 소스에서 환경변수 **이름**만 찾아 `deploy_env_vars`에 저장 (규칙으로 종류 분류, 모르는 것만 AI가 목록 중 하나 선택) | `repos` + `envvars` |
| 3 | `generating` | 정식: 템플릿+LLM 빈칸 (빌드 뒤 **root 가 아닌 사용자**로 실행: Node `node`, Python `app`(uid 10001). 1024 미만 포트는 root 만 열 수 있어 root 유지) / 실험: LLM 순수 생성 / 레포에 Dockerfile 있으면 그대로 (둘 다 사용자 변경 없음) | `dockerfiles` |
| 4 | `building` | `docker build --platform linux/amd64`. 실패 시 Dockerfile 자가수정 (정식 2회·실험 1회) | `builds` + `dockerfiles` |
| 5 | `pushing` | ECR 리포지토리 생성, 로그인(매번 새 토큰), 푸시 | `builds` |
| ⏸ | `needs_input` | 첫 배포에서 값이 빈 필수 환경변수가 있으면 `deploying` 직전에 멈춰 사용자 입력을 기다린다. 실패가 아니라 대기다 — `PROGRESS_STATUSES`에 넣지 않아 재시작 복구(`pipeline_recover`)가 건드리지 않는다. `POST /env/continue`로 `deploying`부터 이어 간다 | `envvars` |
| 6 | `deploying` | Express Mode 서비스 생성(또는 갱신, 일반 설정 값은 `primaryContainer.environment`로) → 배포 완료까지 폴링 | `express` |
| 7 | `running` | 주소 저장 | |
| ✗ | `failed` | 멈춘다. 에러 해설(규칙 → LLM)을 저장한다. **리소스는 지우지 않는다** | `explains` |

- 블로킹 작업(git·docker·boto3)은 `asyncio.to_thread`로 돌린다.
- 로그는 작업 스레드에서 `Deploy_Log_Buffer`에 쌓이고 1초마다 DB에 쓴다. 화면은 `GET /logs?after=`로 새 줄만 가져간다.
- 환경변수 **값**은 로그·API 응답·AI 프롬프트·에러 글 어디에도 싣지 않는다. 스캐너는 `.env` 같은 제외 파일을 열지 않고, `.env.example`·compose는 이름만 읽는다. 로그에는 개수와 이름만 남긴다.
- 서비스 ARN은 **받자마자** 저장한다. 이후에 실패해도 정리할 수 있어야 한다.
- 서버가 재시작되면 진행 중이던 배포는 `failed`로 돌려놓는다 (`pipeline_recover`).
- (M6) 코드 변경 감지 폴링(`Watch_Service.services_watch_poll_loop`)은 `main.py`의 `lifespan()`에서 시작하는 별도 백그라운드 태스크다. `pipeline_recover`(한 번 await, 시작을 막음)와 다르게 서버가 떠 있는 동안 계속 돌고, 종료 시 `cancel()` + await로 정리한다.
- `[다시 배포]`는 처음부터 돌지 않는다. `error_step` 앞의 단계는 저장된 값(커밋, 판별 결과, Dockerfile, 이미지 주소)이 있으면 건너뛴다 (`pipeline_resume_from`). `pushing` 실패는 로컬 이미지가 남아 있을 때만 `building`도 건너뛴다 — `docker image inspect`로 확인한다.
- (M6) ECR 푸시·Express Mode 배포에 쓸 AWS 세션은 `Deploy_Pipeline.pipeline_get_aws_session(deploy.aws_account_id)` → `Aws_Account_Service.services_aws_account_build_session`이 만든다. `aws_account_id`가 없으면 지금까지처럼 개발 세션(M1~M5 그대로), 있으면 그 계정으로 `sts:AssumeRole`. `services_deploy_delete`도 같은 함수로 세션을 만든다 — 삭제가 항상 배포에 쓴 것과 같은 계정을 지우도록. ECS 실행·인프라 역할 ARN도 같은 기준으로 고른다: 연결된 계정이면 `pipeline_get_role_arns` → `services_aws_account_role_arns`가 그 계정의 역할(CFN 템플릿이 만든 것)을 주고, 없으면 `.env`의 `ECS_*_ROLE_ARN`.

## 운영 감시와 자동 복구 (D1)

`main.py`의 `lifespan()`이 서버를 켤 때 `ensure_columns` -> `pipeline_recover` -> `Recovery_Service.services_recovery_resume`(끊긴 인시던트 정리) 순으로 한 번씩 await 하고, 그 뒤에 폴링 루프와 헬스 감시 루프를 띄운다. 끌 때는 두 루프를 cancel 한 다음 인시던트 태스크와 알림 태스크를 cancel 한다.

```
헬스 감시 루프 (60초) ─ 점검 ─ health_checks 저장 ─ 훅 ─▶ 인시던트 열기 (연속 실패 3번, DB 만 쓰고 바로 돌아옴)
                                                          │ 백그라운드 태스크 (INCIDENT_TASKS, 자기 세션)
                                                          ▼
                              원인 수집(describe + 최근 점검) → 규칙 표 설명 → incident_opened 알림
                                                          │
                          auto_recover 꺼짐 ─▶ needs_action + 알림     켜짐 ─▶ Recovery_Service (같은 태스크 안)
                                                                              재시작 → (안 되면) 되돌리기 → 검증
                                                                              resolved + incident_recovered / needs_action + 알림
```

- **감시 루프**: `Health_Service.services_health_monitor_loop`가 `HEALTH_INTERVAL_SECONDS`(60초)마다 `running`이면서 주소가 있는 배포를 점검한다. 동시 점검 수 제한, 점검마다 제한 시간, 한 배포의 오류가 다른 배포나 루프를 멈추지 않는다. 점검하는 사이 멈추거나 지워진 배포는 기록하지 않는다. 가끔 `HEALTH_RETENTION_DAYS`(7일)보다 오래된 기록을 지운다. 점검 대상 주소는 배포 자신의 `endpoint + health_check_path`뿐이다. `HEALTH_MONITOR_ENABLED=false`면 루프를 띄우지 않는다 — 그러면 예정 사용 시간 초과 알림(아래 "비용 확인")도 같이 멈춘다. 정상이 처음 확인되면 현재 릴리스의 `healthy_since`를 채운다 (되돌리기 대상이 되려면 필요).
- **인시던트 처리 태스크**: 훅은 모니터의 세션 안이라 DB 만 쓰고 끝낸다. AWS 조회·설명·알림·복구는 `Incident_Service.services_incident_spawn`이 띄운 태스크가 자기 세션으로 한다. 참조를 `INCIDENT_TASKS`에 쥐고 있고 서버를 끌 때 cancel 한다. 상태 전환은 조건부 UPDATE 라 모니터의 해제와 태스크의 마무리가 서로 덮어쓰지 않는다. 배포마다 하나의 끝나지 않은 인시던트(`open` `recovering` `needs_action`)만 둔다.
- **복구 한도**(코드가 AWS 호출 직전마다 다시 확인): 인시던트당 2회(재시작 1 + 되돌리기 1), 배포당 24시간 6회, 배포별 잠금, 조치 뒤 120초 기다린 다음 300초 안에 3번 연속 정상이어야 성공. 자세한 순서와 규칙은 [`api-spec.md`](./api-spec.md) "자동 복구". 복구 중 사용자가 배포를 바꾸면 기록을 덮어쓰지 않고 `needs_action`.
- **루프 방지**: 되돌린 배포는 나쁜 커밋을 `deploys.bad_commit_sha`에 기억한다. 감시 폴링·웹훅이 같은 커밋을 보면 다시 배포하지 않고 표시만 한다.
- **알림**: `Notification_Service`가 앱 안 줄(항상) -> 메일 -> 푸시 순으로 보내고 채널마다 줄을 남긴다. 헬스 감시 경로의 복구 알림과 파이프라인·폴링·웹훅의 알림은 백그라운드 태스크(`NOTIFICATION_TASKS` 또는 `INCIDENT_TASKS`)로 띄워 느린 SMTP·Expo 가 흐름을 붙잡지 않게 한다. 인시던트 처리 태스크 안의 알림은 같은 태스크에서 보낸다 (제한 시간 있음). 채널 하나가 실패해도 다른 채널과 호출한 쪽은 멈추지 않는다.
- **서버 재시작**: `services_recovery_resume`이 `recovering` 인시던트는 `needs_action`(진행 중이던 조치는 `failed`)으로, 처리 중이던 `open`은 배포가 `running`이고 `auto_recover`가 켜져 있으면 처리를 다시 띄우고 아니면 `needs_action`으로 정리한다.
- **아직 없는 것**: 컨테이너 로그·ECS 이벤트 수집(AWS 호출 미검증), 운영 에이전트(`docs/app-web` D12, 읽기 도구 + 조치 도구 둘을 LLM이 고르는 루프), 로그인별 알림(`u_id`는 로그인이 생길 때까지 null). 지금 원인 설명은 규칙 표뿐이다.
- **미검증**: 같은 이미지로 서비스를 갱신하면 실제로 작업이 다시 시작되는지, 이미지 갱신으로 되돌리기가 실제로 되는지(`docs/aws-notes.md` "운영 복구"), 실제 SMTP 서버와 Expo 푸시 서버로의 발송. 시험은 전부 가짜(점검기·갱신기·잠자기·메일·푸시)로 돌렸다.

## 비용 확인 (`features/pricing`)

배포를 만들기 전에 "얼마가 드는가"를 보여 주고, 떠 있는 동안 예정한 시간을 넘기면 알린다. 화면은 웹 `ui/`에 있다 - `CostPanel`이 `/api/pricing/*`를 불러 그린다 (앱(Expo)에는 아직 없다). 계약은 [`api-spec.md`](./api-spec.md) "Pricing", 설계는 [`superpowers/specs/2026-11-16-cost-confirm-design.md`](./superpowers/specs/2026-11-16-cost-confirm-design.md).

```
AWS 공개 가격 파일 (AmazonECS, AWSELB; 인증 없음, 리전별 index.json)
        │  Pricing_Service.services_pricing_table  (httpx, 읽기 실패 시 낡은 캐시, 그것도 없으면 None)
        ▼
data/cache/pricing-<리전>.json   ← 단가 표 + 저장 시각, PRICING_CACHE_HOURS(24시간) 안이면 그대로 쓴다
        ※ 오프라인 보호: 갱신에 실패한 리전은 10분 동안 다시 가져오지 않고(낡은 캐시 또는 None), 같은 리전의 동시 호출은 잠금으로 한 번만 가져오며, 두 파일은 동시에 받는다 (연결 5초·읽기 10초·전체 20초, 파일당 5MB 상한). 캐시가 깨졌거나(NaN·음수·0·다른 리전) 정확히 24시간이 지났으면 없는 것으로 본다
        │
        ▼  services_pricing_estimate (순수 함수)
   Cost_Estimate ──▶ POST /api/pricing/estimate (표가 없으면 503)
        └──────────▶ advice 의 cost (분석 결과 캐시를 건드리지 않고 복사본에 매번 채운다, 표가 없으면 숫자 None)
        └──────────▶ MCP deploy 미리보기 (REST 로 부른다)
```

- **계산**: 시간당 = Fargate(vCPU 수 x vCPU 단가 + GB 수 x GB 단가) + ALB 고정 시간당. 기간별 금액은 1시간·1일(24)·1주(168)·한 달(730시간). 사양은 프리셋 4개(256/512, 512/1024, 1024/2048, 2048/4096)만 받는다. 사양을 안 정하면 서비스 생성이 실제로 보낼 사양으로 계산한다 — `.env`의 `ECS_CPU`/`ECS_MEMORY`가 둘 다 있고 프리셋 쌍이면 그 값(가정에 `.env` 설정이라고 적는다), 아니면 기본 사양 256/512 ("실제 배포에서 아직 확인하지 않은 값"이라고 밝힌다). 같은 판단을 두 곳이 따로 하지 않도록 `shared/specs.py`가 쌍 목록과 `.env` 검사를 맡는다. 증설을 고르지 않으면 작업 1개 기준이며, AWS 기본 오토스케일이 작업 수를 늘릴 수 있다는 사실(최대 수는 확인 전)을 가정에 적는다. 가정은 "서비스마다 ALB 가 하나씩 생긴다"(공유 여부 미확인이라 가장 비싼 경우).
- **들어 있지 않은 것**: ALB 사용량(LCU) 요금, 데이터 전송, CloudWatch Logs, ECR 저장. 응답의 `not_included`에 그대로 적는다. 금액은 온디맨드 USD 추정치이고 실제 청구서가 아니다.
- **ARM64**: 시간당 금액과 절감률을 비교용으로만 보여 준다. 이 마법사는 항상 `linux/amd64`로 빌드하므로(하드 규칙 9) ARM64 로 배포하지 않는다.
- **자동 증설 = 사용자가 고른 AWS 설정**: 만들 때 `min_tasks`·`max_tasks`·`scale_metric`·`scale_target`을 모두 정하면 Express 서비스를 **처음 만들 때만** `scalingTarget`으로 보낸다 (`cpu`·`memory`도 마찬가지, 이미 있는 서비스의 재배포·복구는 보내지 않는다). 늘고 주는 것은 AWS 가 하며 우리 시스템이 자동으로 조치하는 것이 아니다 (하드 규칙 3 의 자동 조치에 해당하지 않음). 최대 작업 수 상한 `MAX_TASKS_CAP`(기본 4)은 **사용자가 고른 증설 설정에만** 적용된다. 증설을 고르지 않으면 `scalingTarget`을 보내지 않아 AWS 기본 오토스케일이 동작하며, 그 기본 최대 작업 수는 미확인이라 이 상한이 막아 주지 못한다 (소유자 결정: 기본 `scalingTarget`을 대신 보내지 않는다).
- **예정 사용 시간 알림 (알림만)**: `deploys.running_since`가 `running`이 될 때 비어 있으면 채워지고(재배포는 이어서 센다), 멈춤·삭제·서비스 없는 실패에서 비워진다. 헬스 감시 루프(60초)가 점검 뒤 `Health_Service.services_health_plan_notify`를 불러, `planned_hours`가 있고 `running_since`로부터 그 시간이 지났고 `plan_notified_at`이 비어 있는 `running` 배포에 `plan_exceeded` 알림을 한 번 보내고 `plan_notified_at`을 채운다. **멈추거나 지우지는 않는다.** 예정 시간을 PATCH 로 바꾸면 알림이 다시 켜진다. 헬스 점검 쪽 실패와 서로 막지 않도록 따로 감싼다. 옛 설정 보정: `notification_settings.kinds_version`(NULL = 옛 설정)을 둔다. 처음 읽을 때 `kinds_version`이 비어 있으면, 저장된 목록이 예전 기본값(`plan_exceeded`만 빠진 여섯 가지)과 같을 때만 `plan_exceeded`를 더하고, 일부를 일부러 꺼 둔 목록은 그대로 둔 채 `kinds_version=2`로 올린다 (한 번만, 다시 건드리지 않는다). `kinds`를 PATCH 하면 `kinds_version=2`가 같이 저장되어, 이후 여섯 가지만 보내 `plan_exceeded`를 끈 선택은 다시 켜지지 않는다. 새 줄은 일곱 가지와 `kinds_version=2`로 시작한다. 열이 생기기 전부터 떠 있던 배포는 `running_since`가 비어 있어 알림 대상이 아니다.
- **미검증**: 프리셋 4개를 Express 가 모두 받는지, 사양을 안 정했을 때의 실제 기본 크기, `scalingTarget` 허용 범위, 기본 오토스케일의 최대 작업 수, ALB 가 서비스마다 하나인지 (`docs/aws-notes.md`). 시험은 전부 가짜 가격 파일·가짜 Express 로 돌렸다.
- **설계만 있고 만들지 않은 것**: 시간대 스케줄 자동 절전, 유휴 휴면, Kubernetes (스펙 7절).

## 웹 운영 화면 (계획 E)

인시던트·알림·배포 설정 화면은 서버를 바꾸지 않고 기존 API(`docs/api-spec.md`)만 부른다. 화면 모양은 [`ui-spec.md`](./ui-spec.md) "4. 운영 화면". 여기서는 코드가 어디에 놓이는지만 적는다.

```
features/incidents/ui/       api.js(getOne 만) · constants.js · health.js · timeline.js
                             IncidentDetailPage · IncidentCard · IncidentBadge · IncidentExplain · IncidentTimeline · HealthBar · ProblemBanner
features/notifications/ui/   api.js · constants.js · logic.js · useUnreadCount.js
                             NotificationsPage · NotificationSettingsPage · NotificationItem · BellLink
features/deploys/ui/         (기존) + DeploySettingsPage · HealthDot · StopDialog, api.js 에 patchSettings · getHealthHistory
shared/ui/                   time.js · polling.js · usePolling.js · SettingSwitch.jsx (api.js 의 request 가 error.status 를 단다)
tests/web/                   node:test 로직 테스트 (npm run test:web)
```

- **기능 사이**: `deploys/ui` 와 `incidents/ui` 는 서로의 컴포넌트를 가져다 쓴다(`DeployDetailPage` → `IncidentCard`, `IncidentDetailPage` → `StopDialog`·`deployApi`). 모듈 순환은 없고, 앞서 `ExplainCard`·`EnvVarsCard` 를 `DeployDetailPage` 가 가져다 쓴 것과 같은 방식이다. 읽지 않은 수(`useUnreadCount`)는 `usePolling` 위에서 30초 기준으로 돌고, 실패가 이어지면 5분 상한까지 늘린다(`backoffDelay(30000, n, 300000)`). 주소의 id 검사는 `shared/ui/isValidId.js`, 없는 항목 안내는 `shared/ui/NotFoundNotice.jsx` 가 맡는다.
- **한 기능 안의 방향**: 화면(`*Page.jsx`) → 컴포넌트(`*.jsx`) → 순수 로직·상수(`constants.js` `health.js` `timeline.js` `logic.js`) → `api.js` → `shared/ui/api.js`의 `request`. 순수 로직은 React·`fetch`를 가져오지 않아 Node 에서 그대로 시험된다. 상태·종류 글자는 기능마다 `constants.js` 한 곳에만 둔다.
- **기능 사이의 UI 가져오기** (`ui/ → 다른 기능의 ui`, 위 의존 방향에서 허용): 인시던트 상세(`features/incidents/ui`)는 `features/deploys/ui`의 `StopDialog`와 `deployApi`(다시 배포·멈춤·헬스 이력)를 쓰고, 목록·상세의 배너·카드·점은 반대로 `incidents/ui`의 `ProblemBanner`·`IncidentCard`를 가져온다. 서버 쪽 `services` 규칙과 달리 화면은 컴포넌트와 `api.js`를 직접 가져온다. 인시던트 화면이 쓰는 `incidentApi`에는 `getOne`뿐이다 (인시던트는 서버가 만들고 닫는다).
- **폴링**: 인시던트 상세(5초, 끝나면 멈춤)와 상단 바 읽지 않은 수(30초)는 `usePolling`, 간격 계산은 `polling.js`의 `backoffDelay`. `usePolling`의 규칙: 번호(`seq`)로 늦게 온 응답을 버리고 `clearTimeout`으로 정리, 숨겨진 탭에서는 멈춤, 실패하면 간격을 두 배씩 늘려 최대 30초, 인시던트 상세는 404 를 다시 부르지 않는다. 배포 목록·상세는 기존 `setTimeout` 루프라서 이 규칙이 적용되지 않는다: `alive` 표시와 `clearTimeout`만 쓰고 간격은 고정이다(목록 3초/15초, 읽기 실패 뒤 10초. 상세 진행 중 1.5초, `running` 15초이고 실패해도 `running`이면 15초 뒤 재시도, 읽기가 404 면 멈추고 없는 배포 안내). 숨겨진 탭 멈춤도 없다. 알림·설정 화면은 폴링하지 않는다.
- **자동 조치 없음**: 웹은 서버가 한 재시작·되돌리기를 읽기 전용 기록으로 보여 줄 뿐이고, 모든 변경은 사용자가 누른 버튼(멈춤은 확인 대화상자 뒤)이다 (규칙 3).
- **시험**: `tests/web/*.test.js`를 `npm run test:web`(`node --test "tests/web/*.test.js"`, Node 22)으로 돌린다. 시간·헬스 칸·타임라인·알림 로직·`backoffDelay`·`api.js`(가짜 `fetch`)가 대상이다. 화면 파일은 Vite 별칭(`@shared` `@features`)을 쓰므로 별칭을 쓰는 모듈을 가져오는 테스트는 먼저 `tests/web/useAlias.mjs`를 불러 `aliasHooks.mjs` 별칭 훅을 등록한다 (순수 로직 파일은 상대 경로라서 필요 없다). 화면 컴포넌트와 브라우저 동작은 자동 테스트가 없다.

## 자동화 원칙 (기획서 03장)

자동으로 하는 것은 **되돌리기**(재배포 실패)와 **운영 복구**(2026-11-09 사용자 결정: 실행 중인 서비스의 재시작, 이전 정상 버전으로 되돌리기) 두 가지뿐. 만들고, 사양을 바꾸고, 키우고, 지우는 것은 전부 사용자에게 묻는다. 운영 복구는 배포별 `auto_recover`가 켜져 있을 때만 하고, 모든 시도를 기록하며 원인과 고칠 곳을 알린다. 설계: [`app-web/`](./app-web/README.md).

| 상황 | 자동으로 | 사용자에게 |
|------|----------|-----------|
| 실행 중 서비스 이상 (연속 헬스 실패) | 재시작 → 안 되면 이전 정상 버전으로 되돌리기 (`auto_recover` 켜진 배포만, 백엔드 구현 완료 - 실제 AWS 미검증) | 원인·고칠 곳 알림(메일·푸시). 못 고치면 [다시 배포] [멈춤] [그대로 두기] |
| 빌드 실패 | Dockerfile 자가수정 (우리가 만든 파일만) | — |
| 배포 실패 | 멈춘다 | 해설 + [다시 배포] [리소스 정리] [그대로 두기] |
| 재배포 실패 | Express Mode의 카나리·알람 롤백에 맡긴다 *(M1에서 동작 확인 필요)* | 해설 |
| 예정 사용 시간 초과 | 알림만 (멈추거나 지우지 않는다) | 멈추거나 삭제하세요 / 예정 시간 늘리기 |
| 리소스 삭제 | 하지 않는다 | 확인 대화상자 |

## 데이터베이스

기본은 SQLite 파일(`data/wizard.db`). 1인 도구라 서버 DB가 필요 없고, 어디서 멈춰도 돌아가는 상태를 유지하기 쉽다. `DB_URL`만 바꾸면 MySQL로 옮길 수 있다.

- `deploys` — 배포 하나. 레포·브랜치·커밋, 판별 결과, 상태, Dockerfile, AWS 리소스 식별자, 주소, 에러와 해설, (M6) 연결된 `aws_account_id`/`github_installation_id`, `auto_redeploy`, `watch_*`
- `deploy_logs` — 배포 로그 한 줄 (`d_id` FK, `ondelete=CASCADE`)
- `deploy_issues` — 실패 이력 한 건 (`d_id` FK, `ondelete=CASCADE`) - 다시 배포해도 지워지지 않는다
- `deploy_env_vars` — 배포별 환경변수 한 건 (`d_e_id` PK, `d_id` FK `ondelete=CASCADE`, `(d_id, name)` 유일). 이름·종류·필수 여부·찾은 위치·상태(`detected` `set` `skipped`)를 두고, 값은 일반 설정(`config`)만 `plain_value`에 둔다. 시크릿 종류 값은 저장하지 않는다 (`secret_ref` 열은 보안 저장소 검증 전까지 비어 있다). API는 값을 돌려주지 않는다 (`has_value`만)
- `aws_accounts` (M6) — 연결된 AWS 계정. `role_arn`, 암호화된 `external_id_encrypted`, 검증 상태
- `github_installations` (M6) — 연결된 GitHub App 설치. 토큰은 저장하지 않는다 (매번 새로 발급)
- (D1) `deploys`에 열 넷이 더해졌다: `auto_recover`(기본 켜짐), `health_state`, `last_health_at`, `bad_commit_sha`
- (비용 확인) `deploys`에 열 아홉이 더해졌다 (모두 nullable): `cpu`, `memory`, `min_tasks`, `max_tasks`, `scale_metric`, `scale_target`, `planned_hours`, `running_since`, `plan_notified_at`
- (D1) `health_checks` — 점검 한 건 (`h_c_id`, `d_id` FK CASCADE). 7일 지나면 지운다
- (D1) `incidents` — 인시던트 (`i_id`, `d_id`). `kind`·`status`·`summary`·`explain`(JSON)·`evidence`
- (D1) `recovery_actions` — 자동 조치 한 건 (`r_a_id`, `i_id` FK, `action` `restart|rollback`, `result` `running|ok|failed`)
- (D1) `deploy_releases` — running 에 닿을 때마다 한 줄 (`d_r_id`, `d_id`, `commit_sha`, `image_uri`, `state` `current|previous|old|failed`, `healthy_since`)
- (D1) `notifications`(`n_id`) · `push_devices`(`p_d_id`) · `notification_settings` — 알림 줄, 푸시 기기, 한 줄짜리 설정. `u_id`는 로그인이 생길 때까지 null

테이블은 시작할 때 `create_all`로 만든다 — SQLite `create_all`은 없는 테이블만 만들고, 있는 테이블에 컬럼을 추가하지 않는다. (D1) 그래서 `lifespan()`이 `create_all` 뒤에 `shared/database.py`의 `ensure_columns`를 부른다: `ENSURE_COLUMNS`에 적힌 열(지금은 `deploys`의 D1 네 열과 비용 확인 아홉 열)이 실제 표에 없으면 `ALTER TABLE ... ADD COLUMN`으로 더한다 (여러 번 불러도 안전, NOT NULL 열은 기본값이 있어야 한다). 새 열을 늘릴 때는 모델과 `ENSURE_COLUMNS`를 같이 고친다. 열을 지우거나 바꾸는 일은 여전히 못 한다 — 그런 일이 잦아지면 alembic을 붙인다. 시험에서는 옛 모양의 표로 보정이 되는 것을 확인했지만, 실제 `data/wizard.db`에서의 첫 실행은 아직 해 보지 않았다.

### 키와 백업 (로그인 계획 Task 8)

- 키는 `.env`에 따로 둔다: `SECRET_KEY`(Fernet, 암호화 열·`external_id_encrypted`) + `SECRET_KEYS_OLD`(회전 중 옛 키, 쉼표), `BLIND_INDEX_KEY`(HMAC 블라인드 인덱스 - `email_bidx`·`expo_token_bidx` 등), `AUTH_JWT_KEY`(액세스 JWT). 앞의 둘은 서버가 늘 요구한다. 잃으면 암호화된 값은 되살릴 수 없다 — `.env`는 DB 백업과 함께, 저장소 밖에 보관한다.
- 암호화 열은 `Encrypted_Text`(`shared/crypto_types.py`)로 저장 계층에서만 암호화·복호화한다. 평문이 남은 옛 DB 는 읽을 때 이전 안내 오류를 내고, `lifespan()`이 `bootstrap_schema` 바로 뒤에 `shared/migrate.py`의 `migrate_check_startup`으로 평문 수를 세어 하나라도 있으면 서버 시작을 멈춘다 (새 DB·빈 표는 통과).
- 옛 DB 이전은 `scripts/migrate_login.py`만 한다 (`shared/migrate.py`의 동기 함수 - raw SQL, 값 원문을 돌려주지 않고 개수만): `backup`(sqlite3 백업 API → `data/backups/wizard-YYYYmmdd-HHMMSS.db`, `integrity_check` 확인) → `status` → `encrypt --yes`(열·인덱스 보정, `push_devices.expo_token_bidx` 채우기와 같은 토큰 중복 정리 - 주인 있는 줄 → 최근 줄을 남기고 못 읽는 줄은 건드리지 않는다, 평문만 암호화, 끝나면 `secure_delete`+`VACUUM`으로 옛 원문이 파일에 남지 않게) → 로그인 → `assign-owner --email --yes`(`u_id IS NULL`인 행만, `notification_settings`처럼 `u_id`가 유일한 표는 한 줄만; 연결 블록과 계정·설치의 주인이 다르면 보고만). 쓰는 명령은 모두 기본이 보기만이고 `--yes`일 때 검사한 백업을 먼저 만든다. `rotate-keys`는 되돌리는 명령이 없다(`restore --from`). `restore`·`encrypt --yes`·`rotate-keys --yes`는 `:8081`에 서버가 떠 있으면 거절한다.
- `session_end.py`·`cleanup.py`는 이전 전 DB 에서 연결 계정을 읽지 못하면 죽지 않고 개발 계정 몫은 처리한 뒤, 끝에 이전 안내를 내고 2 로 끝난다.

## 보안 메모

- 레포 주소는 `https://github.com/소유자/레포`만 받고, git 인자는 리스트 + `--`로 넘긴다.
- **빌드는 남의 코드를 실행하는 일이다.** 지금은 내 컴퓨터의 Docker에서 돌린다. 남이 쓰게 하는 시점(M6)에는 격리된 빌더(CodeBuild 등)로 옮겨야 한다.
- 인증이 없다. 로컬 전용이다. 외부에 열지 않는다.
- AWS 키는 받지도 저장하지도 않는다. 프로파일 이름만 `.env`에 둔다. (M6) 연결된 계정도 마찬가지 — 장기 키 대신 `role_arn`+`external_id`로 그때그때 `sts:AssumeRole` 임시 자격증명을 받는다.
- (M6) `external_id`처럼 연결별로 다른 비밀값은 `shared/secrets.py`(Fernet, `SECRET_KEY`)로 암호화해 저장한다. GitHub App 개인키·웹훅 시크릿처럼 앱 전체에 하나뿐인 값은 `.env`에 그대로 둔다(`ANTHROPIC_API_KEY`와 같은 성격). GitHub 설치 액세스 토큰은 아예 저장하지 않는다 — 클론할 때마다 새로 발급.
- (M6, CloudFormation 템플릿) `features/accounts/cloudformation/deploy_wizard_role.yaml`은 **미검증**이다 — 실제 두 번째 AWS 계정으로 테스트하기 전까지 신뢰하지 않는다 (`docs/aws-notes.md`).
- (M6) 웹훅은 `X-Hub-Signature-256`(HMAC-SHA256) 검증이 필수다 — `GITHUB_WEBHOOK_SECRET`이 없거나 서명이 안 맞으면 무조건 401. 검증 없이 열면 누구나 가짜 푸시로 배포를 일으킬 수 있다.
