# UI 스펙

React 19 + Vite + react-router. 화면 코드는 각 기능의 `ui/`에 있고, `shared/ui/App.jsx`는 경로만 잇는다.

| 경로 | 화면 | 파일 |
|------|------|------|
| `/` | 새 배포 + 내 배포 목록 | `features/deploys/ui/DeployListPage.jsx` |
| `/deploys/:d_id` | 배포 상세 | `features/deploys/ui/DeployDetailPage.jsx` |
| `/accounts` | 계정 연결 (M6, AWS 절반만) | `features/accounts/ui/AccountsPage.jsx` |

## 1. 목록 (`/`)

**새 배포** — 위에 연결 블록 드롭다운(`AccountPicker`, 연결이 있을 때만), 그 밑에 GitHub 주소 입력창.
- 주소 입력창은 직접 입력도, 목록에서 고르기도 된다(`<input list>` + `<datalist>`). GitHub가 살아 있는 블록을 고르면 `GET /api/accounts/github/{g_id}/repositories`로 그 계정이 읽을 수 있는 레포 주소를 받아 목록에 채운다(옆에 public/private). 목록을 못 불러와도 직접 입력은 된다.
- [브랜치 고르기]를 누르면 `GET /remote`로 목록을 받아 드롭다운으로 바뀐다. 기본 브랜치가 선택돼 있고 `(기본)` 표시.
- 고르지 않고 [배포]를 누르면 기본 브랜치.
- (M6) 연결된 계정이 있으면 주소 입력창 위에 `AccountPicker`(블록 드롭다운, 기본은 "연결 안 함")가 나온다. GitHub 연결을 고르면 private 레포도 배포 가능. 연결이 하나도 없으면 이 영역 자체가 안 보인다.
- 성공하면 상세 화면으로 이동. 실패하면 서버의 `detail`을 폼 아래에 보여 준다.

**내 배포** — 레포 이름, `#d_id · 브랜치 · 언어 · 주소`, 상태 배지.
- 진행 중인 배포가 있으면 3초, 없으면 15초마다 새로 읽는다.

## 2. 상세 (`/deploys/:d_id`)

위에서부터:

1. **머리** — 레포, `#d_id · 브랜치 · 커밋 7자 · 언어 · 앱 폴더`, 배지(실험 지원 / 자가수정 N회 / 상태)
2. **단계 진행** — 클론 → 판별 → Dockerfile → 빌드 → 푸시 → 배포 → 완료. 지난 단계 초록, 현재 단계 파랑(깜빡임), 실패한 단계 빨강
3. **주소 카드** (`running`일 때) — 클릭 가능한 HTTPS 주소, 헬스 배지, 요금 안내 한 줄
4. **해설 카드** (`failed`일 때) — `features/explains/ui/ExplainCard.jsx`
   - 한 문장 요약 → 원인 → 번호 매긴 조치 → 원문 에러
   - 버튼: **[다시 배포]** · **[만들어진 리소스 정리]**(리소스가 있을 때만) · 안내문 "아무것도 누르지 않으면 그대로 둡니다"
5. **터미널 로그** — 1.5초 폴링, `after`로 새 줄만. 바닥을 보고 있을 때만 자동 스크롤. `cmd` 파랑 / `warn` 노랑 / `error` 빨강
6. **Dockerfile** — 접힌 상태. 출처와 포트 표시
7. **문제 이력** (지난 실패가 있을 때) — 접힌 상태. 단계·시각·해설 한 줄씩, 최신순. `features/deploys/ui/IssueHistory.jsx`
8. **동작 버튼** (`running`일 때) — [다시 배포] [삭제]

**삭제 확인 대화상자** — "ECS 서비스와 ECR 이미지가 함께 지워집니다. 되돌릴 수 없습니다." [그대로 두기] [삭제]. 기본 포커스는 안전한 쪽.

### 묻는 방식 (기획서 03장)

열린 질문("어떻게 할까요?")이 아니라 **버튼 두세 개**. 파괴적인 동작은 빨간 테두리 + 확인 대화상자. 설정 변경이 곧바로 배포로 이어지지 않는다.

## 3. 계정 연결 (`/accounts`, M6)

상단 네비게이션 "계정 연결" 링크로 이동. 카드 두 개.

**AWS 계정** — 연결 목록(라벨, 계정 번호, 상태 배지 `pending`/`verified`/`invalid`) + `[새 AWS 계정 연결]`.
- 새 연결은 대화상자 2단계: ① 라벨 입력 → `POST /aws` ② 발급된 `external_id`·우리 계정 번호를 보여주고, 단계별 안내(`AwsStackGuide.jsx`, 넓은 대화상자 `dialog.wide`) — 템플릿 다운로드, 콘솔 스택 생성 화면 바로가기(`stack_create_url`, 새 탭), 단계마다 콘솔 화면을 단순하게 그린 그림(`.shot`, 실제 스크린샷 아님), 스택 이름·`TrustedAwsAccountId`·`ExternalId`는 값마다 [복사] 버튼, IAM 승인 체크, [출력] 탭 위치 → 역할 ARN 붙여넣기. 실패 메시지는 대화상자 안에도 표시. 창을 닫은 `pending` 연결은 목록의 [역할 ARN 입력]으로 이어서 한다(ExternalId는 다시 안 보여줌). `verified` 연결 줄에는 템플릿 상태 한 줄("템플릿 최신 (버전 N) · S3에 올린 템플릿 파일 N개 남음 / 남은 템플릿 파일 없음")을 보여주고, 남은 파일이 있을 때만(`template_file_count > 0`) [템플릿 파일 삭제]를 띄운다 — 지우면 상태를 다시 읽어 버튼이 사라지고 문구가 바뀐다. 확인 대화상자 후 `DELETE /aws/{a_id}/template-files`, 결과는 초록 알림(`.notice.ok`). 목록을 불러올 때 `verified` 연결마다 `GET /aws/{a_id}/template-status`를 물어보고, `update_needed`면 그 줄에 주황 안내(`.notice.warn` "스택 업데이트 필요")와 [스택 업데이트] 버튼을 띄우고 [템플릿 파일 삭제]는 숨긴다. 버튼은 업데이트 안내 대화상자(`AwsStackUpdateGuide.jsx`, 5단계 그림) → [업데이트 확인]이 상태를 다시 읽어 최신이면 닫고 초록 알림, 아니면 창 안에 "아직 예전 버전" 표시
- **화면은 연결 블록 단위다** (2026-10-06, 배치는 2026-10-08에 바꿈). 맨 위 제목 "계정 연결". 그 아래 블록 카드를 **한 번에 하나만** 보여준다 = 이름 + 오른쪽 [＋ 블록 추가](이름만 물어 빈 블록을 만든다)·[블록 삭제] + 상자 두 개(`AccountBox.jsx`, `.account-boxes` — 왼쪽 AWS 계정, 오른쪽 GitHub 계정, 좁은 화면에서는 위아래). 블록이 하나도 없을 때만 [＋ 블록 추가]가 제목 오른쪽에 뜬다. 새 배포 폼의 `AccountPicker`는 블록 하나를 고르는 드롭다운 하나다.
  - 블록 카드 맨 밑(`.block-pick`): 양 끝의 `‹` `›`로 블록을 넘기고, 가운데 `n / 전체`와 그 밑 [선택]으로 새 배포에 쓸 블록을 고른다(고른 블록은 "선택됨"). 고른 블록은 이 브라우저의 `localStorage`(`dw-picked-block`, `pickedBlock.js`)에만 기억하고, `AccountPicker`가 블록이 여럿일 때 그것을 미리 골라 둔다. 블록이 하나뿐이면 늘 "선택됨"이다.
  - 상자 하나: 위 왼쪽 이름("AWS 계정"/"GitHub 계정"), 위 오른쪽 상태 배지(이 블록이 쓰는 계정을 보는 중이면 그 상태, 아니면 "연결 안 됨"). 가운데 `‹ 계정 정보 ›` — 화살표로 이미 연결해 둔 계정(AWS는 `GET /aws`, GitHub는 `GET /github` 전부)을 넘겨 보고, 그 아래 `n / 전체`, 다시 그 밑에 [선택](이 블록에 잇는다 → `PATCH /connections/{c_id}`. 이미 쓰는 계정이면 "선택됨"으로 잠긴다). 아래 줄(`.account-foot`)은 왼쪽 [계정 추가], 가운데 [연결 확인], 오른쪽 [연결 해제].
  - [계정 추가]: 블록에 아직 계정이 없으면 새로 연결해 이 블록에 잇는다(AWS는 블록 이름으로 `POST /connections/{c_id}/aws`, GitHub는 설치 주소에 `c_id`). 이미 있으면 새 계정만 만들고 블록은 그대로 둔다 — AWS는 이름을 묻는 창 → `POST /aws` → 안내 창, GitHub는 `c_id` 없이 설치 화면. 연결을 마친 뒤 화살표로 찾아 [선택]한다.
  - 가운데 버튼은 보이는 계정의 상태에 따라 바뀐다: AWS가 `pending`이면 [역할 ARN 입력], `invalid`면 [다시 확인], 그 밖에는 [연결 확인]. [스택 업데이트]·[템플릿 파일 삭제]는 상자 가운데 계정 정보 밑에 뜬다.
  - [연결 해제]는 이 블록이 쓰는 계정을 보고 있을 때 눌린다(AWS는 어느 블록도 안 쓰는 계정을 보고 있을 때도 — 확인 뒤 연결을 지운다). GitHub는 블록에서 떼기만 한다. AWS는 다른 블록도 그 계정을 쓰면 이 블록에서만 떼고, 이 블록만 쓰면 확인 대화상자 뒤 연결을 지운다(`DELETE /aws/{a_id}`).
- **연결은 "안내 창 + 작업 창"으로 한다** (`/guide/github`, `/guide/aws` — `ConnectGuidePage.jsx`, 상단 바 없는 좁은 팝업, `guideWindow.js`의 `openGuideWindow`). 팝업은 반드시 클릭 처리 안에서 바로 연다(서버 응답을 기다린 뒤 열면 차단된다).
  - GitHub: [GitHub 연결] → 안내 창이 뜨고 원래 창은 GitHub 설치 화면으로 이동 → 설치가 끝나면 GitHub가 원래 창을 `/accounts?connected=github`로 돌려보낸다 → 원래 창이 주소를 정리하고 `BroadcastChannel('dw-accounts')`로 `github-connected`를 보내 안내 창을 닫게 하고, `GET /github/{g_id}/check` 결과를 초록 알림으로 보여준다.
  - AWS: [새 AWS 계정 연결] → 이름 → [다음] → 안내 창이 뜨고(값은 `postMessage`로 전달, ExternalId를 주소에 싣지 않는다) 원래 창의 대화상자는 닫힌다 → 안내 창 7번에서 RoleArn을 넣고 [확인] → 안내 창이 `aws-connected`를 알리고 닫히며 원래 창이 앞으로 온다 → 원래 창이 목록을 새로 읽고 확인 결과를 알린다. 팝업이 차단되면 예전처럼 원래 창 안의 대화상자로 안내한다.
  - 연결된 줄마다 [연결 확인] — AWS는 역할을 다시 빌려 보고(`reverify`), GitHub는 설치 토큰으로 레포를 세어 본다.
- 배포 상세(`/deploys/:d_id`): `running`이면 [다시 배포] [멈춤] [삭제], `stopped`이면 안내 카드의 [다시 켜기] + [삭제]. 멈춤·삭제는 확인 대화상자, 다시 켜기는 버튼 한 번 → `PATCH /aws/{a_id}/role-arn`.
- `invalid` 행에는 `[다시 확인]`(`POST /aws/{a_id}/reverify`)과 실패 사유(`last_error`)를 보여준다.

**GitHub 연결** — 연결 목록(계정 이름, 개인/조직, 전체/선택 레포, 상태 배지) + `[GitHub 연결]`(누르면 바로 GitHub 설치 화면으로 이동, 대화상자 없음).
- 설치를 끝내면 GitHub이 콜백으로 돌려보내고(`?connected=github`), 목록에 바로 나타난다.

두 카드 모두 삭제는 확인 대화상자 — "이 연결을 쓰던 배포들의 연결이 끊깁니다. 앱 설치나 CFN 스택 자체는 지워지지 않습니다" 안내(연결만 끊는다는 뜻, 실제 회수는 각자 콘솔/github.com에서 하라는 것을 명확히).

## 디자인 토큰

`shared/ui/styles.css`의 `:root`에 정의. 컴포넌트에 색을 직접 쓰지 않는다. `prefers-color-scheme: dark`에서 같은 이름으로 재정의된다.

| 토큰 | 용도 |
|------|------|
| `--bg` `--surface` `--surface-2` `--border` | 바탕, 카드, 옅은 면, 선 |
| `--text` `--muted` | 본문, 보조 글자 |
| `--accent` `--accent-text` | 주 버튼, 링크, 진행 중 |
| `--ok` `--ok-bg` | 정상 |
| `--warn` `--warn-bg` | 실험 지원, 자가수정 |
| `--err` `--err-bg` | 실패, 삭제 |
| `--term-bg` `--term-text` | 터미널 (두 테마 모두 어둡게) |
| `--radius` `--mono` | 모서리, 고정폭 글꼴 |

상태 배지: `running` → ok · `failed` → err · 진행 중 → accent(점 깜빡임) · 그 외 → muted.

## 아직 없는 것

- 자동 재배포 설정, 대상 브랜치 변경 (M6)
- 학습 모드 토글 (M10), 갤러리 (M11)
