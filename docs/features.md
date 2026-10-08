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
| `accounts` | 사용자 AWS 계정 연결(CloudFormation+AssumeRole) · GitHub App 연결 - 연결·파이프라인 배선(private 클론 포함) 완료 | models · scheme · crud · services · router · cloudformation/ · ui | M6 (진행 중) |
| `watches` | 코드 변경 감지 - 폴링(백그라운드) + 웹훅(서명 검증 + 디바운스) 둘 다 코드 완료 | services | M6 (코드 완료, 실제 검증 남음) |

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

## 앞으로 생길 기능

| 기능 | 내용 | 마일스톤 |
|------|------|----------|
| `databases` | RDS 생성, 서브넷 그룹, 보안그룹 인바운드, 접속정보 주입 | M7 |
| `stacks` | 백엔드 → 주소 → 프론트 빌드 순서 배포 | M8 |
| `monitors` | 로그 감시(규칙) → 이상 감지 → 해설 → 조치안 | M9 |
| `lessons` | 학습 모드 — 미리 써 둔 고정 설명 텍스트 | M10 |
| `gallery` | 쇼케이스, 신고, 임시 숨김 | M11 |
