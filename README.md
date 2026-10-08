# AWS 자동 배포 마법사

**GitHub 주소 하나로 컨테이너가 뜨고 HTTPS 주소가 나오는 것.**
AI가 Dockerfile을 쓰고, 빌드해서, AWS ECS Express Mode에 올리고, 접속 가능한 주소를 돌려준다. 실패하면 멈추고, 원인을 한국어로 설명한 뒤 어떻게 할지 묻는다.

```
GitHub 주소 → 클론 → 언어 판별(규칙) → Dockerfile(템플릿+LLM) → 빌드 → ECR 푸시 → Express Mode 배포 → https://…
```

1인 개인 프로젝트 · 마감 없음 · 배포 학습 병행. 기획서는 [`AWS_자동배포마법사_개인프로젝트_기획서.pdf`](./AWS_자동배포마법사_개인프로젝트_기획서.pdf).

## 기술 스택

| 영역 | 스택 |
|------|------|
| API | FastAPI (Python 3.12), async SQLAlchemy 2.0 |
| DB | SQLite (기본, `DB_URL`로 교체 가능) |
| AWS | boto3 · ECS Express Mode · ECR |
| LLM | Anthropic SDK (`claude-opus-5`, 구조화 출력) — 없어도 정식 언어는 규칙으로 동작 |
| 화면 | React 19 · Vite · react-router |
| 도구 | git, Docker |

## 폴더 구조

백엔드/프론트엔드로 나누지 않고 **기능별로** 나눈다. 한 기능의 서버 코드와 화면이 같은 폴더에 있다.

```
/
├── CLAUDE.md              ← AI agent 진입점 (규칙, 상태값, 네이밍)
├── docs/                  ← 프로젝트 문서
├── main.py                ← FastAPI 진입점
├── features/              ← ★ 기능 하나 = 폴더 하나
│   ├── deploys/           ← 배포 기록 + 파이프라인 + 화면(ui/)
│   ├── repos/             ← 클론, 언어 판별, LLM에 보낼 요약
│   ├── dockerfiles/       ← 템플릿 + LLM 빈칸 채우기, 자가수정
│   ├── builds/            ← docker build, ECR 푸시
│   ├── express/           ← ECS Express Mode 호출
│   ├── explains/          ← 한국어 에러 해설 + 화면(ui/)
│   └── accounts/          ← (M6, 진행 중) 사용자 AWS·GitHub 계정 연결 + 화면(ui/)
├── shared/                ← 공용 (설정, DB, AWS 세션, LLM, 마스킹, ui/)
├── scripts/               ← M1 배포, 역할 생성, 정리, CLI
└── tests/
```

## 시작하기

```bash
# 1. 파이썬
python -m venv .venv
.venv\Scripts\activate            # mac/linux: source .venv/bin/activate
pip install -r requirements.txt

# 2. 설정
copy .env.example .env            # AWS_REGION 확인
aws login                         # 브라우저 콘솔 로그인 (AWS CLI 2.32.0+). 액세스 키 불필요, 12시간마다 다시
python scripts/check_aws.py       # 붙는지 확인 (읽기 전용)
python scripts/setup_roles.py     # IAM 역할 두 개 생성 → 출력된 두 줄을 .env 에

# 3. 서버 + 화면
uvicorn main:app --port=8081 --reload
npm install
npm run dev                       # http://localhost:5173
```

화면 없이 파이프라인만 돌리려면:

```bash
python scripts/m1_deploy.py                                   # M1 — nginx 이미지 하나 띄우기
python scripts/deploy_cli.py https://github.com/소유자/레포    # M3 — 주소 하나로 끝까지
python scripts/session_end.py --yes                           # 작업을 마칠 때 — 요금 나가는 것만 멈추고 기록은 남긴다 (다음에 [다시 켜기])
python scripts/cleanup.py --yes                               # 완전히 정리 — 태그 붙은 리소스를 전부 지운다
```

> ⚠️ **비용** — Express Mode가 만드는 로드밸런서는 떠 있는 동안 계속 과금된다. 작업을 끝낼 때 `cleanup.py`를 실행한다. AWS Budgets 예산 알림을 먼저 걸어 둘 것.

### M6 — 사용자 계정 연결 (진행 중)

`/accounts` 화면에서 AWS·GitHub 계정을 연결하면, 개발자 자신의 계정이 아닌 곳에 배포할 수 있다. 둘 다 아래 값들을 한 번 수동으로 준비해야 한다(`setup_roles.py`와 같은 성격의 1회성 단계).

- **AWS**: 화면에서 "새 AWS 계정 연결" → `.env`에 `SECRET_KEY` 필요(생성: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`) → 나머지는 화면이 안내한다.
- **GitHub App**: [github.com/settings/apps/new](https://github.com/settings/apps/new)에서 한 번 등록. 권한은 최소로 — Repository permissions의 **Contents: Read-only**, **Metadata: Read-only**만. 등록하면 발급되는 값들을 `.env`에:
  ```
  GITHUB_APP_ID=...
  GITHUB_APP_SLUG=...                              # 앱 URL의 마지막 부분
  GITHUB_APP_PRIVATE_KEY_PATH=./data/github-app-private-key.pem   # 등록 시 받는 .pem 저장
  GITHUB_WEBHOOK_SECRET=...                        # 웹훅 설정에서 직접 정함 (아직 미사용, watches 단계에서 씀)
  ```
- 로컬 개발 중 실제 GitHub 웹훅을 받으려면 공개 URL이 없으므로 [smee.io](https://smee.io) 같은 중계가 필요하다:
  ```bash
  npx smee-client -u https://smee.io/<채널> -t http://localhost:8081/api/watches/webhook
  ```
  GitHub App 설정의 Webhook URL에 smee 채널 주소를 넣고, Webhook secret은 `.env`의 `GITHUB_WEBHOOK_SECRET`과 똑같이 맞춘다.

## 테스트

```bash
pytest
```

실제 AWS·LLM·Docker 없이 돈다. 주소 검증, 언어 판별, 제외 필터, 템플릿 렌더링, 에러 해설 규칙, API, 파이프라인 실패 처리를 본다.

## 문서

| 문서 | 경로 | 설명 |
|------|------|------|
| 아키텍처 | [`docs/architecture.md`](./docs/architecture.md) | 기능 폴더 구조, 의존 방향, 파이프라인, DB |
| 컨벤션 | [`docs/conventions.md`](./docs/conventions.md) | 코드 스타일, 네이밍, 예외 처리, 커밋 규칙 |
| 기능 | [`docs/features.md`](./docs/features.md) | 기능별 책임과 경계 |
| API 스펙 | [`docs/api-spec.md`](./docs/api-spec.md) | REST 엔드포인트, 상태값 |
| UI 스펙 | [`docs/ui-spec.md`](./docs/ui-spec.md) | 화면 명세, 디자인 토큰 |
| AWS 메모 | [`docs/aws-notes.md`](./docs/aws-notes.md) | Express Mode 검증 내용, 권한, 함정 |
| 마일스톤 | [`docs/milestones.md`](./docs/milestones.md) | M0~M11 진행 상황 |
| 작업 기록 | [`docs/worklog/`](./docs/worklog/) | 날짜별 작업 내용 |
