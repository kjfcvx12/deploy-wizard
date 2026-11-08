# API 스펙

Base URL: `http://localhost:8081` · 전부 JSON · 인증 없음(로컬 전용) · 대화형 문서 `/docs`

에러는 FastAPI 기본 형태다. `detail`은 한국어이며 화면에 그대로 보여 준다.

```json
{ "detail": "해당 id의 배포가 없습니다" }
```

## Deploy

| Method | Endpoint | 설명 | 성공 |
|--------|----------|------|------|
| GET | `/api/deploys` | 전 배포 조회 (삭제된 것 제외, 최신순) | 200 `Deploy_Read[]` |
| GET | `/api/deploys/remote?repo_url=&github_installation_id=` | 레포의 브랜치 목록과 기본 브랜치 (`git ls-remote`). `github_installation_id`(M6, 선택) 주면 그 설치 토큰으로 private 레포도 조회 | 200 `Repo_Remote` |
| POST | `/api/deploys` | 배포 생성 → 파이프라인 시작 | 201 `Deploy_Read` |
| GET | `/api/deploys/{d_id}` | 특정 배포 조회 | 200 `Deploy_Read` |
| GET | `/api/deploys/{d_id}/logs?after=` | `d_l_id > after`인 로그 (최대 500줄) | 200 `Deploy_Log_Read[]` |
| GET | `/api/deploys/{d_id}/issues` | 문제 이력 - 다시 배포해도 지워지지 않는 지난 실패들 (최신순) | 200 `Deploy_Issue_Read[]` |
| GET | `/api/deploys/{d_id}/health` | 공개 주소에 GET을 보내 본다 (AWS 권한 불필요) | 200 `Deploy_Health` |
| POST | `/api/deploys/{d_id}/redeploy` | 다시 배포. 서비스가 있으면 새 이미지로 갱신 | 200 `Deploy_Read` |
| POST | `/api/deploys/{d_id}/env/continue` | 이어서 배포 - 환경변수 입력을 마친 `needs_input` 배포를 `deploying` 단계부터 다시 돌린다 (아래 "Env"). `needs_input`이 아니면 409 → `queued` | 200 `Deploy_Read` |
| POST | `/api/deploys/advice` | 배포 전 분석 - 레포를 읽기만 하고 사양 수준·필요한 것·확신도를 돌려준다. 배포 기록·AWS 호출 없음 (아래 "Advice") | 200 `Deploy_Advice` |
| POST | `/api/deploys/{d_id}/stop` | 멈춤 - ECS 서비스만 삭제(요금 중단), 이미지·기록 유지. `running`만 가능(아니면 409) → `stopped` | 200 `Deploy_Read` |
| POST | `/api/deploys/{d_id}/start` | 다시 켜기 - 남겨 둔 이미지로 배포 단계만 다시. `stopped`만 가능(아니면 409) → `queued` | 200 `Deploy_Read` |
| DELETE | `/api/deploys/{d_id}` | ECS 서비스·ECR 리포지토리 삭제 후 기록을 `deleted`로 (`stopped`에서도 가능) | 200 `{message, deleted[]}` |

| 상태 코드 | 언제 |
|-----------|------|
| 400 | 레포 주소·브랜치 형식이 틀림, 레포 조회 실패 |
| 404 | 없는 `d_id`, 이미 삭제된 배포 |
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
  "created_at": "2026-09-21T06:10:00",
  "updated_at": "2026-09-21T06:11:02"
}
```

`env_pending`: 값이 비어 있는 필수 환경변수 수 (`required`이고 `status`가 `detected`인 것). DB 열이 아니라 조회할 때마다 센다. 환경변수가 없으면 0. `needs_input` 배포를 화면에 알리는 용도다.

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

본문은 `POST /api/deploys`와 같다 (`repo_url` 필수, `branch`·`aws_account_id`·`github_installation_id` 선택). `github_installation_id`를 주면 그 설치의 토큰으로 private 레포도 읽는다. `aws_account_id`는 받기만 하고 쓰지 않는다 (AWS 호출이 없다).

### `Deploy_Advice`

```json
{
  "tier": "medium",
  "confidence": "medium",
  "cpu": null,
  "memory": null,
  "cost": { "monthly_min": null, "monthly_max": null, "currency": "USD", "basis_date": null, "note": "트래픽에 따라 늘어납니다" },
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
| `cost` | 숫자(`monthly_min` `monthly_max` `basis_date`)는 **항상 `null`**. 요금 구성을 검증하기 전에는 비운다. `note`만 채운다 |

### 상태 코드와 `detail`

| 코드 | 언제 | `detail` |
|------|------|----------|
| 400 | 주소 형식이 틀림 | `https://github.com/소유자/레포 형식의 주소만 받습니다.` |
| 400 | 브랜치 형식이 틀림 | `브랜치 이름이 올바르지 않습니다.` |
| 400 | 커밋 조회 실패 | `레포를 조회할 수 없습니다 :<마스킹된 사유>` |
| 400 | 클론 실패 | `레포를 가져올 수 없습니다 :<마스킹된 사유>` |
| 400 | 지원하는 프로젝트가 아님 | `매니페스트 파일을 찾지 못했습니다. 지원하는 형식의 프로젝트가 아닙니다.` |
| 500 | 그 밖의 분석 실패 | `분석 실패 :<마스킹된 사유>` |

`disk_write`는 소스에서 파일을 쓰는 코드 흔적(`open(..., "w")`, `write_text`, `fs.writeFile` 등)을 정규식·AST로 찾는 **추정**이다. 테스트 파일은 건너뛰며, 임시 파일·로그 쓰기를 잘못 잡을 수 있다.

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
| GET | `/api/accounts/github/install-url` | GitHub App 설치 화면 주소. `?c_id=`를 주면 주소에 `state=<c_id>`가 붙고, 콜백이 그 블록에 설치를 잇는다. 운영자가 앱을 등록하지 않았으면(`GITHUB_APP_SLUG` 없음) 503 | 200 `{"url": str}` |
| GET | `/api/accounts/github/callback` | GitHub 설치 콜백 (`installation_id` 쿼리) - 설치 정보 저장 후 리다이렉트 | 302 → `/accounts?connected=github` |
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

## 기타

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/health` | 서버 확인 `{ "message": "ok" }` |
| GET | `/*` | `dist/`가 있으면 빌드된 화면을 서빙 (SPA 대체 경로 포함) |
