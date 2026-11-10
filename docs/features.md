# 기능

기능 하나 = `features/` 아래 폴더 하나. 1인 프로젝트라 담당자 대신 **책임과 경계**를 적는다.

| 기능 | 책임 | 가진 것 | 마일스톤 |
|------|------|---------|----------|
| `deploys` | 배포 기록, 파이프라인 조립, 다시 배포·삭제, 헬스체크 | models · scheme · crud · services · router · pipeline · ui | M3 M4 M5 |
| `repos` | 주소 검증, 클론, `ls-remote`, 언어 판별(규칙), LLM에 보낼 요약, 제외 필터 | scheme · services | M3 |
| `dockerfiles` | 템플릿, LLM 빈칸 채우기, 규칙 대체, 실험 경로, 자가수정, 캐시 | scheme · services · templates | M3 M5 |
| `builds` | `docker build`, ECR 리포지토리·로그인·푸시 | services | M2 |
| `express` | Express Mode 생성·갱신·조회·대기·삭제, 태그로 리소스 찾기 | scheme · services | M1 |
| `explains` | 한국어 에러 해설 (규칙 → LLM) | scheme · services · ui | M5 |
| `envvars` | 소스에서 환경변수 이름 찾기(스캐너), 종류 분류(규칙 → AI 선택), 값 입력·건너뛰기, 컨테이너에 넣을 값, 실행 중 에러에서 이름 찾기 | models · scheme · crud · scan · services · router · ui | 백엔드 + 화면 (실제 AWS 검증 전) |
| `advice` | 배포 전 분석 - 사양 수준·필요한 것·확신도 (읽기 전용, 숫자는 검증 전이라 비움) | scheme · services · router · ui | 백엔드 + 화면 (실제 AWS 검증 전) |
| `accounts` | 사용자 AWS 계정 연결(CloudFormation+AssumeRole) · GitHub App 연결 - 연결·파이프라인 배선(private 클론 포함) 완료 | models · scheme · crud · services · router · cloudformation/ · ui | M6 (진행 중) |
| `watches` | 코드 변경 감지 - 폴링(백그라운드) + 웹훅(서명 검증 + 디바운스) 둘 다 코드 완료 | services | M6 (코드 완료, 실제 검증 남음) |
| `health` | 떠 있는 배포를 1분마다 점검해 이력을 남기는 감시 루프, 이력 정리(7일) | models · scheme · crud · services | D1 (코드 완료, 실제 AWS 미검증) |
| `incidents` | 연속 실패로 인시던트 열고 닫기, 규칙 표 원인 설명, 자동 복구(재시작·이전 정상 이미지로 되돌리기), 한도, 서버 재시작 때 정리, 조회 API | models · scheme · crud · services · recovery · router | D1 (코드 완료, 실제 AWS 미검증) |
| `notifications` | 앱 안·메일·Expo 푸시 알림, 기기 등록, 알림 설정, 알림 조회 API | models · scheme · crud · services · compose · dispatch · inbox · router | D1 (코드 완료, 실제 SMTP·Expo 미검증) |

## 기능 사이의 흐름

```
[deploys/router] → [deploys/services] → [deploys/pipeline]
                                              │
        ┌──────────────┬──────────────┬───────┴──────┬──────────────┐
     [repos]     [dockerfiles]     [builds]      [express]      [explains]
   클론·판별      생성·자가수정    빌드·푸시     배포·대기       실패 해설
                      │
                   [repos]  (레포 요약을 받는다)
```

`pipeline.py`만 다른 기능을 안다. 나머지 기능은 서로를 모르므로, 하나를 갈아끼워도(예: 빌드를 CodeBuild로) 나머지는 그대로다.

운영 쪽(D1)은 파이프라인 밖에서 따로 흐른다 (서버 안 백그라운드 태스크):

```
[health 감시 루프] → [incidents 훅] → (태스크) 원인 수집·설명 → [notifications] → [incidents/recovery] → [express 갱신]
                                                                        ▲                   │
                          [deploys.pipeline / watches] ── 배포 완료·실패·새 커밋 알림 ─────┘ (자동 조치 결과도 알림)
```

새 코드를 둘 곳: 점검 방식·주기·이력 → `health`, 인시던트 열기·닫기·원인 규칙 → `incidents/services.py`, 자동 조치와 한도 → `incidents/recovery.py`, 알림 글·발송 채널·설정 → `notifications`(`compose` 글, `dispatch` SMTP·Expo, `inbox` 조회용). 자동 조치를 늘리려면 CLAUDE.md Hard rule 3 을 먼저 고쳐야 한다 (지금은 재시작과 되돌리기 둘뿐).

## 기능별 메모

### repos
- 판별은 규칙만 쓴다 — 결정적이고 빠르고 공짜. 루트부터 2단계 아래까지 매니페스트를 찾는다.
- 스크립트도 `main`도 없는 `package.json`은 앱으로 치지 않는다 (의존성 메모일 뿐).
- `backend/`·`server/`·`api/` 폴더의 앱을 우선한다. 함께 찾은 다른 앱은 `other_apps`에 담아 둔다 → M8 재료.
- UTF-16 `requirements.txt`(PowerShell `pip freeze >`)는 **클론한 사본에서만** UTF-8로 바꾼다.

### dockerfiles
- 정식(Node.js·Python): 템플릿 + `Dockerfile_Fill` 7개 빈칸. 값은 한 줄·허용 문자 검증 후에만 들어간다.
- LLM을 못 쓰면 규칙으로 채운다 (`template_rule`). 이 결과는 캐시하지 않는다 — LLM이 돌아오면 다시 묻도록.
- 실험(그 외 언어): LLM 순수 생성. 화면에 "실험 지원" 표시, 자가수정 1회, 빌드 타임아웃 넉넉히.
- 레포에 Dockerfile이 있으면 그대로 쓰고 **자가수정하지 않는다** (사용자 코드다).
- **승격 기준**: 같은 언어로 5개 레포 중 4개 이상 성공하면 템플릿을 만들어 정식으로 올린다.

### express
- 파라미터는 전부 검증된 것만 쓴다 → [`aws-notes.md`](./aws-notes.md).
- 완료 판정: 최신 서비스 배포가 `SUCCESSFUL`이고 공개 주소가 있을 때.

### explains
- 규칙 표(`EXPLAIN_RULES`)에 걸리면 LLM을 부르지 않는다. 새 에러를 만날 때마다 표에 추가한다.
- 규칙에도 없으면 에러 시그니처(`step` + 정규화한 `error_msg`)로 캐시를 본다. 캐시에 있으면 LLM을 다시 부르지 않는다 (`Explain_Result.cached`).
- LLM이 만든 해설만 캐시한다. LLM도 못 쓰면 기본 안내를 돌려주고, 캐시하지 않는다 — LLM이 돌아오면 다시 묻도록. 해설 실패가 배포 실패 처리를 막지 않는다.

### envvars (백엔드 + 화면 - 실제 AWS 배포로는 아직 검증 전)
- **이름만 찾는다.** 스캐너(`Env_Scan_Service`)가 `.py` `.js` `.jsx` `.mjs` `.cjs` `.ts` `.tsx`, `docker-compose`, `.env.example` 계열에서 이름과 `파일:줄` 위치만 모은다. 값은 읽어도 저장하지 않고 "기본값이 있는지"만 남긴다. `.env`·`.env.local`·키 파일은 열지 않는다 (`repos`의 제외 필터를 느슨하게 하지 않았다). 한도: 파일 500개, 파일당 200KB.
- **필수/기본값 판정.** 기본값이 없으면 필수. 예시 파일 값은 비어 있지 않고 `your`·`xxx`·`changeme`·`<`·`example`이 없을 때만 기본값으로 치되, 이름에 `KEY` `SECRET` `TOKEN` `PASSWORD` `PASSWD` `PWD` 낱말이 있으면(`SECRET_NAME_PARTS`) 예시 값이 있어도 기본값이 아니다 (예시에 진짜 키를 붙여 넣는 경우를 막는다). Vite 내장값(`import.meta.env.DEV` `MODE` `BASE_URL` `PROD` `SSR`)은 건너뛰고, pydantic `Field(alias=...)`는 대문자 이름처럼 생긴 별칭만 센다. pydantic-settings의 별칭 없는 필드명은 아직 못 찾는다.
- **종류 분류.** 규칙이 먼저(변수를 쓰는 줄·같은 파일에서 그 변수를 받은 지역 변수의 쓰임 → 이름 낱말), 그래도 `unknown`인 것만 AI가 `database` `cache` `external_api` `secret` `config` `unknown` 중 하나를 고른다 (`Env_Kind_Pick`, `LLM_Client.llm_parse`). 프롬프트에는 이름과 주변 코드 최대 7줄(줄당 200자, `mask_text`)만 싣는다 — 경로·값·레포 전체는 보내지 않는다. 한 번에 최대 20개, AI를 못 쓰면 `unknown`으로 두고 정식 언어는 그대로 끝까지 간다.
- **값 저장.** `config`만 `plain_value`에 저장하고 컨테이너 `environment`로 들어간다. 시크릿 종류는 값을 받지 않는다 (PUT 501, 결정 D8의 AWS 보안 저장소 검증 후). 응답에는 `has_value`만, 값은 쓰기 전용.
- **첫 배포만 멈춘다.** 값이 빈 필수 변수가 있으면 `needs_input`으로 `deploying` 직전에 멈춘다. 서비스가 이미 있는 재배포는 멈추지 않고 경고 로그만 남기고, 값이 있는 변수는 갱신 때도 다시 보낸다. `skipped`는 멈춤 조건에서 빠진다.
- **실행 중 에러에서 이름 찾기.** `pipeline_fail`이 에러 글(`KeyError: 'X'`, `Missing required environment variable X`, `X is not defined`)에서 대문자 이름만 최대 10개 뽑아 `source: runtime_error`, 필수로 올린다. 사용자가 이미 넣은 값·상태는 건드리지 않지만, 이미 있던 행의 `source`·`source_hint`는 덮어쓴다. 이 처리가 실패해도 배포 실패 기록은 막지 않는다. 해설 규칙 "필요한 환경변수가 설정되지 않았습니다."는 헬스체크 규칙보다 앞에 둔다 (변수가 없어 죽은 앱은 헬스체크 실패도 같이 나오기 때문).
- **화면 (계획 B)**: `ui/api.js`(라우터와 같은 모양) · `ui/constants.js`(종류 라벨, `groupEnvVars`, `canContinue`) · `ui/EnvVarsCard.jsx`. 배포 상세에 붙는 카드이고 자기 행을 스스로 읽는다. 시크릿 종류는 값 입력창을 주지 않고 건너뛰기만 준다(서버 501과 맞춤). 저장된 값은 화면에 남기지 않는다 (저장에 성공하면 입력칸을 비운다). 자세한 모양은 [`ui-spec.md`](./ui-spec.md) "환경변수 카드".
- 남은 것: 시크릿 값 저장(D8), 컨테이너 로그 기반 이름 찾기(D4 로그 접근 확인 후).

### advice (백엔드 + 화면 - 실제 AWS 배포로는 아직 검증 전)
- `POST /api/deploys/advice`는 임시 폴더에 얕게 클론해 읽고 항상 지운다. 배포 기록·AWS 호출·DB 쓰기가 없다. 같은 `(repo_url, commit_sha)`는 메모리 캐시(최대 100, 프로세스 재시작 시 사라짐)를 쓴다.
- 판정은 규칙뿐이다: 의존성 파일(`requirements.txt` `pyproject.toml` `package.json`)과 소스 일부를 읽어 신호를 모으고 `small/medium/large`와 확신도를 낸다. AI는 환경변수 종류 분류(`envvars`)에서만 쓴다. 심볼릭 링크는 따라가지 않고 테스트 파일은 건너뛴다.
- **숫자는 비워 둔다.** `cpu` `memory`와 `cost`의 금액·기준일은 항상 `null`이다. Express Mode가 허용하는 CPU·메모리 조합과 요금 구성을 실제 배포로 확인한 뒤(D10) 채운다. 사용자가 수준을 고르는 기능(I-08)과 `deploys`의 `size_tier` 등 열도 그때까지 미룬다.
- 정적 사이트는 마법사의 Node 템플릿이 `start` 없는 사이트를 처리하는지 확인하지 않았다 — `needs`에 `static_site`(`supported: true`)로 알리기만 한다.
- `disk_write`는 정규식·AST 추정이라 임시·로그 쓰기를 잘못 잡을 수 있다.
- **화면 (계획 B)**: `ui/api.js` · `ui/constants.js`(수준·확신도·필요한 것 라벨, 모르는 키는 원문 그대로) · `ui/AdvicePanel.jsx`(보여 주기만 하는 패널). 새 배포 폼(`deploys/ui/DeployForm.jsx`)이 [분석] -> 패널 -> [이 레포로 배포]의 두 단계를 조립한다 - `advice`가 `deploys`를 알지 않도록 배포 생성은 폼이 한다. 비용은 최소·최대가 둘 다 숫자일 때만 보여 주고 아니면 "아직 계산할 수 없습니다", `cpu`·`memory`는 그리지 않는다. 수준을 고르는 UI는 `size_tier` 백엔드(D10)가 생길 때까지 미룬다. 자세한 모양은 [`ui-spec.md`](./ui-spec.md) "분석 결과 패널".

### accounts (M6, 진행 중)
- **AWS 연결 완료**: `POST /aws`로 `external_id` 발급 → 사용자가 `cloudformation/deploy_wizard_role.yaml`을 직접 다운로드해 콘솔에서 스택 생성(공개 URL이 없어 원클릭 링크 대신 수동 업로드) → 역할 ARN을 `PATCH /aws/{a_id}/role-arn`에 붙여넣으면 `sts:AssumeRole`로 검증(`verified`/`invalid`).
- `Aws_Account_Service.services_aws_account_build_session(db, aws_account_id)`가 파이프라인이 쓸 세션을 만든다. `aws_account_id`가 없으면(연결 안 함) 지금까지처럼 개발 세션 — M1~M5 동작 그대로 유지된다. `deploys/pipeline.py`·`services_deploy_delete`에 이미 배선됨.
- **GitHub 연결 완료**: `GET /github/install-url`로 설치 화면 이동 → GitHub 콜백(`installation_id`)을 받아 계정 정보 조회 후 저장. `Github_Service.services_github_app_jwt`(RS256, App 개인키로 서명) → `services_github_installation_token`(설치 토큰, contents/metadata 읽기 권한만, 저장 안 함 - 매번 새로 발급).
- **연결이 실제로 클론에 쓰인다**: `Repo_Service.services_repo_clone`/`services_repo_remote`가 `token` 파라미터를 받아 `x-access-token:{token}@github.com/...`으로 바꿔 쓴다(`services_repo_auth_url`). `pipeline.py` 클론 단계·`services_deploy_get_remote`(브랜치 조회) 둘 다 `deploy.github_installation_id`/`github_installation_id` 쿼리로 설치 토큰을 받아 넘긴다. 연결 안 하면 지금까지처럼 public 클론.
- `DeployForm.jsx`에 `AccountPicker.jsx`(AWS/GitHub 드롭다운, `verified`/`active`인 것만 보임)를 얹어서 배포 생성 화면에서 바로 고를 수 있다.
- 전체 설계는 `~/.claude/plans/zany-questing-tower.md` 참고.

### watches (M6, 코드 완료 - 실제 GitHub App/웹훅으로만 검증 가능)
- **폴링**: `Watch_Service.services_watch_poll_loop`이 `main.py` `lifespan()`에서 백그라운드 태스크로 계속 돈다(`WATCH_POLL_SECONDS`, 기본 1시간). `services_deploy_get_pollable`(status='running'인 배포만) → `services_repo_commit_sha`로 원격 커밋 확인(GitHub 연결 있으면 설치 토큰으로) → 바뀌었으면 `auto_redeploy` 켜져 있으면 `services_deploy_redeploy`, 꺼져 있으면 `services_deploy_mark_new_commit`으로 표시만. 배포 하나가 실패해도 나머지는 계속(각자 try/except).
- **웹훅**: `POST /api/watches/webhook` - `X-Hub-Signature-256`(HMAC-SHA256, `GITHUB_WEBHOOK_SECRET`) 검증 후 `push` 이벤트만 처리. `services_deploy_get_by_repo_branch`로 레포+브랜치 매칭(브랜치 미지정 배포는 push의 `repository.default_branch`와 비교) → 매칭된 배포마다 `auto_redeploy` 켜져 있으면 디바운스(`WATCH_DEBOUNCE_SECONDS`, 기본 30초 - 짧은 시간 연속 푸시는 마지막 것만) 예약, 꺼져 있으면 표시만.
- **DB 없는 기능** — `repos`/`builds`처럼 `services.py`뿐. 감시 상태는 전부 `Deploy`(`watch_commit_sha`/`watch_checked_at`)에 얹혀 있다. 디바운스 타이머(`Watch_Service.debounce_tasks`)는 메모리뿐 — 재시작하면 다음 웹훅·폴링이 다시 잡는다.
- 로컬 개발은 공개 URL이 없어 실제 웹훅을 못 받는다 - `smee.io` 중계 필요 (`README.md`).

## 모바일 앱 (`app/`, C1)

`app/`는 `features/`·`shared/`와 따로 있는 Expo 앱(독립 패키지, 순수 JS)이다. 기존 API만 부른다 (서버는 바꾸지 않았다. 다만 D2 에서 `Deploy_Read` 에 `open_incident_status` 를 더하고 `open_incident_id` 가 `needs_action` 인시던트도 덮게 했다). C1 범위는 배포 목록, 새 배포(분석 → 배포), 배포 상세(진행·로그·해설·이력·다시 배포·멈춤·다시 켜기·삭제), 환경변수 입력 카드, C2 에서 더한 계정 연결 화면(`/accounts`: 블록, AWS·GitHub 연결·확인·해제)까지다. D2 에서 인시던트 상세(`/incidents/[i_id]`), 배포 설정, 알림 목록·종 배지, 푸시 권한·토큰 등록, 알림 설정 화면이 더해졌다(푸시는 기기에서 미확인, EAS 프로젝트 id 없음, 웹에는 아직 없음). 로그인, 스토어 빌드, 딥링크 복귀는 아직 없다. 웹과 같은 문구·상태 값을 쓰도록 웹 `ui/` 파일을 보고 옮겼으므로 양쪽을 같이 고친다 (목록은 `app/README.md`와 `docs/ui-spec.md`의 "앱"). 실제 기기에서는 확인하지 못했다.

### health / incidents / notifications (D1, 코드 완료 - 실제 AWS·SMTP·Expo 로는 아직 검증 전)
- 흐름·한도·재시작 때 정리는 [`architecture.md`](./architecture.md) "운영 감시와 자동 복구", 엔드포인트와 응답은 [`api-spec.md`](./api-spec.md) "Incidents", "Notifications · Devices".
- **원인 설명은 규칙 표뿐이다.** 서비스 상태 조회(`describe`)와 최근 헬스체크 5줄을 마스킹한 증거로 규칙에 맞추고, 없으면 기본 안내(`source: "none"`). 컨테이너 로그·ECS 이벤트 수집은 AWS 호출을 검증하지 않아 만들지 않았다. 운영 에이전트(D12)도 같은 이유로 없다.
- **재시작 = 같은 이미지로 서비스 갱신.** 실제로 작업이 다시 뜨는지 검증 전이다. 되돌릴 이전 이미지가 없으면(`bad_release` 제외) 재시작만 해 보고 사람에게 넘긴다.
- **`auto_recover` 기본값은 켜짐.** 배포별로 `PATCH /api/deploys/{d_id}/settings`로 끈다.
- **메일 설정이 없으면(`MAIL_HOST`·`MAIL_TO`) 메일은 건너뛴다** (줄도 남기지 않음). 푸시 `sent`는 Expo 가 받았다는 뜻일 뿐 기기 도착이 아니다 (영수증 확인 안 함).
- 알림은 `u_id` 없이 한 사람 기준이다. 로그인이 생기면 사용자별로 나눈다.
- 알려진 한계(미뤄 둠): 같은 커밋 재배포 시 복구 막힘 유지, 설정 첫 읽기 경쟁, 알림 표 정리 없음, 검증 점검이 헬스 행으로 남지 않음 등. 목록은 `docs/worklog/2026-11-10.md`.

## 앞으로 생길 기능

| 기능 | 내용 | 마일스톤 |
|------|------|----------|
| `databases` | RDS 생성, 서브넷 그룹, 보안그룹 인바운드, 접속정보 주입 | M7 |
| `stacks` | 백엔드 → 주소 → 프론트 빌드 순서 배포 | M8 |
| `monitors` | 로그 감시(규칙) → 이상 감지 → 해설 → 조치안 | M9 |
| `lessons` | 학습 모드 — 미리 써 둔 고정 설명 텍스트 | M10 |
| `gallery` | 쇼케이스, 신고, 임시 숨김 | M11 |
