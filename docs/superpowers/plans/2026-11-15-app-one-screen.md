# 앱 한 화면 레이아웃 (계획 F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 내용이 정해진 앱 화면 3개(배포 설정, 알림 설정, 인시던트 상세)가 스크롤·슬라이드 없이 한 화면에 다 보이게 한다. 목록·로그처럼 길어지는 것은 자기 상자 안에서만 스크롤한다.

**Architecture:** 공통 화면 틀 `FitScreen`(화면 높이를 채우는 `ScrollView`, 안전망)과 저장 안내 자리 `FooterSlot`을 만든다. 세 화면을 이 틀 위에서 다시 배치한다: 설정 화면은 압축한 줄·2열 타일로, 인시던트 상세는 "위 고정(요약) · 가운데 상자(원인·타임라인, 넘칠 때만 상자 안 스크롤) · 아래 고정(헬스 막대·버튼)"으로. 서버·API·문구·동작은 바꾸지 않는다 (배치와 접기만).

**Tech Stack:** Expo SDK 58, expo-router, React Native 0.88.1 (react-native-web 로 웹 번들 측정), jest-expo + @testing-library/react-native. 새 의존성 없음.

**Spec:** 오너 요청 2026-11-15 "앱화면의 경우 슬라이드가 필요없도록 한 화면에 다 나오도록" + 답변 "내용이 정해진 화면만 한 화면에 (추천)". 그리고 `docs/conventions.md` 의 "글이 잘리거나 숨겨지지 않게" 규칙. 별도 설계 문서는 없다 (이 계획서의 "Decisions" 가 설계다).

## Decisions (이 계획이 정한 것 — 구현자는 다시 정하지 않는다)

1. **한 화면에 맞추는 화면 (고정 내용):** `/deploy-settings/[d_id]`, `/notification-settings`, `/incidents/[i_id]`. **그대로 스크롤:** 목록(`/`, `/notifications`), 배포 상세(로그·환경변수), 새 배포(분석 결과 패널), 계정 연결(7단계 안내). 이유: 내용 길이가 데이터에 따라 정해진다.
2. **"맞춘다"의 기준:** 웹 번들(react-native-web)로 재서 `FitScreen` 의 `scrollHeight ≤ clientHeight`. 기준 화면은 **390×844** 와 **360×740**. 390×844 는 아래 "측정 상태" 전부에서 맞아야 한다. 360×740 은 푸시 안내 상자가 없는 기본 상태에서 맞아야 하고, 푸시 안내 상자가 떠 있는 상태는 맞지 않아도 된다(안전망 스크롤로 전부 보임). 못 맞춘 칸은 숫자 그대로 보고한다 — 맞았다고 쓰지 않는다.
3. **안전망:** 화면 틀은 항상 `ScrollView` 다. 내용이 화면보다 작으면 스크롤되지 않고, 큰 글꼴·작은 화면에서 넘칠 때만 스크롤된다. 그래서 어떤 경우에도 잘리지 않는다 (conventions 규칙 유지).
4. **접기는 이것만:** 알림 종류 6개의 설명(`KIND_HINT`)은 처음엔 접혀 있고 `설명 보기` 로 펼친다. 설명은 스크린리더용 `accessibilityHint` 로는 항상 읽힌다. 다른 문구는 접지 않는다. (`docs/conventions.md` 에 "누르면 펼치는 설명" 예외로 한 줄 적는다 — Task 5.)
5. **저장·오류 안내 자리:** 설정 두 화면은 안내를 위쪽이 아니라 **맨 아래 `FooterSlot`** 에 둔다 (평소엔 "변경은 누르는 즉시 저장됩니다…" 글, 안내가 있으면 그 자리를 안내가 대신한다). 높이가 변하지 않아 내용이 밀려나지 않는다. 안내가 뜨면 `scrollToEnd` (넘칠 때만 의미가 있다). 이전의 `scrollTo({y:0})` 는 없앤다.
6. **인시던트 상세의 안내(성공·실패·갱신 오류):** 맨 아래 버튼 위에 쌓는다. 가운데 상자가 `flex:1` 이라 안내가 생기면 상자가 줄어들 뿐 화면은 넘치지 않는다.
7. **끌어당겨 새로고침:** 인시던트 상세는 유지한다 (`FitScreen` 의 `refreshControl`).
8. **가로 방향·태블릿·접근성 글꼴 2배 이상은 이 계획 밖이다.** 글꼴이 커져 넘치면 안전망 스크롤이 받는다 (Decision 3).

## Global Constraints

- 사용자에게 보이는 글·주석은 한국어, 식별자는 영어. 함수 위에 한 줄 한국어 주석, docstring 없음. 기존 `=` 간격 유지, 일괄 정리 금지 (`CLAUDE.md`).
- 색은 `useColors()` 토큰만, 간격은 `spacing`. 색 하드코딩 금지 (`docs/conventions.md`).
- 터치 대상은 44pt 이상 (앱 규칙).
- 내용을 가리는 속성 금지: `numberOfLines`, `ellipsizeMode`, `overflow: 'hidden'` 으로 글 가리기 없음. 스크롤 상자는 허용.
- 서버 필드·문구·상태 값·접근성 역할/이름은 그대로 (`switch`, `button`, `alert`, `header`, 기존 `accessibilityLabel`).
- 네트워크·`api.js`·`src/ops/*` 로직은 건드리지 않는다.
- `app/` 는 독립 패키지: `app/` 밖 파일을 가져오지 않는다.
- 브랜치 `feat/app-one-screen` (`test` 에서 분기). push 와 `main` 은 오너 확인 전에는 하지 않는다.
- 테스트 러너는 한 번에 하나만 돌린다 (`cd app && npx jest <파일>`; 전체 `npx jest`). 이 PC 는 CPU 를 다른 작업과 나눠 쓴다.
- 기존 테스트 992개는 의미가 바뀌는 곳만 고치고, 고친 테스트와 이유를 보고서에 적는다.

## Review Focus

1. **긴 글이 한 덩어리로 올 때** (`fix_where` 90자 ARN, 공백 없는 긴 원인, 서버가 준 긴 오류 문장): 줄바꿈되고, 가운데 상자 안에서만 스크롤되며, 아래 버튼은 계속 화면에 보이고 눌린다 (Task 3).
2. **안내가 뜰 때 화면이 밀리는지** (저장 성공·오류, 인시던트 동작 실패): 내용이 화면 밖으로 밀려 나가지 않고, 긴 오류도 끝까지 보인다 (Task 1·2·3).
3. **불러오는 중 · 불러오기 실패 · 404 상태:** 새 틀 안에서도 스피너가 가운데, `다시 시도`/`돌아가기` 가 보이고 눌린다 (Task 1·2·3).
4. **다크 모드와 44pt:** 새 2열 타일·`설명 보기` 버튼이 라이트·다크에서 읽히고 터치 높이가 44pt 이상 (Task 2, 측정은 Task 4).
5. **인시던트 `needs_action` → 동작 뒤:** 버튼 줄이 `배포 보기` 한 개로 바뀌어도 레이아웃이 깨지거나 가운데 상자가 사라지지 않는다 (Task 3).

---

## Task 1: 공통 틀 `FitScreen` · `FooterSlot` + 배포 설정 화면

**Files:**
- Create: `app/src/components/FitScreen.js`, `app/src/components/FooterSlot.js`
- Modify: `app/app/deploy-settings/[d_id].js`
- Test: Create `app/src/__tests__/FitScreen.test.js`; Modify `app/src/__tests__/DeploySettings.test.js` (필요한 곳만)

**Interfaces:**
- Produces:
  - `FitScreen({ children, testID, scrollRef, refreshControl })` — default export. 안쪽에서 `useColors()`·`useSafeAreaInsets()` 를 쓴다. `ScrollView` 의 `style` 은 `{ backgroundColor: colors.bg }`, `contentContainerStyle` 은 `{ flexGrow: 1, padding: spacing.lg, paddingBottom: spacing.lg + insets.bottom, gap: spacing.md }`. `alwaysBounceVertical={!!refreshControl}`. `testID`·`ref`·`refreshControl` 을 그대로 `ScrollView` 에 넘긴다.
  - `FooterSlot({ message, note })` — default export. `message` 는 `{ tone: 'info'|'err'|'warn', text }` 또는 없음, `note` 는 문자열. 없을 때 `note` 를 `muted` 글(13/19)로, `message` 가 있으면 `Notice` (같은 `tone`) 가 그 자리를 대신한다. 바깥 `View` 는 `minHeight: 52`.
- Consumes: `Notice`(`app/src/components/ui.js`), `spacing`/`useColors`(`app/src/theme.js`).

- [ ] **Step 1: 실패하는 테스트** — `FitScreen.test.js`:
  - `FitScreen 은 자식과 testID 를 그리고 contentContainerStyle 이 flexGrow 1 이다` — `getByTestId('fit')` 의 `props.contentContainerStyle` 을 `StyleSheet.flatten` 해 `flexGrow === 1`, `paddingBottom >= spacing.lg`.
  - `scrollRef 로 ScrollView 를 잡을 수 있다` — `ref.current` 가 null 이 아님.
  - `refreshControl 을 넘기면 그대로 전달되고 alwaysBounceVertical 이 켜진다 / 안 넘기면 꺼진다`.
  - `FooterSlot 은 message 가 없으면 note 글을 보이고, 있으면 note 대신 message(역할 alert)를 보인다` — 둘이 동시에 보이지 않음. `tone` 이 `err` 면 `alert` 역할의 글에 오류 문장이 그대로 들어 있다 (잘라내지 않음).
- [ ] **Step 2: 실패 확인** — `cd app && npx jest src/__tests__/FitScreen.test.js` → 파일이 없어 FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces 대로 `FitScreen.js`, `FooterSlot.js`.
- [ ] **Step 4: 배포 설정 화면에 적용** — `app/app/deploy-settings/[d_id].js`: `ScrollView`/`useSafeAreaInsets` 를 `FitScreen` 으로 바꾸고(`testID="settings-scroll"`, `scrollRef` 유지), 맨 위 `Notice` 와 맨 아래 `note` 글을 `FooterSlot({ message, note: '변경은 누르는 즉시 저장됩니다. 이미 진행 중인 배포에는 영향이 없습니다.' })` 하나로 바꾼다. 안내가 생기면 `scrollRef.current?.scrollToEnd?.({ animated: true })` (`scrollTo({y:0})` 효과는 지운다). 불러오는 중 스피너·오류·404 몸통은 `flex: 1, justifyContent: 'center'` 로 가운데에 둔다 (스피너는 `marginTop` 대신). 문구·`SETTINGS`·`toggle` 로직은 그대로.
- [ ] **Step 5: 배포 설정 테스트 보강** — `DeploySettings.test.js` 에: `저장 성공 안내가 맨 아래 자리에 뜨고 3초 뒤 기본 글로 돌아온다`, `스위치가 실패하면 서버 오류 문장 전체가 alert 로 보이고 스위치는 되돌아간다`, `404 면 안내와 돌아가기만 보인다` (기존과 겹치면 기존 것을 고쳐 쓴다).
- [ ] **Step 6: 통과 확인** — `cd app && npx jest src/__tests__/FitScreen.test.js src/__tests__/DeploySettings.test.js` → 전부 PASS.
- [ ] **Step 7: 커밋** — `git add app && git commit -m "feat(app): 한 화면 틀(FitScreen·FooterSlot)과 배포 설정 화면"`

---

## Task 2: 알림 설정 화면 — 압축 줄 · 2열 타일 · 설명 접기

**Files:**
- Create: `app/src/components/SettingTile.js`, `app/src/components/ops/NotificationKinds.js`
- Modify: `app/src/components/SettingSwitch.js`, `app/app/notification-settings.js`
- Test: Create `app/src/__tests__/NotificationKinds.test.js`; Modify `app/src/__tests__/NotificationSettings.test.js`, `app/src/__tests__/` 중 `SettingSwitch` 를 확인하는 테스트(있으면)

**Interfaces:**
- Consumes (Task 1): `FitScreen`, `FooterSlot`.
- Produces:
  - `SettingSwitch` 에 선택 prop `compact` (기본 false). `compact` 면 `padding: spacing.md`, `minHeight: 44`, 설명 `fontSize: 12, lineHeight: 17, marginTop: 2`. 역할·라벨·힌트·상태 동작은 그대로.
  - `SettingTile({ title, value, busy, accessibilityLabel, accessibilityHint, onToggle })` — default export. 한 줄 `Pressable`(역할 `switch`, `accessibilityState={{ checked: value, busy: !!busy }}`, `aria-checked`, `aria-busy`), 왼쪽 `title`(14/20, 700, `flex:1, minWidth:0`) + 오른쪽 `Switch`(보기용, `pointerEvents="none"`, `aria-hidden`), `minHeight: 44`, `padding: spacing.md`, 표면색·테두리 `SettingSwitch` 와 같게.
  - `NotificationKinds({ kinds, busy, onToggle })` — default export. `kinds` 는 켜진 종류 배열, `busy` 는 불리언, `onToggle(kind)`. 구성: ① 머리줄 = 제목 `받을 알림`(`accessibilityRole="header"`) + 오른쪽 `Button`-형 토글 `설명 보기`/`설명 닫기`(`accessibilityRole="button"`, `accessibilityState={{ expanded }}`, 44pt) ② `NOTIFICATION_KINDS` 6개를 `flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm` 의 2열(각 타일 `flexBasis: '48%', flexGrow: 1`)로 `SettingTile`(`accessibilityLabel={`${라벨} 알림`}`, `accessibilityHint={KIND_HINT[kind]}`) ③ 펼쳤을 때만 6줄 설명 `라벨 — KIND_HINT[kind]`(muted 12/17) ④ 항상 보이는 글 `끈 종류는 앱 안 알림 목록에도 남지 않습니다`. 처음엔 접힌 상태.

- [ ] **Step 1: 실패하는 테스트** — `NotificationKinds.test.js`:
  - `6개 종류가 switch 로 그려지고 이름은 "<라벨> 알림" 이다` / `켜진 종류만 checked 다`.
  - `처음에는 설명 글이 안 보이고 accessibilityHint 로는 항상 있다` — `queryByText(KIND_HINT.incident_opened 가 들어간 줄)` 없음, `getByRole('switch', {name:'문제 감지 알림'})` 의 `accessibilityHint` 가 `KIND_HINT.incident_opened`.
  - `설명 보기 를 누르면 6줄 설명이 모두 보이고 버튼 글이 설명 닫기 로 바뀌며 expanded 가 true` / `다시 누르면 접힌다`.
  - `타일을 누르면 onToggle(kind) 를 한 번 부른다` / `busy 면 모든 타일이 busy 상태이고 누를 수 있는 동작은 부모의 잠금에 맡긴다`(타일 `accessibilityState.busy === true`).
  - `끈 종류는 앱 안 알림 목록에도 남지 않습니다` 글이 접힘/펼침 모두에서 보인다.
- [ ] **Step 2: 실패 확인** — `cd app && npx jest src/__tests__/NotificationKinds.test.js` → FAIL (파일 없음).
- [ ] **Step 3: 구현** — `SettingTile.js`, `NotificationKinds.js`, `SettingSwitch` 의 `compact`.
- [ ] **Step 4: 화면 다시 짜기** — `app/app/notification-settings.js`: `ScrollView` → `FitScreen`(`testID="settings-scroll"`, `scrollRef`). 본문 순서: `받는 방법`(머리글, 15/21로 줄임) → 메일 `SettingSwitch compact` → 푸시 `SettingSwitch compact` → `PUSH_SCOPE_HINT`(muted 12/17) → (필요하면) `PushPermissionGuide` → `NotificationKinds`(`kinds={values.kinds}`, `busy={!!busy.kinds}`, `onToggle={toggleKind}`) → `FooterSlot({ message, note: '변경은 누르는 즉시 저장됩니다.' })`. 위쪽 `Notice` 와 옛 `note` 두 줄은 없앤다(`끈 종류…` 글은 `NotificationKinds` 가 가진다). 메시지가 생기면 `scrollToEnd`. 로드·저장·푸시 로직(`save`, `enablePush` …)은 건드리지 않는다. 스피너·오류 몸통은 가운데 배치.
- [ ] **Step 5: 기존 화면 테스트 고치기** — `NotificationSettings.test.js`: 종류 설명 글을 화면 글로 찾던 곳은 `설명 보기` 를 먼저 눌러 찾도록 고치고, 이 변경 외 의미가 바뀐 테스트는 없어야 한다(있으면 보고). 새로 추가: `저장 성공 안내가 맨 아래 자리에 뜨고 기본 글을 대신한다`, `푸시 안내 상자가 떠 있어도 종류 스위치가 모두 있다`.
- [ ] **Step 6: 통과 확인** — `cd app && npx jest src/__tests__/NotificationKinds.test.js src/__tests__/NotificationSettings.test.js src/__tests__/DeploySettings.test.js src/__tests__/PushSetup.test.js` → 전부 PASS.
- [ ] **Step 7: 커밋** — `git commit -m "feat(app): 알림 설정을 한 화면에 - 압축 줄·2열 타일·설명 접기"`

---

## Task 3: 인시던트 상세 — 위 고정 · 가운데 상자 · 아래 고정

**Files:**
- Modify: `app/app/incidents/[i_id].js`, `app/src/components/ops/IncidentCard.js` (`IncidentExplain` 에 `flat`), `app/src/components/ops/IncidentTimeline.js`(상자 안 배치에 필요한 만큼만)
- Test: Modify `app/src/__tests__/IncidentDetail.test.js`, `app/src/__tests__/OpsComponents.test.js`

**Interfaces:**
- Consumes (Task 1): `FitScreen`.
- Produces:
  - `IncidentExplain({ explain, onError, flat })` — `flat` 이 참이면 세 구역(원인 · 고칠 곳 · 해야 할 일)을 `Card` 없이 한 `View` 안에서 구역 사이 얇은 줄(`colors.border`)로 나눠 그린다. 글·역할(`header`)·`고칠 곳 복사` 버튼·`selectable`·`wrapAnywhere` 는 그대로. `flat` 이 없으면 지금과 똑같이 카드 3장.
- 화면 구성(위에서 아래):
  1. 요약 카드(지금의 머리 카드 그대로: 요약·배지·메타·복구 중 안내).
  2. **가운데 상자** — `Card` 한 장, `flex: 1, minHeight: 160`, 안에 `ScrollView`(`testID="incident-body"`, `nestedScrollEnabled`)가 `IncidentExplain flat` + 구분선 + `IncidentTimeline` 을 담는다. 내용이 상자보다 작으면 스크롤되지 않는다.
  3. 헬스 막대 카드 (`checks !== undefined` 일 때만, 지금과 같음).
  4. **아래 고정 묶음:** 안내들(`error`·`actionError`·`notice` `Notice`) → 버튼. `needs_action && !acted` 면 `다시 배포`·`멈춤`·`그대로 두기` 를 **한 줄 3칸**(`flexDirection: 'row', gap: spacing.sm`, 각 `flex: 1`)에 두고 그 밑에 `아무것도 누르지 않으면…` 글. 아니면 `배포 보기` 한 개(전체 폭).
  - 404 / 불러오는 중 / 실패 몸통은 가운데 배치(Task 1 과 같은 방식). `FitScreen` 에 `refreshControl`(지금의 `RefreshControl`)과 `testID="incident-scroll"`, `scrollRef` 를 넘기고, 안내가 생길 때의 `scrollTo({y:0})` 효과는 지운다.
  - 폴링·헬스 이력·`perform`·`confirmStopDeploy` 로직은 건드리지 않는다.

- [ ] **Step 1: 실패하는 테스트** — `OpsComponents.test.js` 에 `IncidentExplain flat 은 Card 없이도 원인·고칠 곳·해야 할 일 글과 복사 버튼을 모두 그린다`(세 `header` 글이 보이고 `고칠 곳 복사` 가 눌린다), `flat 이 없으면 전과 같다`(기존 테스트가 이미 덮으면 그걸로 갈음).
  `IncidentDetail.test.js` 에: `가운데 상자(incident-body) 안에 원인·고칠 곳·해야 할 일·타임라인이 모두 있고 헬스 막대와 버튼은 상자 밖에 있다`(`within(getByTestId('incident-body'))` 로 확인), `needs_action 이면 버튼 3개가 있고 동작 뒤에는 배포 보기 한 개만 남는다`, `동작 실패 오류가 버튼 위에 alert 로 전체 문장 보인다`, `긴 공백 없는 fix_where 가 그대로 화면 글에 들어 있다`.
- [ ] **Step 2: 실패 확인** — `cd app && npx jest src/__tests__/IncidentDetail.test.js src/__tests__/OpsComponents.test.js` → 새 테스트 FAIL.
- [ ] **Step 3: 구현** — `IncidentExplain` 의 `flat`, 화면 재배치, 3칸 버튼 줄. 버튼의 `accessibilityLabel`(`배포 #N 다시 배포` 등)과 글은 그대로.
- [ ] **Step 4: 통과 확인** — 같은 두 파일 + `DetailParts.test.js`(`IncidentCard` 가 거기서도 쓰이면) → 전부 PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(app): 인시던트 상세를 한 화면에 - 위·아래 고정, 가운데 상자만 스크롤"`

---

## Task 4: 웹 번들로 재고 고치기

**Files:**
- Modify (필요할 때만): Task 1~3 의 파일들 (간격·글 크기 조정)
- 기록: `docs/worklog/2026-11-15.md` (측정 표)

**Interfaces:** 이 태스크는 새 코드를 만들지 않고 측정한다. 측정 도구는 이 저장소에 두지 않는다 (임시 스크립트는 scratchpad).

- [ ] **Step 1: 웹 번들** — `cd app && npx expo export --platform web` → `dist/` 가 만들어진다 (정적 서버는 빈 포트로 띄우고 **띄운 PID 만** 끈다).
- [ ] **Step 2: 모의 API + 측정** — Playwright(`/api/**` 는 `page.route` 로 모의)로 다음 상태를 **390×844 와 360×740, 라이트·다크** 로 연다. 각 칸에서 `FitScreen` 의 `scrollHeight`, `clientHeight`, 그리고 `[data-testid=incident-body]` 의 같은 값을 잰다.

  | 화면 | 측정 상태 (모의 데이터) |
  |---|---|
  | 배포 설정 | 기본 / 스위치 오류 안내가 뜬 상태(긴 서버 문장 2줄) |
  | 알림 설정 | 기본(웹에서는 푸시 `unsupported` 안내 상자가 항상 뜬다) / 설명 펼침 / 저장 안내가 뜬 상태 |
  | 인시던트 | `recovering`(원인 2줄, 고칠 곳 ARN 90자 1개, 해야 할 일 2개, 타임라인 3건, 헬스 90%) / `needs_action`(3칸 버튼) / **무거운 것**(원인 6줄·해야 할 일 4개·타임라인 8건) |

  판정: Decision 2 의 기준. 인시던트 "무거운 것"은 `FitScreen` 이 넘치지 않고 `incident-body` 만 스크롤되며 아래 버튼이 화면 안에 있어야 한다. 또 가로 스크롤 없음(`scrollWidth ≤ innerWidth`), 조작 요소 높이 ≥ 44(헤더 뒤로 가기 제외, 이건 기존 30×30), 콘솔 경고·오류 0, 모의되지 않은 요청 0.
- [ ] **Step 3: 안 맞는 칸 고치기** — 넘치는 칸이 있으면 먼저 간격(`gap`/`padding`)·글 줄 높이를 줄이고, 그래도 390×844 가 안 맞으면 알림 설정의 `받는 방법` 두 줄 설명도 `compact` 보다 한 단계 줄이는 대신 **내용은 지우지 않는다**. 고친 뒤 다시 잰다 (최대 3회). 3회 뒤에도 안 맞는 칸은 그대로 두고 숫자를 기록한다 (보고에 "안 맞음"으로 적는다).
- [ ] **Step 4: 전체 앱 테스트** — `cd app && npx jest` → 전부 PASS (개수 기록).
- [ ] **Step 5: 기록·커밋** — 측정 표(칸마다 `scrollHeight/clientHeight`)를 worklog 에 쓴다. `git commit -m "fix(app): 한 화면 측정 결과 반영"` (고친 게 없으면 worklog 만).

---

## Task 5: 문서

**Files:**
- Modify: `app/README.md`, `docs/ui-spec.md`, `docs/conventions.md`, `docs/architecture.md`(앱 폴더 한 줄), `HISTORY.md`, `docs/worklog/2026-11-15.md`

- [ ] **Step 1: `app/README.md`** — 폴더 목록에 `FitScreen`, `FooterSlot`, `SettingTile`, `ops/NotificationKinds` 추가. 화면 표의 세 행(`/incidents/[i_id]`, `/deploy-settings/[d_id]`, `/notification-settings`)에 "한 화면에 맞춤 (아래 '한 화면 규칙')"을 덧붙이고, `## 한 화면 규칙 (계획 F)` 절을 만든다: 어느 화면이 맞추고 어느 화면이 스크롤하는지, 기준 화면(390×844, 360×740), 안전망 스크롤, 접는 것은 알림 종류 설명뿐, 측정 결과(Task 4 표 요약), 못 맞춘 칸. `알려진 빈틈` 의 `notification-settings.js 270줄` 항목은 새 줄 수로 고치거나 해소됐으면 지운다.
- [ ] **Step 2: `docs/ui-spec.md`** — "앱" 절에 한 화면 규칙과 화면별 배치를 한 문단씩. 알림 설정의 종류 설명이 접혀 있다는 점을 S-15 앱 설명에 적는다.
- [ ] **Step 3: `docs/conventions.md`** — 화면 규칙에 "앱: 내용이 정해진 화면은 `FitScreen` 위에서 한 화면에 맞추고, 목록·로그만 자기 상자에서 스크롤한다. 누르면 펼치는 설명은 `accessibilityHint` 에도 있으면 허용" 한 줄.
- [ ] **Step 4: `docs/architecture.md`·`HISTORY.md`·worklog** — 앱 폴더 설명 한 줄; `HISTORY.md` 에 한 행(파일에 NUL 바이트가 하나 있다 — 편집 뒤 `git diff --stat` 가 그 행만 바뀌었는지, NUL 이 그대로인지 확인); worklog 에 결정·측정·남은 빈틈(영어, 간결).
- [ ] **Step 5: 확인·커밋** — 새로 쓴 경로·파일 이름이 실제로 있는지 `Glob` 으로 확인. `git commit -m "docs(app): 한 화면 규칙과 측정 결과 반영"`

---

## 자체 점검 (계획 작성자)

- **요구 대응:** 고정 내용 화면 3개 → Task 1~3, 스크롤 상자 유지 → Task 3 가운데 상자·Decision 1, 측정 → Task 4, 문서 → Task 5.
- **타입 일관성:** `FitScreen`/`FooterSlot`(Task 1)을 Task 2·3 이 같은 이름·prop 으로 쓴다. `SettingSwitch.compact`·`SettingTile`·`NotificationKinds` 는 Task 2 안에서 정의·사용. `IncidentExplain.flat` 은 Task 3 안.
- **알려진 위험:** 360×740 에서 푸시 안내 상자가 있는 알림 설정은 안 맞을 수 있다 (Decision 2 가 허용, 안전망 스크롤로 전부 보임). 레이아웃은 jest 로 증명할 수 없어 Task 4 의 웹 번들 측정이 유일한 근거이고, 실제 기기에서는 보지 못한다 (보고에 명시).
