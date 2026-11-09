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
서버는 인증이 없는 로컬 전용이다 (1단계). 밖에 열지 않는다.

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
src/components/   화면 조각 (StatusBadge, AdvicePanel, ConnectionPicker)
src/hooks/        usePolling (주기 호출, 백그라운드에서는 멈춤)
```

## 확인한 것과 못 한 것

- 확인함: `npx jest` (API 클라이언트, 상수, 환경변수 묶음, 테마, 폴링 훅, 배포 목록 화면, 새 배포 화면과 분석 패널), `npx expo export --platform web`
- 확인 못 함: 실제 iOS / 안드로이드 기기와 에뮬레이터에서의 실행. 이 PC 에서는 돌려 보지 못했다.
