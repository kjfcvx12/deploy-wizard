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
│   ├── accounts/               ← scheme.py  crud.py  services.py  router.py  cloudformation/  ui/  (M6, 진행 중)
│   └── watches/                ← services.py 만 (DB 없음, 상태는 Deploy에)  (M6, 진행 중 - 폴링만 완료)
│
├── shared/                     ← 모든 기능이 쓰는 것
│   ├── settings.py             ← 환경변수 (pydantic-settings)
│   ├── database.py             ← async 엔진, 세션, Base
│   ├── aws_session.py          ← 세션 주입 (내 계정 / AssumeRole)
│   ├── llm.py                  ← 구조화 출력 전용 LLM 클라이언트
│   ├── masking.py              ← 토큰 마스킹
│   ├── proc.py                 ← git·docker 실행
│   └── ui/                     ← main.jsx, App.jsx, api.js, styles.css
│
├── scripts/                    ← setup_roles, m1_deploy, deploy_cli, cleanup
└── tests/
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

기능 조립은 `features/deploys/pipeline.py` 한 곳에서만 한다. `repos`·`dockerfiles`·`builds`·`express`·`explains`는 서로를 모른다 (예외: `dockerfiles`는 레포 요약을 위해 `repos`의 services 를 쓴다). `accounts`·`watches`는 예외 — `deploys`가 배포에 쓸 AWS/GitHub 세션을 얻으려고 `accounts`의 services 를 부르고(M6, `pipeline.py`·`services_deploy_delete`·`services_deploy_get_remote`에 배선됨), `accounts`도 계정 삭제 시 연결을 끊으려고 `deploys`의 services 를 부른다(순환 임포트라 `accounts/services.py`에서는 함수 안에서 지연 임포트한다). `watches`는 `deploys`(폴링 대상 조회, 재배포 트리거)와 `accounts`(GitHub 토큰)의 services 만 부르고, 아무도 `watches`를 부르지 않는다 — `main.py`가 백그라운드 태스크로 직접 돌린다.

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
| 2 | `analyzing` | 매니페스트로 언어 판별(규칙), 인코딩 정리 | `repos` |
| 3 | `generating` | 정식: 템플릿+LLM 빈칸 / 실험: LLM 순수 생성 / 레포에 Dockerfile 있으면 그대로 | `dockerfiles` |
| 4 | `building` | `docker build --platform linux/amd64`. 실패 시 Dockerfile 자가수정 (정식 2회·실험 1회) | `builds` + `dockerfiles` |
| 5 | `pushing` | ECR 리포지토리 생성, 로그인(매번 새 토큰), 푸시 | `builds` |
| 6 | `deploying` | Express Mode 서비스 생성(또는 갱신) → 배포 완료까지 폴링 | `express` |
| 7 | `running` | 주소 저장 | |
| ✗ | `failed` | 멈춘다. 에러 해설(규칙 → LLM)을 저장한다. **리소스는 지우지 않는다** | `explains` |

- 블로킹 작업(git·docker·boto3)은 `asyncio.to_thread`로 돌린다.
- 로그는 작업 스레드에서 `Deploy_Log_Buffer`에 쌓이고 1초마다 DB에 쓴다. 화면은 `GET /logs?after=`로 새 줄만 가져간다.
- 서비스 ARN은 **받자마자** 저장한다. 이후에 실패해도 정리할 수 있어야 한다.
- 서버가 재시작되면 진행 중이던 배포는 `failed`로 돌려놓는다 (`pipeline_recover`).
- (M6) 코드 변경 감지 폴링(`Watch_Service.services_watch_poll_loop`)은 `main.py`의 `lifespan()`에서 시작하는 별도 백그라운드 태스크다. `pipeline_recover`(한 번 await, 시작을 막음)와 다르게 서버가 떠 있는 동안 계속 돌고, 종료 시 `cancel()` + await로 정리한다.
- `[다시 배포]`는 처음부터 돌지 않는다. `error_step` 앞의 단계는 저장된 값(커밋, 판별 결과, Dockerfile, 이미지 주소)이 있으면 건너뛴다 (`pipeline_resume_from`). `pushing` 실패는 로컬 이미지가 남아 있을 때만 `building`도 건너뛴다 — `docker image inspect`로 확인한다.
- (M6) ECR 푸시·Express Mode 배포에 쓸 AWS 세션은 `Deploy_Pipeline.pipeline_get_aws_session(deploy.aws_account_id)` → `Aws_Account_Service.services_aws_account_build_session`이 만든다. `aws_account_id`가 없으면 지금까지처럼 개발 세션(M1~M5 그대로), 있으면 그 계정으로 `sts:AssumeRole`. `services_deploy_delete`도 같은 함수로 세션을 만든다 — 삭제가 항상 배포에 쓴 것과 같은 계정을 지우도록. ECS 실행·인프라 역할 ARN도 같은 기준으로 고른다: 연결된 계정이면 `pipeline_get_role_arns` → `services_aws_account_role_arns`가 그 계정의 역할(CFN 템플릿이 만든 것)을 주고, 없으면 `.env`의 `ECS_*_ROLE_ARN`.

## 자동화 원칙 (기획서 03장)

자동으로 하는 것은 **되돌리기 하나**. 만들고 바꾸고 지우는 것은 전부 사용자에게 묻는다.

| 상황 | 자동으로 | 사용자에게 |
|------|----------|-----------|
| 빌드 실패 | Dockerfile 자가수정 (우리가 만든 파일만) | — |
| 배포 실패 | 멈춘다 | 해설 + [다시 배포] [리소스 정리] [그대로 두기] |
| 재배포 실패 | Express Mode의 카나리·알람 롤백에 맡긴다 *(M1에서 동작 확인 필요)* | 해설 |
| 리소스 삭제 | 하지 않는다 | 확인 대화상자 |

## 데이터베이스

기본은 SQLite 파일(`data/wizard.db`). 1인 도구라 서버 DB가 필요 없고, 어디서 멈춰도 돌아가는 상태를 유지하기 쉽다. `DB_URL`만 바꾸면 MySQL로 옮길 수 있다.

- `deploys` — 배포 하나. 레포·브랜치·커밋, 판별 결과, 상태, Dockerfile, AWS 리소스 식별자, 주소, 에러와 해설, (M6) 연결된 `aws_account_id`/`github_installation_id`, `auto_redeploy`, `watch_*`
- `deploy_logs` — 배포 로그 한 줄 (`d_id` FK, `ondelete=CASCADE`)
- `deploy_issues` — 실패 이력 한 건 (`d_id` FK, `ondelete=CASCADE`) - 다시 배포해도 지워지지 않는다
- `aws_accounts` (M6) — 연결된 AWS 계정. `role_arn`, 암호화된 `external_id_encrypted`, 검증 상태
- `github_installations` (M6) — 연결된 GitHub App 설치. 토큰은 저장하지 않는다 (매번 새로 발급)

테이블은 시작할 때 `create_all`로 만든다 — **기존 테이블의 컬럼은 바꾸지 않는다** (SQLite `create_all`은 없는 테이블만 만들고, 있는 테이블에 컬럼을 추가하지 않는다). 로컬 개발 중 컬럼을 늘렸으면 `data/wizard.db`를 지우고 새로 만든다. 컬럼을 바꿀 일이 잦아지면 alembic을 붙인다.

## 보안 메모

- 레포 주소는 `https://github.com/소유자/레포`만 받고, git 인자는 리스트 + `--`로 넘긴다.
- **빌드는 남의 코드를 실행하는 일이다.** 지금은 내 컴퓨터의 Docker에서 돌린다. 남이 쓰게 하는 시점(M6)에는 격리된 빌더(CodeBuild 등)로 옮겨야 한다.
- 인증이 없다. 로컬 전용이다. 외부에 열지 않는다.
- AWS 키는 받지도 저장하지도 않는다. 프로파일 이름만 `.env`에 둔다. (M6) 연결된 계정도 마찬가지 — 장기 키 대신 `role_arn`+`external_id`로 그때그때 `sts:AssumeRole` 임시 자격증명을 받는다.
- (M6) `external_id`처럼 연결별로 다른 비밀값은 `shared/secrets.py`(Fernet, `SECRET_KEY`)로 암호화해 저장한다. GitHub App 개인키·웹훅 시크릿처럼 앱 전체에 하나뿐인 값은 `.env`에 그대로 둔다(`ANTHROPIC_API_KEY`와 같은 성격). GitHub 설치 액세스 토큰은 아예 저장하지 않는다 — 클론할 때마다 새로 발급.
- (M6, CloudFormation 템플릿) `features/accounts/cloudformation/deploy_wizard_role.yaml`은 **미검증**이다 — 실제 두 번째 AWS 계정으로 테스트하기 전까지 신뢰하지 않는다 (`docs/aws-notes.md`).
- (M6) 웹훅은 `X-Hub-Signature-256`(HMAC-SHA256) 검증이 필수다 — `GITHUB_WEBHOOK_SECRET`이 없거나 서명이 안 맞으면 무조건 401. 검증 없이 열면 누구나 가짜 푸시로 배포를 일으킬 수 있다.
