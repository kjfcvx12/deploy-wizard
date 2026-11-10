# 배포 마법사 앱 (Expo)

기존 FastAPI 서버(`uvicorn main:app --port=8081`)에 붙는 모바일 앱이다. 서버 코드는 바꾸지 않고, 웹과 같은 API만 쓴다.
이 폴더는 독립 패키지다. `app/` 밖의 파일을 가져오지 않는다.

## 준비

```bash
cd app
npm install
cp .env.example .env     # 서버 주소를 환경에 맞게 고친다
```

`EXPO_PUBLIC_API_BASE_URL` (기본값 `http://localhost:8081`)

| 실행 환경 | 값 |
|---|---|
| iOS 시뮬레이터 / 웹 | `http://localhost:8081` |
| 안드로이드 에뮬레이터 | `http://10.0.2.2:8081` |
| 실제 폰 | PC 의 LAN 주소 (같은 와이파이, 방화벽에서 8081 허용) |

계정 연결 화면의 템플릿 내려받기 링크(`/api/accounts/aws/template`)는 서버가 준 상대 경로에 이 주소를 붙여 연다. 그래서 `localhost` 로 빌드한 앱은 실제 폰에서 이 링크를 열 수 없다. 폰에서 쓰려면 위 표의 LAN 주소로 빌드해야 한다. GitHub 설치를 마친 뒤 GitHub 이 부르는 콜백(서버의 `/github/callback`)이 설치를 저장한다. 그래서 GitHub 앱에 등록된 콜백 주소가 **폰의 브라우저에서 열려야** 한다. 열리지 않으면 설치가 저장되지 않아 앱으로 돌아와도 아무것도 바뀌지 않는다 (앱은 `아직 설치가 확인되지 않았습니다 ...` 안내를 보이고, 그 경우 PC 에서 연결해야 한다). 앱은 콜백이 보내는 `?connected=github` 페이지를 쓰지 않고, 앱으로 돌아오면 목록을 다시 읽는다 (아래 "플랫폼별로 다르게 한 것").

값은 빌드할 때 코드에 박힌다. 바꾼 뒤에는 `npx expo start --clear` 로 다시 켠다.
서버는 인증이 없는 로컬 전용이다 (1단계). 밖에 열지 않는다. 로그인·토큰 코드는 아직 없다.

`.env` 는 커밋하지 않는다 (`app/.env` 는 `.gitignore` 에 있다). Windows PowerShell 에서는 `cp` 대신 `Copy-Item .env.example .env` 를 쓴다.

웹으로 띄운 앱(`npx expo start --web --port 8082`)이 실제 서버를 부르면 서버의 CORS 가 막는다. 서버는 기본으로 `http://localhost:5173`, `http://127.0.0.1:5173` 에서 온 요청만 받기 때문이다 (`CORS_ORIGINS`). 웹에서 실제 서버로 붙여 보려면 서버 `.env` 의 `CORS_ORIGINS` 에 `http://localhost:8082` 를 더한다. iOS·안드로이드는 브라우저가 아니라서 CORS 가 걸리지 않는다. 모의 API 로 확인한 방법은 아래 "확인한 것과 못 한 것"에 있다.

## 실행

```bash
npx expo start --port 8082   # API 서버가 8081 을 쓰므로 Metro 는 다른 포트로 띄운다. QR 코드를 Expo Go 로 읽거나, a / i / w 키로 에뮬레이터·웹을 연다
npx jest                 # 로직 테스트 (서버·기기 필요 없음)
npx expo export --platform web   # 웹 번들이 만들어지는지 확인 (dist/)
```

## 폴더

```
app/              Expo Router 화면 (파일 이름이 주소)
src/api.js        서버 호출 (웹의 api.js 와 같은 의미)
src/constants.js  상태·환경변수·분석 라벨 (웹 constants.js 와 같은 값)
src/envGroups.js  환경변수 행 묶음 규칙
src/theme.js      색 토큰, 간격, useColors()
src/components/   화면 조각 (StatusBadge, AdvicePanel, ConnectionPicker, NoConnectionHint, StepProgress, LogTerminal, ExplainCard, IssueHistory, EndpointCard, EnvVarsCard, EnvRow, ui)
src/components/accounts/  계정 연결 화면 조각 (BlockCard, AddBlockForm, AwsBox, AwsGuide, AwsUpdateGuide, GithubBox, ExistingPicker, GuideParts)
src/accounts/     계정 연결 상수·문구(constants, notices), 고른 블록 저장(pickedBlock), 외부 링크·복사(external)
src/confirm.js    확인 창 (앱은 Alert, 웹은 브라우저 confirm)
src/hooks/        usePolling (주기 호출, 백그라운드에서는 멈춤, STOP_POLLING 으로 중단), useOnForeground (앱이 다시 앞으로 올 때 한 번 부름), useUnreadCount (안 읽은 알림 수), usePushSetup, useNotificationRouting
src/ops/          인시던트·알림 상수와 문구(constants), 시각·타임라인(format), 앱 링크 검사(links), 푸시(push, notifications, notifications.web), 알림 설정 문구(notificationSettings)
src/components/ops/  HealthBar, HealthDot, ProblemBanner, IncidentCard, IncidentTimeline, NotificationItem, BellButton, QuickLinks, PushPermissionGuide, PushSetupCard
src/components/SettingSwitch.js  설정 스위치 한 줄 (배포 설정·알림 설정이 같이 씀)
```

## 화면 (C1·C2 2026-11-09, D2 2026-11-10)

| 경로 | 화면 | 웹에서 같은 화면 |
|---|---|---|
| `/` | 배포 목록 (진행 중 3초, 아니면 15초마다 갱신) | `/` 의 목록 |
| `/new` | 새 배포: 주소 입력 → `분석` → 결과 패널 → `이 레포로 배포` | `/` 의 새 배포 폼 + 분석 패널 (S-20) |
| `/deploys/[d_id]` | 배포 상세: 진행 단계, 주소, 로그, 해설, 이력, 다시 배포·멈춤·다시 켜기·삭제, 환경변수 카드 (S-19) | `/deploys/:d_id` |
| `/incidents/[i_id]` | 인시던트 상세 (D2): 상태 배지, 원인·고칠 곳(복사)·해야 할 일, `마법사가 한 일` 타임라인(감지, 재시작·되돌리기 시도와 결과, 해결·확인 필요), 최근 24시간 헬스체크 막대. 진행 중(`open`·`recovering`)이면 5초마다 갱신하고 `resolved`·`needs_action` 이 되면 멈춘다. `needs_action` 이면 `다시 배포`·`멈춤`(확인 창)·`그대로 두기`. 앱이 스스로 하는 조치는 없고 모두 사용자가 누른 버튼이다 | 아직 없음 (웹 대응은 다음 계획) |
| `/notifications` | 알림 목록 (D2): 안 읽은 것은 굵게, 누르면 읽음 처리(`POST /notifications/{n_id}/read`)하고 인시던트·배포 화면으로 이동, `모두 읽음`, `더 보기`(`after` 로 이어 받기), 아래로 당겨 새로고침 | 아직 없음 |
| `/notification-settings` | 알림 설정 (D2): 메일·푸시 스위치, 알림 종류 6개 스위치(바꾸면 전체 종류 배열을 `PATCH /notifications/settings` 로 보냄). 푸시 줄에서만 OS 권한을 묻는다 (아래 "푸시 알림") | 아직 없음 |
| `/deploy-settings/[d_id]` | 배포 설정 (D2): `새 커밋이 오면 자동 재배포`·`문제가 생기면 자동 복구` 스위치. 바꾼 항목만 `PATCH /deploys/{d_id}/settings` 로 보낸다 (실패하면 그 스위치만 되돌림). 배포 상세의 `설정` 버튼으로 들어간다 | 아직 없음 |
| `/accounts` | 계정 연결 (C2): 블록 카드 목록(추가·삭제·`선택`), 블록마다 AWS 상자(7단계 안내, 역할 ARN, 연결 확인, 스택 업데이트 안내, 템플릿 파일 삭제, 연결 해제, 기존 계정 고르기)와 GitHub 상자(설치 열기, 돌아오면 확인, 연결 해제, 기존 계정 고르기). 아래로 당겨 새로고침 | `/accounts` (M6, B-01~B-07) |

목록 머리줄에는 알림 종(`🔔`, 안 읽은 수 배지 `99+` 까지)과 `＋ 새 배포` 가 있고, 그 밑 줄에 `계정 연결`·`알림 설정` 칩이 있다. 끝나지 않은 인시던트가 있는 배포는 목록 위에 `{레포}에 문제가 있습니다 · 자동 복구 중` (자동 복구가 꺼져 있거나 인시던트가 `needs_action` 이면 `확인이 필요합니다`) 배너가 한 줄씩 나오고 누르면 인시던트 화면으로 간다. `running` 카드에는 헬스 점이 붙는다. 배포 상세에는 인시던트 카드가 있다. 목록은 화면에 다시 올 때마다 새로 읽는다. `/new` 는 `계정 연결` 에서 `선택`한 블록(없으면 쓸 수 있는 블록이 하나뿐일 때 그것)을 미리 고르고, 쓸 수 있는 연결이 없으면 `계정 연결 열기` 안내를 보여 준다. `계정 연결` 에 다녀와 다시 보이면 연결 목록을 다시 읽는다 (직접 고른 선택은 덮지 않고, 고른 블록이 사라지거나 쓸 수 없게 되면 선택과 분석 결과를 비운다).

없는 것: 인시던트 목록 화면(상세만 있다), 로그인, 스토어 빌드(EAS), 운영 에이전트, 오프라인 저장, 생체 인식 잠금, GitHub·AWS 에서 앱으로 돌아오는 딥링크, 웹의 "PC에서 이어서 하기" 같은 링크. 앱 이름과 번들 ID(`app.json`)는 임시값이다.

## 푸시 알림 (D2)

코드: `src/ops/push.js` (상태 읽기·등록·해제·알림 탭 경로), `src/hooks/useNotificationRouting.js` (루트 레이아웃에서 한 번: 앞에서 받은 알림 표시, 알림 탭 이동, 꺼져 있다가 눌러 켠 첫 실행), `src/hooks/usePushSetup.js` + `PushSetupCard` (배포가 `running` 일 때 한 번 보이는 안내 카드), `PushPermissionGuide` (S-17), `app/notification-settings.js` (알림 설정, 목록의 `알림 설정` 칩).

- 권한은 안내 글을 읽고 `알림 켜기` 를 누른 뒤에만 묻는다. 앱 시작·화면 열림·카드 표시는 묻지 않는다.
- 푸시 토큰은 `POST /api/devices` 로만 보낸다. 화면·로그·저장소·오류 문장에 넣지 않는다. 저장소에는 서버가 돌려준 기기 번호(`p_d_id`, 키 `dw-push-device`)만 둔다. 안내 카드를 닫은 기록은 `dw-push-card-dismissed`.
- EAS 프로젝트 id 는 `Constants.expoConfig.extra.eas.projectId` (없으면 `Constants.easConfig.projectId`)에서 읽는다. `app.json` 에는 값을 넣지 않았다. 없으면 상태가 `no_project` 이고 앱이 "스토어 빌드 준비(EAS 프로젝트 연결)가 필요하다"고 안내한다 (나머지 기능은 그대로). 프로젝트를 만들어 id 를 넣는 것은 사람이 해야 하는 일이다 (`npx eas init` 등, 이 저장소에서는 하지 않았다).
- 알림 탭은 `data.link` 가 `deploywizard://deploys/{n}` 또는 `deploywizard://incidents/{n}` 일 때만 그 화면으로 보낸다. 다른 값은 모두 무시한다 (`ops/links.js` 의 `parseAppLink`).
- 설정 화면의 푸시 스위치는 서버의 `notify_push`(모든 기기 공통)가 켜져 있고, **이 기기가 준비됐을 때**(권한이 허용이고 저장된 `p_d_id` 가 있을 때)만 켜진 것으로 보인다. 이 기기가 준비되지 않았으면 서버 값이 켬이어도 꺼진 것으로 보인다. 그래서 준비되지 않은 기기에서는 모든 기기 공통인 `notify_push` 를 끌 수 없다 (켜려면 `알림 켜기` 를 거쳐야 하고, 이 기기에서 끄는 것은 서버 값과 기기 등록을 함께 끈다). 화면에 "이 설정은 모든 기기에 적용됩니다"가 적혀 있다.
- 웹에서는 `expo-notifications` 를 번들에 넣지 않는다 (`src/ops/notifications.web.js`) - 불러오기만 해도 콘솔 경고가 나서다. 웹의 푸시 상태는 `unsupported` 다.
- `expo-device` 는 쓰지 않는다 (공식 설정 문서가 요구하지 않는다). 그래서 "실제 기기가 아님"을 따로 가려내지 않고, 시뮬레이터·에뮬레이터에서는 OS 와 `getExpoPushTokenAsync` 가 되는 만큼만 된다.

**Expo Go 제한 (공식 문서 인용):** "Push notifications (remote notifications) functionality ... is unavailable in Expo Go on Android from SDK 53. A development build is required." 로컬 알림은 Expo Go 에서도 된다. 그래서 푸시는 개발 빌드(`expo-dev-client`/EAS Build) 또는 실제 기기 빌드에서만 시험할 수 있고, Expo Go 에서는 안드로이드 푸시가 오지 않는다. iOS 의 Expo Go 제한은 이번에 확인한 문서에 없었다. 푸시는 Expo 푸시 서비스와 EAS 프로젝트 id 가 있어야 하며, 이 저장소에서는 한 번도 돌려 보지 못했다.

**확인한 것 (푸시, 목 테스트와 모의 웹):** `npx jest` 로 `expo-notifications` 를 목(mock)으로 바꾼 테스트 - 권한은 버튼에서만, 등록 한 번(연타 포함)·해제(404·오프라인 허용), 토큰이 화면·콘솔·저장소·오류에 없음, 알림 탭 경로 표(허용·허용 밖·다른 스킴·`data` 없음·문자열 아님·첫 실행), 설정 스위치 적용·되돌림, 안내 카드 조건. `expo export --platform web` 빌드, 웹 번들을 Playwright(390x844, 라이트·다크)로 열어 `/api/**` 를 모의하고 목록 `알림 설정` → 설정 화면(푸시 줄에 `unsupported` 안내) → 메일·종류 스위치 PATCH 본문 확인 → 실패 되돌림 → 뒤로.
**확인 못 한 것 (전부, 푸시):** 실제 iOS·안드로이드 기기·에뮬레이터에서의 실행, 실제 OS 권한 창과 설정 열기, 실제 `getExpoPushTokenAsync` 와 Expo 푸시 서비스로 보낸 알림, 알림 채널(안드로이드), 앞에서·뒤에서·꺼진 상태에서 알림을 눌렀을 때의 실제 이동(특히 첫 실행에서 `router.push` 가 내비게이션 준비 전에 불리는지), 실제 백엔드·SMTP. 푸시는 검증되지 않았다.

## 웹과 겹치는 파일

문구와 상수는 웹 파일을 보고 옮겨 적은 것이라, 한쪽을 바꾸면 반대쪽도 같이 바꿔야 한다 (앱은 `app/` 밖의 파일을 가져오지 않는다).

| 앱 | 웹 |
|---|---|
| `src/api.js` | `features/deploys/ui/api.js`, `features/envvars/ui/api.js`, `features/advice/ui/api.js` |
| `src/constants.js` (상태 이름·진행 단계·`needs_input`·환경변수 종류·분석 라벨) | `features/deploys/ui/constants.js`, `features/envvars/ui/constants.js`, `features/advice/ui/constants.js` |
| `app/index.js`, `app/new.js`, `app/deploys/[d_id].js` | `DeployListPage.jsx`, `DeployForm.jsx`, `DeployDetailPage.jsx` |
| `StatusBadge`, `StepProgress`, `LogTerminal`, `IssueHistory` | 웹의 같은 이름 `.jsx` (`features/deploys/ui/`) |
| `AdvicePanel`, `EnvVarsCard`, `EnvRow` | `features/advice/ui/AdvicePanel.jsx`, `features/envvars/ui/EnvVarsCard.jsx` |
| `app/accounts.js`, `components/accounts/*` (`AwsBox`, `GithubBox`, `AwsGuide`, `AwsUpdateGuide`, `BlockCard`) | `features/accounts/ui/AccountsPage.jsx`, `AccountBox.jsx`, `AwsStackGuide.jsx`, `AwsStackUpdateGuide.jsx` |
| `src/accounts/constants.js` (상태 라벨, 확인 문구), `notices.js`, `pickedBlock.js` | `features/accounts/ui/` 의 같은 문구, `pickedBlock.js` |
| `src/api.js` 의 `accountApi` | `features/accounts/ui/api.js` |

상태 값은 `CLAUDE.md` 의 "Status values" 와 같아야 한다 (바꾸면 모델 주석, `pipeline.py`, 웹 `constants.js`, 앱 `src/constants.js`).

## 플랫폼별로 다르게 한 것

- 로그는 `FlatList` 가 아니라 `ScrollView` 다 (페이지 스크롤 안에 `FlatList` 를 넣으면 RN 이 중첩 경고를 내고 웹에서는 자체 스크롤이 사라졌다). 최대 500줄만 들고 있다.
- 확인 창(멈춤·삭제)은 앱에서 `Alert.alert`, 웹에서 브라우저 `confirm`(없으면 취소로 본다). 안전한 쪽(`그대로 두기`)이 먼저다.
- 키보드: 상세·새 배포 화면은 스크롤 되는 폼이고 `automaticallyAdjustKeyboardInsets`(iOS)를 쓴다. 안드로이드는 스크롤을 `KeyboardAvoidingView`(`behavior="height"`)로 감쌌다 (SDK 58 은 화면 끝까지 그려서 기본 화면 줄이기가 안 먹을 수 있다). **안드로이드 키보드 처리는 구현만 했고 기기에서는 확인하지 못했다.** 헤더 높이만큼의 `keyboardVerticalOffset` 은 주지 않았다 (0).
- 아래 여백: 목록·새 배포·상세 화면의 스크롤 끝에 `react-native-safe-area-context` 의 하단 안전 영역(`insets.bottom`)을 더한다.
- 고정폭 글꼴: 모든 곳이 `theme.js` 의 `monoFont`(iOS `Menlo`, 나머지 `monospace`)를 쓴다 (환경변수 카드, 로그, 해설 원문, Dockerfile 상자, 분석 패널의 앱 폴더). 기기에서의 글꼴 모양은 확인하지 못했다.
- 웹 전용 줄바꿈 `wrapAnywhere` (긴 이름이 가로로 넘치지 않게). 앱에서는 아무 효과가 없다.
- 폴링은 `usePolling` 이 하고, 앱이 백그라운드면 멈췄다가 돌아오면 한 번 바로 부른다. 더 부를 필요가 없으면 `STOP_POLLING` 을 돌려준다.
- 주소 복사는 `expo-clipboard`, 주소 열기는 `Linking` 이다.
- 계정 연결 화면 (C2):
  - 블록은 웹처럼 한 장씩 넘기지 않고 세로 카드 목록이다 (카드마다 `선택`). 웹의 화살표로 계정을 넘겨 보는 부분은 `이미 연결한 계정에서 고르기` 버튼(목록에서 하나 고르면 `PATCH /connections/{c_id}`)으로 바꿨다.
  - GitHub·AWS 에서 앱으로 되돌아오는 딥링크는 없다. `계정 추가` 로 설치 주소를 열고 안내 문구를 보여 준 뒤, 앱이 다시 앞으로 올 때(`AppState`) 목록을 한 번 다시 읽는다. 새 설치가 이 블록에 이어져 있으면 `연결 확인` 을 한 번 자동으로 부른다. 돌아왔는데도 설치가 없으면 `아직 설치가 확인되지 않았습니다 ...` 안내를 보이고(앱 전용, 복귀마다 한 번) 기다림은 그대로 둔다. 서버의 GitHub 앱 콜백 주소를 폰에서 열 수 없으면 설치가 저장되지 않는다 (위 "준비").
  - 바깥 링크(콘솔 열기, GitHub 설치)는 `https://` 로 시작할 때만 연다. 아니면 `주소를 열 수 없습니다`. 템플릿 내려받기만 서버가 준 상대 경로를 API 주소에 붙여 연다.
  - ExternalId 는 `계정 추가` 응답에서만 오고, 안내 창이 열려 있는 동안만 화면 상태에 있다. 주소·경로 인자·저장소·로그·오류 문장·접근성 라벨에 넣지 않고, 창이 닫히면 지운다 (복사 버튼 라벨은 `<계정 이름> ExternalId 복사`).
  - 고른 블록은 `AsyncStorage` 에 번호(`c_id`)만 저장한다. 읽기에 실패하면 없는 것으로 본다.
  - 안내 창은 RN `Modal` 이다. 맨 위 오른쪽에 `닫기` 가 있고 `나중에` 와 같다. 안드로이드(edge-to-edge)와 iOS 에서는 제목 줄이 상태 표시줄 밑으로 들어가지 않게 위쪽 안전 영역만큼 띄운다. 오류·알림은 화면 맨 위에 보이도록 스크롤을 올린다 (창 안의 오류는 창 안에 둔다).
- 환경변수 값은 쓰기 전용이다: 저장에 성공하면 입력을 비우고, 로그·주소·오류 문장에 넣지 않는다. `database` `cache` `external_api` `secret` 종류에는 값 입력 칸이 없다 (서버가 501).

## 확인한 것과 못 한 것

- 확인함 (2026-11-09):
  - (C1) `npx jest` 11 파일 229 테스트 통과 (API 클라이언트, 상수, 환경변수 묶음, 테마, 폴링 훅, 목록·새 배포·상세 화면, 분석 패널, 진행·로그·해설 조각, 환경변수 카드).
  - `npx expo export --platform web` 빌드 성공.
  - 웹 번들을 Playwright(390×844, 라이트·다크)로 열어 `/api/**` 를 모의하고 목록(`환경변수 2개 입력 필요`) → 새 배포 → 분석 → `이 레포로 배포` → 상세 `needs_input` → 값 저장·건너뛰기 → `이어서 배포`(처음 409, 다음 200)를 한 번 돌렸다. 가로 스크롤 없음(`scrollWidth` 390 = `innerWidth` 390). 마지막 라이트·다크 두 번의 실행에서 콘솔에 남은 것은 의도한 모의 409 뿐이었다 (내가 모의 라우트를 푼 뒤 생긴 연결 거부 로그는 뺐다). 웹 렌더링(react-native-web)은 실제 앱 동작의 대용품일 뿐이다.
- 확인함 - 계정 연결 (C2, 2026-11-09):
  - `npx jest` 20 파일 535 테스트 통과 (계정 연결 화면·상자·안내 창·`useOnForeground`·`/new` 기본 블록과 돌아왔을 때 다시 읽기·목록 갱신). 마지막 검토 뒤 수정(안내 창 위 여백, 콜백 안내, `/new` 다시 읽기, 고르기 창 닫는 순서, 저장된 선택 지우기 등) 포함.
  - `npx expo export --platform web` 빌드 성공.
  - 웹 번들을 Playwright(390×844, 다크 한 번, 라이트 한 번)로 열어 `/api/**` 를 모의하고 목록 → `계정 연결` → 빈 상태 → `＋ 블록 추가`(2개) → AWS `계정 추가` → 안내(복사 버튼, 콘솔 열기는 `https://` 만) → 역할 ARN → 확인됨 → GitHub `계정 추가`(`window.open` 대체) → 앱이 다시 앞으로 온 것을 흉내(`visibilitychange`) → 연결 확인 알림 → 목록 → `＋ 새 배포` 에서 고른 블록이 미리 골라지고 레포 목록 요청이 그 블록의 GitHub 번호로 가는 것까지 한 번 돌렸다. 가로 스크롤 없음(`scrollWidth` 390 = `innerWidth` 390, 모든 화면), 44 미만 터치 대상은 헤더 뒤로 가기(30)뿐, 콘솔 오류·페이지 오류 0, ExternalId 는 어느 요청 주소·본문·화면에도 없었다(안내 창이 닫힌 뒤 DOM 검사). 이 모의 확인은 실제 앱 동작의 대용품일 뿐이다.
- 확인함 - 인시던트·알림·설정 (D2, 2026-11-10):
  - `npx jest` 31 파일 965 테스트 통과 (API 클라이언트 `incidentApi`·`healthApi`·`notificationApi`·`deviceApi`, 링크 검사 `parseAppLink`, 안 읽은 수 훅, 인시던트 화면·헬스 막대·타임라인·카드·배너, 배포 설정, 알림 목록·종 배지, 푸시 상태·등록·해제, 알림 탭 경로, 알림 설정, 루트 레이아웃). `expo-notifications`·`fetch`·`AppState` 는 모두 목이다.
  - `npx expo export --platform web` 빌드 성공.
  - 웹 번들을 Playwright(390×844, 다크 한 번, 라이트 한 번)로 열어 `/api/**` 를 모의하고 한 번에 돌렸다: 목록(문제 배너 `자동 복구 중`, 종 배지 3, `계정 연결`·`알림 설정` 칩) → 인시던트 상세 `복구 중`(타임라인, 헬스 막대 `최근 24시간 정상 90%`, 다음 호출에서 모의 값이 `resolved` 가 되어 `해결됨` 으로 바뀌고 그 뒤 11초 동안 추가 호출 0) → `확인이 필요합니다` 배너 → `needs_action` 상세(버튼 3개, `멈춤` 확인 창에서 취소하면 `POST /stop` 0번) → 배포 상세 `설정` → 스위치(PATCH 본문이 바꾼 항목 하나뿐: `{"auto_redeploy":true}`) → 알림 목록(안 읽은 것 굵게 700, 읽은 것 400, 누르면 `POST /notifications/303/read` 1번과 `/incidents/5` 이동, `모두 읽음` 1번, 목록으로 돌아오면 배지 사라짐) → `알림 설정`(푸시 줄에 "알림을 지원하지 않는 기기" 안내, `알림 켜기` 버튼 없음, 종류 스위치 PATCH 본문 = 남은 5개 종류 전체 배열) → 목록. 모든 화면에서 `scrollWidth` 390 = `innerWidth` 390, 44 미만 터치 대상은 헤더 뒤로 가기(30×30)뿐, 콘솔 경고·오류·페이지 오류 0, 모의하지 않은 요청 0. 이 확인은 실제 앱 동작의 대용품일 뿐이다.
- 확인 못 함:
  - **인시던트·알림·설정 화면과 푸시는 실제 iOS / 안드로이드 기기·에뮬레이터, 실제 백엔드(실제 헬스 감시·인시던트·알림 데이터), 실제 AWS, 실제 푸시 발송과 알림 탭, 실제 OS 권한 창으로 한 번도 돌려 보지 못했다.** 모의 값이 `resolved` 로 바뀌는 순서는 흉내일 뿐 서버가 실제로 인시던트를 닫는 흐름이 아니다. EAS 프로젝트 id 가 없어서 지금 빌드는 어디서든 푸시 상태가 `no_project`(웹은 `unsupported`)다.
  - **계정 연결 화면은 실제 iOS / 안드로이드 기기·에뮬레이터, 실제 백엔드, 실제 AWS(CloudFormation 스택 만들기, AssumeRole), 실제 GitHub App 설치로 한 번도 돌려 보지 못했다.** 외부 브라우저 열기와 돌아왔을 때의 `AppState` 순서(iOS `inactive`/`background`), 실제 `Linking`·`expo-clipboard`, `Modal` 안의 키보드 가림과 안전 영역은 기기에서 안 봤다. 아래로 당겨 새로고침은 react-native-web 에서 동작하지 않아 jest 로만 확인했다.
  - **실제 iOS / 안드로이드 기기와 에뮬레이터에서의 실행은 한 번도 하지 못했다.** 키보드 가림, 확인 창, 클립보드, 링크 열기, 접근성 초점 이동, 글꼴은 기기에서 안 봤다.
  - 실제 백엔드·실제 AWS 와 붙인 실행. 모든 서버 응답은 모의였다.
  - 웹 측정에서 상단 바의 뒤로 가기 버튼이 30×30 으로 나왔다 (내비게이션 라이브러리 기본 헤더). 기기에서의 터치 영역은 확인하지 못했다.

## 알려진 빈틈 (고치지 않음)

인시던트·알림·설정 (D2):
- `IssueHistory`(배포 상세의 문제 이력)가 서버가 시간대 없이 보내는 UTC 시각을 현지 시각으로 바꾸지 않아 한국에서 9시간 어긋나 보인다 (웹도 같다). 고쳐야 한다. 새 화면(`ops/format.js` 의 `toMs`)은 UTC 로 읽는다.
- 알림 항목의 아이콘 뒤 `U+FE0E`(텍스트형 표시) 처리와 그 이스케이프는 기기에서 안 봤다.
- 목록 머리줄 테스트에 같은 헤더가 두 번 그려지는 구간이 있다 (테스트 목 한정).
- 배포 설정에서 성공 안내(`저장했습니다`, 3초 뒤 사라짐)의 타이머가 그 사이에 난 뒤 오류 문구를 지울 수 있다.
- 배포 설정을 바꿔도 이미 열려 있는 배포 상세 화면은 그 값을 다시 읽지 않는다.
- 배포 상세의 `설정` 버튼이 `deleting` 상태에서도 보인다.
- 저장된 `p_d_id`(푸시 기기 번호)는 서버 DB 를 비우고 번호가 다시 쓰이면 다른 기기를 가리킬 수 있다.
- `app/notification-settings.js` 가 261줄이다.

계정 연결 (C2):
- `계정 추가` 요청이 서버에서는 끝났는데 앱의 15초 제한이 먼저 끝나면 ExternalId 를 받지 못한다. 새 계정은 `역할 등록 대기` 로 남고 `역할 ARN 입력` 의 이어서 하기 안내(ExternalId 를 다시 볼 수 없다는 설명)로 이어 갈 수 있다.
- 템플릿 내려받기 링크는 API 주소가 폰에서 닿는 LAN 주소일 때만 폰에서 열린다 (위 "준비").
- 어느 블록도 쓰지 않는 AWS 계정은 그 계정을 한 블록에 `고르기` 한 뒤에야 `연결 해제` 할 수 있다 (웹은 화살표로 넘겨 보다가 바로 해제).
- `Modal` 안의 키보드·안전 영역 처리는 기기에서 확인하지 못했다. `AwsBox.js` 가 약 300줄이다.

C1:

- 안드로이드 키보드 처리(`KeyboardAvoidingView`)는 기기에서 확인하지 못했다. `keyboardVerticalOffset` 이 필요한지도 모른다.
- 테스트 빈틈: 환경변수 카드의 같은 순간 두 번 누름·저장 중 화면 닫힘, 삭제 확인 후 이동(`dismissTo`/`replace`)은 jest 와 웹 번들로만 확인했다.
