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
src/components/   화면 조각 (StatusBadge, AdvicePanel, ConnectionPicker, StepProgress, LogTerminal, ExplainCard, IssueHistory, EndpointCard, EnvVarsCard, EnvRow, ui)
src/confirm.js    확인 창 (앱은 Alert, 웹은 브라우저 confirm)
src/hooks/        usePolling (주기 호출, 백그라운드에서는 멈춤, STOP_POLLING 으로 중단)
```

## 화면 (C1, 2026-11-09)

| 경로 | 화면 | 웹에서 같은 화면 |
|---|---|---|
| `/` | 배포 목록 (진행 중 3초, 아니면 15초마다 갱신) | `/` 의 목록 |
| `/new` | 새 배포: 주소 입력 → `분석` → 결과 패널 → `이 레포로 배포` | `/` 의 새 배포 폼 + 분석 패널 (S-20) |
| `/deploys/[d_id]` | 배포 상세: 진행 단계, 주소, 로그, 해설, 이력, 다시 배포·멈춤·다시 켜기·삭제, 환경변수 카드 (S-19) | `/deploys/:d_id` |

C1 에는 연결 관리(AWS 계정·GitHub 연결 만들기), 알림(푸시), 장애 이력 화면, 로그인, 설정, 스토어 빌드(EAS)가 없다. 앱 이름과 번들 ID(`app.json`)는 임시값이다.

## 웹과 겹치는 파일

문구와 상수는 웹 파일을 보고 옮겨 적은 것이라, 한쪽을 바꾸면 반대쪽도 같이 바꿔야 한다 (앱은 `app/` 밖의 파일을 가져오지 않는다).

| 앱 | 웹 |
|---|---|
| `src/api.js` | `features/deploys/ui/api.js`, `features/envvars/ui/api.js`, `features/advice/ui/api.js` |
| `src/constants.js` (상태 이름·진행 단계·`needs_input`·환경변수 종류·분석 라벨) | `features/deploys/ui/constants.js`, `features/envvars/ui/constants.js`, `features/advice/ui/constants.js` |
| `app/index.js`, `app/new.js`, `app/deploys/[d_id].js` | `DeployListPage.jsx`, `DeployForm.jsx`, `DeployDetailPage.jsx` |
| `StatusBadge`, `StepProgress`, `LogTerminal`, `IssueHistory` | 웹의 같은 이름 `.jsx` (`features/deploys/ui/`) |
| `AdvicePanel`, `EnvVarsCard`, `EnvRow` | `features/advice/ui/AdvicePanel.jsx`, `features/envvars/ui/EnvVarsCard.jsx` |

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
- 환경변수 값은 쓰기 전용이다: 저장에 성공하면 입력을 비우고, 로그·주소·오류 문장에 넣지 않는다. `database` `cache` `external_api` `secret` 종류에는 값 입력 칸이 없다 (서버가 501).

## 확인한 것과 못 한 것

- 확인함 (2026-11-09):
  - `npx jest` 11 파일 229 테스트 통과 (API 클라이언트, 상수, 환경변수 묶음, 테마, 폴링 훅, 목록·새 배포·상세 화면, 분석 패널, 진행·로그·해설 조각, 환경변수 카드).
  - `npx expo export --platform web` 빌드 성공.
  - 웹 번들을 Playwright(390×844, 라이트·다크)로 열어 `/api/**` 를 모의하고 목록(`환경변수 2개 입력 필요`) → 새 배포 → 분석 → `이 레포로 배포` → 상세 `needs_input` → 값 저장·건너뛰기 → `이어서 배포`(처음 409, 다음 200)를 한 번 돌렸다. 가로 스크롤 없음(`scrollWidth` 390 = `innerWidth` 390). 마지막 라이트·다크 두 번의 실행에서 콘솔에 남은 것은 의도한 모의 409 뿐이었다 (내가 모의 라우트를 푼 뒤 생긴 연결 거부 로그는 뺐다). 웹 렌더링(react-native-web)은 실제 앱 동작의 대용품일 뿐이다.
- 확인 못 함:
  - **실제 iOS / 안드로이드 기기와 에뮬레이터에서의 실행은 한 번도 하지 못했다.** 키보드 가림, 확인 창, 클립보드, 링크 열기, 접근성 초점 이동, 글꼴은 기기에서 안 봤다.
  - 실제 백엔드·실제 AWS 와 붙인 실행. 모든 서버 응답은 모의였다.
  - 웹 측정에서 상단 바의 뒤로 가기 버튼이 30×30 으로 나왔다 (내비게이션 라이브러리 기본 헤더). 기기에서의 터치 영역은 확인하지 못했다.

## 알려진 빈틈 (고치지 않음)

- 안드로이드 키보드 처리(`KeyboardAvoidingView`)는 기기에서 확인하지 못했다. `keyboardVerticalOffset` 이 필요한지도 모른다.
- 테스트 빈틈: 환경변수 카드의 같은 순간 두 번 누름·저장 중 화면 닫힘, 삭제 확인 후 이동(`dismissTo`/`replace`)은 jest 와 웹 번들로만 확인했다.
