# 어절 줄바꿈 + 인시던트 탭 (계획 G) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) 앱과 웹의 모든 화면에서 한글이 줄을 넘길 때 글자 중간이 아니라 어절(띄어쓰기) 단위로 줄바꿈한다. (2) 앱의 인시던트 상세를 탭 2개로 나눈다: 첫 탭 "문제"는 배포·문제·날짜·시간·원인을 한 줄씩 명사형으로, 둘째 탭 "원인"은 원인 문장·고칠 곳·해야 할 일을 한눈에 보이게 정리한다.

**Architecture:** 줄바꿈은 앱에 `Text` 래퍼(`app/src/components/Text.js`: 웹 번들은 `wordBreak: 'keep-all'`, iOS 는 `lineBreakStrategyIOS="hangul-word"`)를 만들어 모든 화면이 이 `Text` 를 쓰게 바꾸고, 웹(`shared/ui/styles.css`)은 `body` 규칙 하나로 처리한다. 인시던트 탭은 계획 F 의 레이아웃 틀(`FitScreen`, 위 고정 · 가운데 상자 · 아래 고정)을 그대로 쓰고, 가운데 상자의 내용만 탭에 따라 바꾼다. 서버·API 는 바꾸지 않는다.

**Tech Stack:** Expo SDK 58, React Native 0.88.1 / react-native-web, jest-expo + @testing-library/react-native, 웹은 Vite + 순수 CSS, `node:test`(`npm run test:web`).

**Spec:** 오너 요청 2026-11-15 ("글자가 다른 줄로 넘어갈 때 중간에 잘리지 않도록 줄바꿈 진행 / 문제: 첫번째 탭 배포 문제 날짜 시간 원인을 한줄씩 배정, 명사형으로 내용 출력 / 두번째 탭 원인, 한 눈에 확인할 수 있도록 정리") 와 오너 답변(AskUserQuestion 2026-11-15): 원인 한 줄은 **종류 명사**(서버 변경 없음), 나머지(타임라인·헬스 막대)는 **첫 탭 아래, 버튼은 탭 밖 맨 아래 고정**, 줄바꿈은 **앱과 웹 전체**. 별도 설계 문서는 없다 ("Decisions" 가 설계다).

## Decisions (구현자는 다시 정하지 않는다)

1. **어절 줄바꿈 = "단어(띄어쓰기) 안에서는 끊지 않는다"**. 한 어절이 한 줄보다 길 때(ARN·URL 등)만 어쩔 수 없이 끊긴다 (그래서 `overflow-wrap`/`wrapAnywhere` 는 남긴다). 코드·로그 상자의 `word-break: break-all` 은 그대로 둔다.
2. **앱 `Text` 래퍼:** 이름은 `Text`, 파일 `app/src/components/Text.js`. 웹 번들(`Platform.OS === 'web'`)에서는 기본 스타일 `{ wordBreak: 'keep-all', overflowWrap: 'break-word' }` 를 앞에 깔고(호출한 `style` 이 이긴다), 모든 플랫폼에서 `lineBreakStrategyIOS="hangul-word"` 를 기본 prop 으로 준다(호출자가 덮어쓸 수 있다). 나머지 prop·ref·children 은 그대로 넘긴다. 앱의 모든 화면·컴포넌트는 `react-native` 가 아니라 이 래퍼에서 `Text` 를 가져온다 (Task 1 의 가드 테스트가 지킨다).
3. **안드로이드:** 한글 어절 줄바꿈을 켜는 RN 공식 prop 이 없다. 이 계획은 안드로이드를 **처리하지 않고** "미확인·미처리"로 기록한다 (글자 사이에 보이지 않는 연결 문자를 넣는 방법은 문자열을 바꾸고 긴 글에서 넘칠 위험이 있어 기기에서 확인하기 전에는 넣지 않는다). 문서에 사실대로 적는다 — "안드로이드는 지금 확인하지 못했다".
4. **인시던트 상세 탭:** 탭 이름 `문제`(첫째, 기본) / `원인`(둘째). 탭 줄은 위 고정 묶음, 가운데 상자는 선택한 탭의 내용, 아래 고정 묶음(헬스 막대·안내·버튼)은 탭과 무관하게 그대로다. 탭 선택은 화면 안 state 만이다(저장하지 않음, 다른 인시던트로 가면 처음 탭).
5. **"문제" 탭 줄(위에서 아래, 줄마다 `이름 | 값` 한 줄, 값은 명사형):** `배포` = `#{d_id}` · `문제` = 상태 라벨(`INCIDENT_STATUS_LABEL`: 감지됨/복구 중/해결됨/확인 필요, 상태 색 배지 모양 유지) · `날짜` = `11월 9일` · `시간` = `12:12` · `원인` = 종류 라벨(`INCIDENT_KIND_LABEL`, 모르는 종류는 서버 값 그대로). `resolved` 이고 `resolved_at` 이 있으면 `해결` 줄을 하나 더(`11월 9일 12:15 (3분 20초)`). 날짜·시간은 `detected_at` 기준, 읽을 수 없으면 `확인 불가`. 줄 아래에 (복구 중일 때만) 지금의 "마법사가 복구를 시도하고 있습니다. 이 화면은 5초마다 새로 고쳐집니다." 글, 그 아래에 `마법사가 한 일` 타임라인(`IncidentTimeline`)이 같은 상자 안에 이어진다.
6. **"원인" 탭:** 맨 위에 한 줄 요약(`incident.summary || explain.summary || '문제가 감지되었습니다'`, 굵게, 머리글 역할)을 두고, 그 아래 `IncidentExplain flat`(원인 · 고칠 곳 · 해야 할 일, 계획 F 의 같은 컴포넌트)을 둔다. 이전의 맨 위 요약 카드(요약·배지·메타 글)는 없어진다 — 요약은 원인 탭, 배지·메타는 문제 탭 줄이 대신한다. 화면 제목(`문제 #i_id`)은 그대로.
7. **계획 F 의 틀은 유지:** `FitScreen`, 가운데 상자(`testID="incident-body"`, `bounces={false}`, `maxHeight` = `onLayout` 측정값에서 계산), 위/아래 묶음 측정, 끌어당겨 새로고침, 폴링·헬스 이력·동작 로직은 건드리지 않는다. "위 고정 묶음"이 요약 카드에서 탭 줄로 바뀔 뿐이다. 탭을 바꿀 때 가운데 상자의 스크롤은 맨 위로 돌아간다 (`key` 로 상자를 다시 만든다).
8. **서버·API·문구 불변:** 새 글은 탭 이름·줄 이름(`배포` `문제` `날짜` `시간` `원인` `해결`)·`확인 불가` 뿐이다.

## Global Constraints

- 사용자에게 보이는 글·주석은 한국어, 식별자는 영어. 함수 위에 한 줄 한국어 주석, docstring 없음. 기존 `=` 간격 유지, 일괄 정리 금지 (`CLAUDE.md`).
- 색은 `useColors()` 토큰, 간격은 `spacing`. 색 하드코딩 금지. 터치 대상 44pt 이상.
- 내용을 가리는 속성 금지: `numberOfLines`, `ellipsizeMode`, `overflow: 'hidden'` 으로 글 가리기 (`docs/conventions.md`). 스크롤 상자 허용.
- 서버 필드·상태 값·접근성 역할/이름(`switch`, `button`, `alert`, `header`, 기존 `accessibilityLabel`)은 그대로. 새 탭은 역할 `tab`, `accessibilityState={{ selected }}`.
- `api.js`·`src/ops/constants.js` 의 값·폴링 로직은 건드리지 않는다. `app/` 는 독립 패키지(밖 파일 import 금지).
- 브랜치 `feat/app-incident-tabs` (`test` 에서 분기). push·`main` 은 오너 확인 전에는 하지 않는다. 테스트 러너는 한 번에 하나(`cd app && npx jest …`, 웹은 `npm run test:web`).
- 기존 테스트(앱 1027개, 웹 42개)는 의미가 바뀌는 곳만 고치고 보고서에 이유를 적는다.

## Review Focus

1. **한 어절이 한 줄보다 길 때** (ARN 90자, 공백 없는 긴 원인): 줄바꿈 규칙이 글을 넘치게 하거나 가리지 않는다 — 웹에서 `keep-all` 이어도 마지막 수단으로 끊긴다 (Task 1·2, 측정은 Task 5).
2. **탭 전환 중 폴링이 도는 상태** (`recovering`): 탭을 바꿔도 폴링·타이머·헬스 이력·안내가 다시 시작하거나 사라지지 않는다 (Task 4).
3. **모르는 종류·빈 값:** 서버가 모르는 `kind`, 읽을 수 없는 `detected_at`, `explain` 이 `null`/일부 — 줄은 그대로 그려지고 깨지지 않는다 (Task 3·4).
4. **탭 접근성·터치:** 탭이 `tab` 역할로 읽히고 선택 상태가 전달되며 높이 44pt 이상 (Task 3).
5. **불러오는 중·오류·404:** 탭이 나오지 않고 계획 F 의 가운데 배치가 그대로 (Task 4).

---

## Task 1: 앱 `Text` 래퍼 + 모든 화면 전환

**Files:**
- Create: `app/src/components/Text.js`, `app/src/__tests__/Text.test.js`
- Modify: `app/app/*.js`, `app/app/*/*.js`, `app/src/**/*.js` 중 `react-native` 에서 `Text` 를 가져오는 모든 파일 (테스트 파일 제외; 약 39개)

**Interfaces:**
- Produces: `Text(props)` — named export `Text`(와 default export 동일). 동작은 Decision 2. 기존 `react-native` `Text` 와 prop 호환.

- [ ] **Step 1: 실패하는 테스트** — `Text.test.js`:
  - `children 과 testID 와 accessibilityRole 을 그대로 그린다` (`getByText`, `getByRole('header')`).
  - `iOS 에서는 lineBreakStrategyIOS 가 hangul-word 다` / `호출자가 lineBreakStrategyIOS 를 넘기면 그것이 이긴다`.
  - `웹에서는 기본 스타일에 wordBreak keep-all 과 overflowWrap break-word 가 들어가고 호출자 style 이 덮어쓴다` (`jest.replaceProperty(Platform, 'OS', 'web')`, `StyleSheet.flatten` 으로 확인; iOS 에서는 이 스타일이 없다).
  - `ref 가 Text 인스턴스로 전달된다`.
  - **가드:** `app/app` 과 `app/src`(테스트 폴더와 `components/Text.js` 제외)의 모든 `.js` 를 읽어 `import {…} from 'react-native'` 의 이름 목록에 `Text` 가 들어 있지 않음을 확인한다 (파일 목록을 `fs` 로 훑는 테스트, 위반 파일 이름을 실패 메시지에 낸다).
- [ ] **Step 2: 실패 확인** — `cd app && npx jest src/__tests__/Text.test.js` → 래퍼가 없어 FAIL.
- [ ] **Step 3: 구현** — `Text.js` (Decision 2). 한 줄 한국어 주석.
- [ ] **Step 4: 모든 화면 전환** — 임시 스크립트(scratchpad, 저장소 밖)로 `import { …, Text, … } from 'react-native'` 에서 `Text` 만 빼고 같은 파일에 `import { Text } from '<상대경로>/components/Text'` 를 더한다 (여러 줄 import 도 처리, 빈 import 가 남으면 지운다). 한 파일씩 손으로 고칠 필요는 없지만 결과 diff 는 import 줄만 바뀌어야 한다.
- [ ] **Step 5: 전체 통과** — `cd app && npx jest` → 전부 PASS (가드 포함). 줄 수·개수를 보고서에 적는다.
- [ ] **Step 6: 커밋** — `git commit -m "feat(app): Text 래퍼로 한글 어절 줄바꿈 (웹 keep-all, iOS hangul-word)"`

---

## Task 2: 웹 어절 줄바꿈

**Files:**
- Modify: `shared/ui/styles.css`
- Test: Create `tests/web/koreanWrap.test.js`

**Interfaces:** 없음 (CSS 규칙).

- [ ] **Step 1: 실패하는 테스트** — `koreanWrap.test.js` (`node:test`): `shared/ui/styles.css` 를 읽어 `body { … }` 블록에 `word-break: keep-all` 과 `overflow-wrap: break-word` 가 있다; `word-break: break-all` 로 정한 기존 규칙(코드·로그·endpoint)은 그대로 남아 있다 (`.endpoint`, `.explain-raw`, 로그 상자 규칙이 여전히 `break-all`).
- [ ] **Step 2: 실패 확인** — `npm run test:web` → 새 테스트 FAIL.
- [ ] **Step 3: 구현** — `body` 에 위 두 줄을 더한다 (한 줄 주석). 다른 규칙은 건드리지 않는다.
- [ ] **Step 4: 통과 + 빌드** — `npm run test:web` 전부 PASS, `npm run build` 성공.
- [ ] **Step 5: 브라우저 확인** — Vite 개발 서버 대신 `npm run build` 결과나 개발 서버를 빈 포트로 띄우고(띄운 PID 만 끈다) 모의 `/api` 로 긴 한글 문장이 든 화면(예: 알림 목록, 인시던트 상세)을 320/390px 에서 열어, 한글 어절이 글자 중간에서 끊기지 않고 공백 없는 긴 글(ARN)은 넘치지 않고 끊기며 `scrollWidth ≤ innerWidth` 인 것을 잰다. 결과를 보고서에 적는다 (실제 서버·기기 아님, 모의 데이터).
- [ ] **Step 6: 커밋** — `git commit -m "feat(web): 한글 어절 줄바꿈 (body word-break keep-all)"`

---

## Task 3: 날짜·시간 도우미 + 줄 컴포넌트 + 탭 줄

**Files:**
- Modify: `app/src/ops/format.js`
- Create: `app/src/components/ops/IncidentFacts.js`, `app/src/components/ops/IncidentTabs.js`
- Test: Modify `app/src/__tests__/opsLogic.test.js`; Create `app/src/__tests__/IncidentTabs.test.js`

**Interfaces:**
- Produces:
  - `formatDate(iso: string): string` → `"11월 9일"` (기기 현지, `formatTime` 과 같은 규칙, 읽을 수 없으면 `''`), `formatClock(iso: string): string` → `"12:12"` (두 자리 시:분, 읽을 수 없으면 `''`). `formatTime` 은 그대로.
  - `IncidentFacts({ incident })` — 줄마다 `<이름> | <값>` 한 줄: Decision 5 의 순서. 이름은 muted 13/19 고정 폭(`width: 44`), 값은 text 15/21 `flex:1, minWidth:0`(길면 줄바꿈, 가리지 않음). `문제` 값은 `IncidentBadge`(`app/src/components/ops/IncidentCard.js`)를 쓴다. 값을 읽을 수 없으면 `확인 불가`. `testID="incident-fact"` 를 줄마다 단다.
  - `IncidentTabs({ tabs, value, onChange })` — `tabs` = `[{ key, label }]`. 가로로 균등(`flex:1`) 나뉜 `Pressable` 줄(`accessibilityRole="tablist"` 컨테이너, 각 탭 `accessibilityRole="tab"`, `accessibilityState={{ selected }}`, `minHeight: 44`), 선택된 탭은 `colors.accent` 아래줄 + 굵은 글, 아닌 탭은 muted. 누르면 `onChange(key)`.
- Consumes: `INCIDENT_KIND_LABEL`, `INCIDENT_STATUS_LABEL`(`app/src/ops/constants.js`), `durationText`, `formatTime`, `toMs`(`format.js`).

- [ ] **Step 1: 실패하는 테스트**
  - `opsLogic.test.js`: `formatDate 는 현지 시각으로 "11월 9일" 을 만든다`(`Z` 없는 서버 시각은 UTC 로 본다 — `formatTime` 테스트와 같은 방식으로 기대값을 만든다), `formatClock 은 두 자리 시:분`, `읽을 수 없는 값은 빈 글자`.
  - `IncidentTabs.test.js`: `tab 역할 두 개와 tablist 가 그려지고 선택된 탭만 selected 다`, `탭을 누르면 onChange(key)`, `탭 높이가 44 이상이다`; `IncidentFacts`: `배포 #5 · 문제 확인 필요 · 날짜 · 시간 · 원인 응답 이상 순서의 줄이 한 줄씩 나온다`(`getAllByTestId('incident-fact')` 의 순서·글), `resolved 이고 resolved_at 이 있으면 해결 줄이 더해지고 아니면 없다`, `모르는 kind 는 서버 값 그대로`, `detected_at 이 읽을 수 없으면 날짜·시간 값이 확인 불가`, `긴 값도 글이 그대로 들어 있다`(잘라내지 않음).
- [ ] **Step 2: 실패 확인** — `cd app && npx jest src/__tests__/opsLogic.test.js src/__tests__/IncidentTabs.test.js` → FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces 대로 (새 파일에서는 Task 1 의 `Text` 래퍼를 쓴다).
- [ ] **Step 4: 통과 확인** — 같은 두 파일 PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(app): 인시던트 줄(IncidentFacts)·탭(IncidentTabs)과 날짜·시간 도우미"`

---

## Task 4: 인시던트 상세 화면을 탭으로 다시 짜기

**Files:**
- Modify: `app/app/incidents/[i_id].js`
- Test: Modify `app/src/__tests__/IncidentDetail.test.js`

**Interfaces:**
- Consumes: `IncidentTabs`, `IncidentFacts`(Task 3), `IncidentExplain`, `IncidentTimeline`, `HealthBar`, `FitScreen`(계획 F).
- Produces (화면 구성, Decisions 4~7):
  1. 위 고정 묶음(`testID="incident-top"`, 높이 측정 유지): `IncidentTabs` 한 줄 — `tabs = [{ key: 'problem', label: '문제' }, { key: 'cause', label: '원인' }]`, state `tab` 기본 `'problem'`.
  2. 가운데 상자(계획 F 그대로: `testID="incident-middle"`/`"incident-body"`, `maxHeight` 계산, `bounces={false}`): `key={tab}` 로 탭마다 새로 만든다. `problem` 이면 `IncidentFacts` → (활성 상태일 때) 복구 안내 글 → 구분선 → `IncidentTimeline`. `cause` 이면 요약 한 줄(머리글 역할, 굵게) → `IncidentExplain flat`.
  3. 아래 고정 묶음: 지금 그대로 (헬스 막대, 안내들, 버튼).
  - 위 요약 카드는 없앤다. 폴링·`perform`·`confirmStopDeploy`·헬스 이력·`useFocusEffect`·끌어당겨 새로고침 로직은 건드리지 않는다.

- [ ] **Step 1: 실패하는 테스트** — `IncidentDetail.test.js`: 지금 이 화면에서 요약·원인·고칠 곳·해야 할 일 글을 찾던 테스트는 먼저 `원인` 탭을 누르도록 고치고(이유를 보고서에 적는다), 새로:
  - `처음에는 문제 탭이 선택되고 배포·문제·날짜·시간·원인 줄과 타임라인이 가운데 상자 안에 있다`.
  - `원인 탭을 누르면 요약·원인·고칠 곳·해야 할 일이 보이고 문제 줄은 사라진다` / `다시 문제 탭을 누르면 돌아온다`.
  - `탭을 바꿔도 폴링 요청이 늘거나 다시 시작하지 않는다` (같은 시간 동안 `incidentApi.getOne` 호출 횟수가 탭 전환 전후로 같은 박자) — 기존 폴링 테스트의 가짜 타이머 방식을 따른다.
  - `헬스 막대와 버튼은 탭에 상관없이 상자 밖에 있고 needs_action 이면 버튼 3개, 동작 뒤에는 배포 보기 하나다`(탭 두 개 모두에서).
  - `불러오는 중·오류·404 에서는 탭이 없다`.
  - `explain 이 null 이어도 원인 탭이 아직 원인을 확인하지 못했습니다 문구로 그려진다`, `긴 fix_where 가 원인 탭 글에 그대로 들어 있다`.
- [ ] **Step 2: 실패 확인** — `cd app && npx jest src/__tests__/IncidentDetail.test.js` → 새 테스트 FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces 대로. 쓰지 않게 된 import 와 스타일(`headTop`, `summary` 등 요약 카드용)은 지운다.
- [ ] **Step 4: 통과 확인** — `cd app && npx jest src/__tests__/IncidentDetail.test.js src/__tests__/OpsComponents.test.js src/__tests__/DetailParts.test.js` → 전부 PASS. 전체 `npx jest` 한 번.
- [ ] **Step 5: 커밋** — `git commit -m "feat(app): 인시던트 상세를 문제·원인 탭으로 나눈다"`

---

## Task 5: 웹 번들로 재고 확인

**Files:** 필요할 때만 Task 1~4 의 파일(간격·글 크기). 기록: `docs/worklog/2026-11-15.md`

- [ ] **Step 1: 웹 번들** — `cd app && npx expo export --platform web` → 빈 포트로 정적 서버(띄운 PID 만 끈다).
- [ ] **Step 2: 모의 API + 측정** — Playwright(`/api/**` 모의, 계획 F 의 Task 4 와 같은 방법: `docs/worklog/2026-11-15.md` "Plan F measurement" 와 `.superpowers` 가 아닌 worklog 기록을 참고)로 인시던트 상세를 **390×844 와 360×740, 라이트** 로 연다. 상태: `recovering`(원인 문장 2줄, fix_where ARN 90자, 해야 할 일 2개, 타임라인 3건) 의 **문제 탭 / 원인 탭**, `needs_action`(버튼 3칸) 두 탭, 무거운 것(원인 6줄·해야 할 일 4개·타임라인 8건) 두 탭, `resolved`(해결 줄 포함) 문제 탭. 칸마다 `incident-scroll` 의 `scrollHeight/clientHeight`, `incident-body` 의 같은 값, 아래 버튼 하단 위치, 가로 스크롤 없음, 조작 요소 ≥ 44(헤더 뒤로 가기 제외), 콘솔 경고·오류 0, 모의 안 된 요청 0 을 적는다.
- [ ] **Step 3: 줄바꿈 확인** — 같은 화면의 긴 한글 문장이 글자 중간에서 끊기지 않고 어절 단위로 줄바꿈되는지(스크린샷 또는 `Range.getClientRects` 로 확인), 공백 없는 ARN 은 넘치지 않고 끊기는지 확인해 기록한다. 안드로이드·iOS 실제 기기 결과는 없다고 적는다.
- [ ] **Step 4: 안 맞는 칸 고치기** — 넘치면 간격·글 크기만 줄이고 내용은 지우지 않는다 (최대 3회). 그래도 안 맞으면 숫자를 "안 맞음"으로 기록한다.
- [ ] **Step 5: 전체 테스트·기록·커밋** — `cd app && npx jest` PASS 개수 기록, 측정 표를 worklog 에 추가(terse English), `git commit -m "fix(app): 탭 화면 측정 결과 반영"` (고친 게 없으면 worklog 만).

---

## Task 6: 문서

**Files:** `app/README.md`, `docs/ui-spec.md`, `docs/conventions.md`, `docs/architecture.md`, `HISTORY.md`, `docs/worklog/2026-11-15.md`

- [ ] **Step 1: `app/README.md`** — 폴더 목록에 `components/Text.js`, `ops/IncidentFacts`, `ops/IncidentTabs` 추가. `/incidents/[i_id]` 행과 "한 화면 규칙" 절의 인시던트 설명을 탭 구조(문제·원인)로 고친다. `## 줄바꿈 (계획 G)` 절: 어절 단위 줄바꿈 방법(웹 keep-all, iOS hangul-word), **안드로이드는 처리하지 않았고 기기에서 확인하지 못했다**, 모든 화면이 래퍼 `Text` 를 쓴다는 규칙(가드 테스트).
- [ ] **Step 2: `docs/ui-spec.md`** — 앱 S-13 설명을 탭 구조로, 웹·앱 줄바꿈 규칙 한 문단, 그리고 `accessibilityHint` 는 웹(react-native-web)이 내보내지 않으므로 "늘 읽힘"은 네이티브 기준이라는 한 구절(알림 설정 종류 설명 줄 근처, 계획 F 최종 리뷰의 남은 마이너).
- [ ] **Step 3: `docs/conventions.md`** — 화면 규칙에 "한글은 어절 단위로 줄바꿈한다: 웹은 `body` 의 `word-break: keep-all`, 앱은 `components/Text.js` 의 `Text` 만 쓴다 (`react-native` 의 `Text` 를 직접 가져오지 않는다)" 한 줄.
- [ ] **Step 4: `docs/architecture.md`·`HISTORY.md`·worklog** — 앱 폴더 한 줄; `HISTORY.md` 한 행(파일의 NUL 바이트 하나 보존: 편집 전후 `tr -cd '\000' < HISTORY.md | wc -c` 가 같아야 하고 `git diff --stat HISTORY.md` 가 그 행만 바뀌어야 한다); worklog 에 결정(안드로이드 미처리 포함)·남은 빈틈.
- [ ] **Step 5: 확인·커밋** — 문서에 적은 파일·경로가 실제로 있는지 확인하고, 측정하지 않은 것(네이티브 기기, 안드로이드 줄바꿈)을 측정한 것처럼 쓰지 않았는지 다시 읽는다. `git commit -m "docs(app): 탭 구조와 어절 줄바꿈 규칙 반영"`

---

## 자체 점검 (계획 작성자)

- **요구 대응:** 어절 줄바꿈 앱 → Task 1, 웹 → Task 2; 첫 탭 5줄 명사형 → Task 3·4 (값은 라벨 명사·날짜·시간·`#번호`뿐이라 서버 변경 없음); 둘째 탭 원인 정리 → Task 4; 타임라인·헬스·버튼 위치(오너 답변) → Decision 5·7; 측정 → Task 5; 문서 → Task 6.
- **타입 일관성:** `IncidentFacts`/`IncidentTabs`(Task 3 정의)를 Task 4 가 같은 이름·prop 으로 쓴다. `Text` 래퍼(Task 1)는 Task 3 이후 새 파일이 사용한다. Task 4 는 계획 F 의 `FitScreen`/`onAvailableHeight`/`incident-*` testID 를 그대로 쓴다.
- **알려진 위험:** 안드로이드 한글 어절 줄바꿈은 이 계획이 해결하지 못한다(Decision 3, 문서에 명시). iOS `hangul-word` 도 기기에서 확인하지 못한다. 레이아웃·줄바꿈은 웹 번들 측정만 근거다.
