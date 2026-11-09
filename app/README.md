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

계정 연결 화면의 템플릿 내려받기 링크(`/api/accounts/aws/template`)는 서버가 준 상대 경로에 이 주소를 붙여 연다. 그래서 `localhost` 로 빌드한 앱은 실제 폰에서 이 링크를 열 수 없다. 폰에서 쓰려면 위 표의 LAN 주소로 빌드해야 한다. GitHub 설치를 마친 뒤 GitHub 이 보내는 콜백 페이지(서버가 `?connected=github` 로 돌려보내는 곳)도 서버 설정의 주소가 폰에서 닿아야 보인다. 앱은 그 페이지를 쓰지 않고, 앱으로 돌아오면 목록을 다시 읽는다 (아래 "플랫폼별로 다르게 한 것").

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
src/hooks/        usePolling (주기 호출, 백그라운드에서는 멈춤, STOP_POLLING 으로 중단), useOnForeground (앱이 다시 앞으로 올 때 한 번 부름)
```

## 화면 (C1·C2, 2026-11-09)

| 경로 | 화면 | 웹에서 같은 화면 |
|---|---|---|
| `/` | 배포 목록 (진행 중 3초, 아니면 15초마다 갱신) | `/` 의 목록 |
| `/new` | 새 배포: 주소 입력 → `분석` → 결과 패널 → `이 레포로 배포` | `/` 의 새 배포 폼 + 분석 패널 (S-20) |
| `/deploys/[d_id]` | 배포 상세: 진행 단계, 주소, 로그, 해설, 이력, 다시 배포·멈춤·다시 켜기·삭제, 환경변수 카드 (S-19) | `/deploys/:d_id` |
| `/accounts` | 계정 연결 (C2): 블록 카드 목록(추가·삭제·`선택`), 블록마다 AWS 상자(7단계 안내, 역할 ARN, 연결 확인, 스택 업데이트 안내, 템플릿 파일 삭제, 연결 해제, 기존 계정 고르기)와 GitHub 상자(설치 열기, 돌아오면 확인, 연결 해제, 기존 계정 고르기). 아래로 당겨 새로고침 | `/accounts` (M6, B-01~B-07) |

목록 상단에 `계정 연결` 버튼이 있고, 목록은 화면에 다시 올 때마다 새로 읽는다. `/new` 는 `계정 연결` 에서 `선택`한 블록(없으면 쓸 수 있는 블록이 하나뿐일 때 그것)을 미리 고르고, 연결이 하나도 없으면 `계정 연결 열기` 안내를 보여 준다.

없는 것: 알림(푸시), 장애 이력 화면, 로그인, 설정, 스토어 빌드(EAS), GitHub·AWS 에서 앱으로 돌아오는 딥링크, 웹의 "PC에서 이어서 하기" 같은 링크. 앱 이름과 번들 ID(`app.json`)는 임시값이다.

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
  - GitHub·AWS 에서 앱으로 되돌아오는 딥링크는 없다. `계정 추가` 로 설치 주소를 열고 안내 문구를 보여 준 뒤, 앱이 다시 앞으로 올 때(`AppState`) 목록을 한 번 다시 읽는다. 새 설치가 이 블록에 이어져 있으면 `연결 확인` 을 한 번 자동으로 부른다.
  - 바깥 링크(콘솔 열기, GitHub 설치)는 `https://` 로 시작할 때만 연다. 아니면 `주소를 열 수 없습니다`. 템플릿 내려받기만 서버가 준 상대 경로를 API 주소에 붙여 연다.
  - ExternalId 는 `계정 추가` 응답에서만 오고, 안내 창이 열려 있는 동안만 화면 상태에 있다. 주소·경로 인자·저장소·로그·오류 문장·접근성 라벨에 넣지 않고, 창이 닫히면 지운다 (복사 버튼 라벨은 `<블록> ExternalId 복사`).
  - 고른 블록은 `AsyncStorage` 에 번호(`c_id`)만 저장한다. 읽기에 실패하면 없는 것으로 본다.
  - 안내 창은 RN `Modal` 이다. 맨 위 오른쪽에 `닫기` 가 있고 `나중에` 와 같다. 오류·알림은 화면 맨 위에 보이도록 스크롤을 올린다 (창 안의 오류는 창 안에 둔다).
- 환경변수 값은 쓰기 전용이다: 저장에 성공하면 입력을 비우고, 로그·주소·오류 문장에 넣지 않는다. `database` `cache` `external_api` `secret` 종류에는 값 입력 칸이 없다 (서버가 501).

## 확인한 것과 못 한 것

- 확인함 (2026-11-09):
  - (C1) `npx jest` 11 파일 229 테스트 통과 (API 클라이언트, 상수, 환경변수 묶음, 테마, 폴링 훅, 목록·새 배포·상세 화면, 분석 패널, 진행·로그·해설 조각, 환경변수 카드).
  - `npx expo export --platform web` 빌드 성공.
  - 웹 번들을 Playwright(390×844, 라이트·다크)로 열어 `/api/**` 를 모의하고 목록(`환경변수 2개 입력 필요`) → 새 배포 → 분석 → `이 레포로 배포` → 상세 `needs_input` → 값 저장·건너뛰기 → `이어서 배포`(처음 409, 다음 200)를 한 번 돌렸다. 가로 스크롤 없음(`scrollWidth` 390 = `innerWidth` 390). 마지막 라이트·다크 두 번의 실행에서 콘솔에 남은 것은 의도한 모의 409 뿐이었다 (내가 모의 라우트를 푼 뒤 생긴 연결 거부 로그는 뺐다). 웹 렌더링(react-native-web)은 실제 앱 동작의 대용품일 뿐이다.
- 확인함 - 계정 연결 (C2, 2026-11-09):
  - `npx jest` 20 파일 490 테스트 통과 (계정 연결 화면·상자·안내 창·`useOnForeground`·`/new` 기본 블록·목록 갱신).
  - `npx expo export --platform web` 빌드 성공.
  - 웹 번들을 Playwright(390×844, 다크 한 번, 라이트 한 번)로 열어 `/api/**` 를 모의하고 목록 → `계정 연결` → 빈 상태 → `＋ 블록 추가`(2개) → AWS `계정 추가` → 안내(복사 버튼, 콘솔 열기는 `https://` 만) → 역할 ARN → 확인됨 → GitHub `계정 추가`(`window.open` 대체) → 앱이 다시 앞으로 온 것을 흉내(`visibilitychange`) → 연결 확인 알림 → 목록 → `＋ 새 배포` 에서 고른 블록이 미리 골라지고 레포 목록 요청이 그 블록의 GitHub 번호로 가는 것까지 한 번 돌렸다. 가로 스크롤 없음(`scrollWidth` 390 = `innerWidth` 390, 모든 화면), 44 미만 터치 대상은 헤더 뒤로 가기(30)뿐, 콘솔 오류·페이지 오류 0, ExternalId 는 어느 요청 주소·본문·화면에도 없었다(안내 창이 닫힌 뒤 DOM 검사). 이 모의 확인은 실제 앱 동작의 대용품일 뿐이다.
- 확인 못 함:
  - **계정 연결 화면은 실제 iOS / 안드로이드 기기·에뮬레이터, 실제 백엔드, 실제 AWS(CloudFormation 스택 만들기, AssumeRole), 실제 GitHub App 설치로 한 번도 돌려 보지 못했다.** 외부 브라우저 열기와 돌아왔을 때의 `AppState` 순서(iOS `inactive`/`background`), 실제 `Linking`·`expo-clipboard`, `Modal` 안의 키보드 가림과 안전 영역은 기기에서 안 봤다. 아래로 당겨 새로고침은 react-native-web 에서 동작하지 않아 jest 로만 확인했다.
  - **실제 iOS / 안드로이드 기기와 에뮬레이터에서의 실행은 한 번도 하지 못했다.** 키보드 가림, 확인 창, 클립보드, 링크 열기, 접근성 초점 이동, 글꼴은 기기에서 안 봤다.
  - 실제 백엔드·실제 AWS 와 붙인 실행. 모든 서버 응답은 모의였다.
  - 웹 측정에서 상단 바의 뒤로 가기 버튼이 30×30 으로 나왔다 (내비게이션 라이브러리 기본 헤더). 기기에서의 터치 영역은 확인하지 못했다.

## 알려진 빈틈 (고치지 않음)

계정 연결 (C2):
- `계정 추가` 요청이 서버에서는 끝났는데 앱의 15초 제한이 먼저 끝나면 ExternalId 를 받지 못한다. 새 계정은 `역할 등록 대기` 로 남고 `역할 ARN 입력` 의 이어서 하기 안내(ExternalId 를 다시 볼 수 없다는 설명)로 이어 갈 수 있다.
- 템플릿 내려받기 링크는 API 주소가 폰에서 닿는 LAN 주소일 때만 폰에서 열린다 (위 "준비").
- 어느 블록도 쓰지 않는 AWS 계정은 그 계정을 한 블록에 `고르기` 한 뒤에야 `연결 해제` 할 수 있다 (웹은 화살표로 넘겨 보다가 바로 해제).
- `Modal` 안의 키보드·안전 영역 처리는 기기에서 확인하지 못했다. `AwsBox.js` 가 약 300줄이다.
- `/new` 가 `계정 연결` 에서 돌아왔을 때 연결 목록을 다시 읽지 않아 `계정 연결 열기` 안내가 남을 수 있다 (화면을 새로 열면 사라진다).
- 블록을 지워도 저장된 고른 번호는 남는다. 읽을 때 없는 블록이면 무시한다.

C1:

- 안드로이드 키보드 처리(`KeyboardAvoidingView`)는 기기에서 확인하지 못했다. `keyboardVerticalOffset` 이 필요한지도 모른다.
- 테스트 빈틈: 환경변수 카드의 같은 순간 두 번 누름·저장 중 화면 닫힘, 삭제 확인 후 이동(`dismissTo`/`replace`)은 jest 와 웹 번들로만 확인했다.
