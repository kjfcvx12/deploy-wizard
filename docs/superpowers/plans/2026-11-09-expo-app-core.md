# Expo App Core (Plan C1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new React Native (Expo) app in `app/` that does what the web does for the core deploy flow: list deploys, create a deploy in two steps (analyze → deploy), watch a deploy (progress, logs, result, explanation), enter env-var values when a deploy waits in `needs_input`, and redeploy/stop/start/delete — all against the existing API, with no login yet.

**Architecture:** Expo + Expo Router (file-based routes), plain JavaScript like the web UI. Pure-logic modules (`src/api.js`, `src/constants.js`, `src/envGroups.js`) are unit-tested with jest-expo; screens use the same server field names as the web (`d_id`, `repo_url`, `needs_redeploy`, …). Colors come from a theme module that mirrors the web tokens in `shared/ui/styles.css` (light/dark via the system color scheme). Connection management (AWS/GitHub connect flows), notifications/push, login and the store build are NOT in C1 (see Self-review).

**Tech Stack:** Expo (current stable SDK at scaffold time, pinned in `app/package.json`), React Native, Expo Router, jest-expo + @testing-library/react-native for tests, `expo-clipboard`, `expo-linking`/`Linking`. Verify every Expo/React Native API against the current official docs (WebFetch `https://docs.expo.dev`) before using it; never invent an API or option.

**Spec:** `docs/app-web/02-feature-spec.md` (C-01..C-12, H, I), `docs/app-web/06-screens.md` (S-02..S-07, S-16, S-18..S-20), `docs/api-spec.md` (the built contract: "Deploy", "Env", "Advice", "Accounts" read endpoints), web reference implementation in `features/deploys/ui/*`, `features/envvars/ui/*`, `features/advice/ui/*`, tokens in `shared/ui/styles.css`. Decisions: D1 (web stays, app in `app/` with Expo), D9 (`needs_input`), D11 (two-step deploy).

## Global Constraints

- Language: UI copy Korean, identical to the web where the web has copy (copy from the web components); code comments Korean one-liners above components/functions; identifiers English; saved records (HISTORY/worklog) terse English.
- Server field names unchanged (`d_id`, `repo_url`, `env_pending`, …); status strings defined only in `app/src/constants.js` and kept identical to `features/deploys/ui/constants.js` (STATUS_LABEL, PROGRESS, `needs_input`).
- Hard rule 3: no automatic create/change/delete; every change is a user-pressed button, destructive ones (delete, stop) behind a confirmation dialog with the safe option first. Hard rule 6: env var values are write-only (cleared after a successful save; never logged, stored, put in a URL or shown in error text); secret-kind rows (`database`, `cache`, `external_api`, `secret`) never get a value input — the backend answers 501 for them.
- The app talks to the existing API only. API base URL from `EXPO_PUBLIC_API_BASE_URL` (documented in `app/.env.example`; default `http://localhost:8081`; Android emulator needs `http://10.0.2.2:8081`, a physical device the PC's LAN IP). The server is local-only without auth (phase 1); do not add auth code.
- Polling: use an `alive` flag and clear timers on unmount; poll every 1.5 s while a deploy is in progress or logs keep arriving, 3 s / 15 s for the list (same intervals as the web); stop polling while the app is in the background.
- Touch targets ≥ 44 pt; text scales with the system font setting; both light and dark themes.
- No new backend files; no change to `features/`, `shared/`, `tests/`. Root `package.json` / `vite.config.js` untouched (the app is its own package in `app/`).
- Git: branch `feat/expo-app-core` from `test`; `app/node_modules`, `.expo`, `dist` ignored (add to `.gitignore` if missing); do not commit `.env`. Conventional Commits, Korean body, end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Verification (no device available on this PC): `npx jest` for logic, `npx expo export --platform web` must build, and a Playwright MCP check of the web export at 390×844 (light + dark) with `/api/**` mocked via `page.route`. State plainly in reports that nothing was run on a real iOS/Android device or emulator. Stop only processes you started (dev servers by their PID on the port you started; never by process name — other projects share this PC); no `.playwright-mcp/` left in the repo; screenshots only under the system temp directory.

## Review Focus

- Env value leakage (state retained after save, logs, URLs, error text) and secret-kind rows never offering an input (Task 5).
- Polling lifecycle: unmount, background/foreground, `needs_input` stops polling by status so the screen must reload env rows itself and restart after continue; no duplicate timers (Tasks 2, 4, 5).
- Stale analysis never deployable; double-tap guards; request-id guard for late responses (Task 3).
- Network failure / server unreachable states on every screen (empty states, retry button, Korean message, no crash) (Tasks 2–5).
- Long strings (repo names, endpoints, ARNs, 400-line logs) on a 390-pt-wide screen; keyboard covering inputs; safe-area insets (Tasks 2–5).

---

### Task 1: Scaffold, theme, API client, constants, tests

**Files:**
- Create: `app/` (via the official Expo scaffold, JavaScript "blank" template), `app/app.json` (name `배포 마법사`, slug `deploy-wizard`, `scheme: "deploywizard"`, `userInterfaceStyle: "automatic"`, no bundle ids yet — decision D6), `app/.env.example`, `app/README.md` (Korean: setup, env var, how to run, what is verified), `app/src/theme.js`, `app/src/api.js`, `app/src/constants.js`, `app/src/envGroups.js`, `app/src/__tests__/*.test.js`
- Modify: `.gitignore` (ignore `app/node_modules/`, `app/.expo/`, `app/dist/`, `app/.env`)

**Interfaces:**
- Produces (`src/api.js`): `request(path, options?)` — fetch wrapper with JSON headers, 15 s timeout (AbortController), base URL `process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8081'`; throws `Error` whose message is the server `detail` (string, or joined `msg`s for 422), `요청 실패 (status)` otherwise, `서버에 연결할 수 없습니다` on network failure/timeout; returns `null` for 204. Plus API objects mirroring the web: `deployApi` (`getAll`, `getOne`, `getLogs(d_id, after)`, `getIssues`, `getHealth`, `getRemote(repo_url, github_installation_id)`, `create(repo_url, branch, aws_account_id, github_installation_id)` with the same null-normalization as the web, `redeploy`, `stop`, `start`, `remove`), `envApi` (`getAll`, `put`, `clearValue`, `continueDeploy`), `adviceApi.analyze(payload)`, `accountApi` read-only (`getConnections`, `getGithubRepositories(g_id)`).
- Produces (`src/constants.js`): `STEPS`, `STATUS_LABEL`, `PROGRESS`, `isProgress`, `repoName`, `showsEnvCard` (same semantics as the web's `features/deploys/ui/constants.js`), plus the env/advice constants the web has in `features/envvars/ui/constants.js` and `features/advice/ui/constants.js` (`ENV_KINDS`, `ENV_SECRET_KINDS`, `kindLabel`, `TIER_LABEL`, `CONFIDENCE_LABEL`, `NEED_LABEL`, label helpers). A header comment names the web files these mirror.
- Produces (`src/envGroups.js`): `groupEnvVars(rows)`, `canContinue(rows)` with the web's semantics (done / unknown / need / optional; no row ever dropped; `canContinue` false iff a row has `required && status==='detected'`).
- Produces (`src/theme.js`): `lightColors`, `darkColors` objects with the same token names as `shared/ui/styles.css` (`bg`, `surface`, `surface2`, `border`, `text`, `muted`, `accent`, `accentText`, `ok`, `okBg`, `warn`, `warnBg`, `err`, `errBg`, `infoBg`, `termBg`, `termText`) and a `useColors()` hook returning the set for the current system color scheme; `spacing`/`radius` constants.

- [ ] **Step 1: Scaffold** with the official tool (verify the current command in the Expo docs; expected `npx create-expo-app@latest app --template blank`), install Expo Router and its peer packages per the docs, set `main` to `expo-router/entry`, add `jest-expo` and `@testing-library/react-native` as dev dependencies and a `test` script. Create the file layout (`app/app/_layout.js`, `app/app/index.js` placeholder) so `npx expo export --platform web` works.
- [ ] **Step 2: Write failing tests** (`src/__tests__/`): `api.test.js` — mock `global.fetch`: success JSON; 204 → null; error `{detail:"…"}` → thrown message equals the detail; 422 with `detail` array → messages joined by `, `; non-JSON error → `요청 실패 (500)`; `fetch` rejecting → `서버에 연결할 수 없습니다`; abort/timeout → same message; `deployApi.create` sends `branch:null`, `aws_account_id:null`, `github_installation_id:null` for empty values and the real values otherwise; `envApi.put` URL-encodes the name; `adviceApi.analyze` posts to `/api/deploys/advice` with null normalization. `constants.test.js` — `isProgress('needs_input')` is false, `isProgress('building')` true, `repoName`, `STATUS_LABEL.needs_input === '입력 필요'`, `showsEnvCard` true for `needs_input`/`running`, false for `queued`/`cloning`. `envGroups.test.js` — the web fixture rows group into `unknown:[MY_THING_URL]`, `need:[DATABASE_URL, LOG_LEVEL]`, `optional:[PAGE_SIZE]`, `done:[OLD_FLAG]`; `canContinue` false then true after skipping; unexpected status/kind rows never dropped; empty input → four empty groups.
- [ ] **Step 3: Run** `cd app && npx jest` — Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** `api.js`, `constants.js`, `envGroups.js`, `theme.js`, `.env.example`, `README.md`, `.gitignore` changes (copy semantics from the web files; do not import from outside `app/`).
- [ ] **Step 5: Run** `npx jest` — Expected: all pass; `npx expo export --platform web` — Expected: builds without errors.
- [ ] **Step 6: Commit** `feat(app): Expo 앱 뼈대, API 클라이언트, 상수, 테마`

---

### Task 2: Deploy list screen (S-02)

**Files:** Create/Modify: `app/app/_layout.js` (Stack, theme-aware header/status bar), `app/app/index.js` (list), `app/src/components/StatusBadge.js`, `app/src/hooks/usePolling.js`, `app/src/__tests__/usePolling.test.js` (+ a render test for the list)

**Interfaces:**
- Consumes: `deployApi.getAll`, `isProgress`, `repoName`, `STATUS_LABEL`, `useColors` (Task 1).
- Produces: `usePolling(fn, getDelayMs, deps)` — runs `fn` immediately then reschedules with `getDelayMs(result|error)`, uses an `alive` flag, clears the timer on unmount, pauses while `AppState` is not `active` and runs once on return to active; returns `{ data, error, loading, refresh }`. `StatusBadge({ status })` with tones: `running` ok, `failed` err, progress statuses accent (info), `needs_input` warn, others muted.

Behavior (copy from the web `DeployListPage`/`DeployForm` where applicable):
- Header title `배포`, a [＋ 새 배포] button (route `/new`, Task 3).
- Banner `문제 배너` only if a deploy has `status === 'failed'`: skip (no incident feature yet).
- List of cards: repo name, meta line `#d_id · branch · language · endpoint host` plus ` · 환경변수 {n}개 입력 필요` when `env_pending > 0`, `StatusBadge`; tap → `/deploys/{d_id}`. Pull-to-refresh. Polling 3 s when any deploy is in progress, else 15 s, error retry 10 s.
- States: loading spinner, empty (`아직 배포한 것이 없습니다.` + [＋ 새 배포]), error (`서버에 연결할 수 없습니다 :{message}` + [다시 시도]).

- [ ] **Step 1: Write failing tests** — `usePolling` with fake timers: immediate call, reschedule delay from the callback, no call after unmount, pause when AppState inactive (mock `AppState`), refresh() triggers a call; list render test with mocked `deployApi.getAll`: card text including `환경변수 2개 입력 필요`, empty state text, error state with retry.
- [ ] **Step 2: Run** `npx jest` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** the layout, list, badge, hook.
- [ ] **Step 4: Run** `npx jest` — Expected: pass. `npx expo export --platform web` — Expected: builds. Playwright check of the web export at 390×844 light and dark with `/api/**` mocked: list with 6 deploys (long names, a `needs_input` one with `env_pending:2`), empty and error states, pull-to-refresh not required on web; no horizontal overflow; screenshots to the system temp dir.
- [ ] **Step 5: Commit** `feat(app): 배포 목록 화면과 폴링 훅`

---

### Task 3: New deploy screen with two-step analysis (S-03, S-20)

**Files:** Create: `app/app/new.js`, `app/src/components/AdvicePanel.js`, `app/src/components/ConnectionPicker.js`, tests

**Interfaces:**
- Consumes: `accountApi.getConnections`, `accountApi.getGithubRepositories`, `deployApi.getRemote`, `adviceApi.analyze`, `deployApi.create`, advice constants, `useColors`.
- Produces: `AdvicePanel({ advice, busy, onDeploy, onReset })` (presentational, same content and copy as the web `features/advice/ui/AdvicePanel.jsx`: `분석 결과`, language + support badge, `앱 폴더` when non-empty and not `.`, `추천 수준: …`, `확신도 {label}` badge with the `추정입니다…` line for `low`, `왜 이렇게 추천했나`, cost sentence `아직 계산할 수 없습니다…` unless both min and max are finite numbers, `필요한 것` with unsupported items muted plus their `message`, `환경변수 {count}개 입력이 필요합니다`, collapsed `알 수 없었던 것`, buttons `이 레포로 배포` / `다른 레포로`, the read-only helper sentence). `ConnectionPicker({ connections, value, onChange })` — choose a connection block (read-only; none → `연결 안 함`, with the web's hint that private repos need a GitHub connection; managing connections is not in C1).

Behavior: GitHub URL input (+ repo picker list from the selected block's repositories, public/private tag), optional branch select via `getRemote`, button `분석` / `분석 중...`; the result panel below; `이 레포로 배포` → `deployApi.create` → navigate to `/deploys/{d_id}` (replace). Any change to URL/branch/connection clears the analysis; a request-id ref drops late analyze responses; second tap while busy ignored; errors as a red notice with the server `detail`; keyboard-safe layout (`KeyboardAvoidingView`/scroll).

- [ ] **Step 1: Write failing tests** (mock API modules): analyze called with `branch:null` when none chosen; panel shows `보통`-tier fixture content from the web fixture (`tier:"medium"`, null cost → sentence, unsupported database need muted with message, `환경변수 4개 입력이 필요합니다`, unknowns collapsed, `앱 폴더: backend` for `app_dir:"backend"`, nothing for `.`); low confidence shows `추정입니다`; editing the URL clears the panel; a late analyze response after an edit is ignored; double tap sends one request; 400 error shows its detail and no panel; `이 레포로 배포` calls create with the analyzed inputs and navigates.
- [ ] **Step 2: Run** `npx jest` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** the screen and components.
- [ ] **Step 4: Run** `npx jest` — Expected: pass; export builds; Playwright check (390×844 light/dark, mocked API) of: analyze success, low confidence, 400 error, empty reasons/needs/unknowns, long reason text; no overflow.
- [ ] **Step 5: Commit** `feat(app): 새 배포 화면과 배포 전 분석 두 단계`

---

### Task 4: Deploy detail screen (S-04..S-07, S-16)

**Files:** Create: `app/app/deploys/[d_id].js`, `app/src/components/StepProgress.js`, `LogTerminal.js`, `ExplainCard.js`, `IssueHistory.js`, `ConfirmDialog` helper (use the platform alert API per the Expo/RN docs, safe option first), tests

**Interfaces:**
- Consumes: `deployApi.*`, `usePolling`, `StatusBadge`, constants (`STEPS`, `isProgress`, `showsEnvCard`), `useColors`.
- Produces: `StepProgress({ status, errorStep })` — steps up to `pushing` done and `deploying` shown as waiting for `needs_input` (same as the web); `LogTerminal({ logs })` — FlatList of at most the last 500 lines, monospace, level colors (`cmd` accent, `warn` warn, `error` err), auto-scroll only when already at the bottom; `ExplainCard({ explain, errorStep, errorMsg, hasResources, busy, onRedeploy, onCleanup })` — summary, cause, numbered actions, raw error, buttons `다시 배포`, `만들어진 리소스 정리` (if resources), note `아무것도 누르지 않으면 그대로 둡니다. 자동으로 지우지 않습니다.`; `IssueHistory({ issues })` collapsed.

Behavior (same rules as the web `DeployDetailPage`): header (repo name, `#id · branch · commit7 · language · app_dir`, experimental and fix-count badges, status badge); step progress; running → endpoint card (tap opens in the browser via Linking, long-press/button copies via `expo-clipboard`, health badge `응답 정상/응답 없음/확인 전`, the running-cost sentence); stopped → `멈춘 상태입니다.` card with `다시 켜기`; failed → ExplainCard; `needs_input` → info notice `환경변수 입력이 필요합니다. 아래에서 값을 입력하거나 건너뛴 뒤 [이어서 배포]를 누르세요.` (the env card itself is Task 5); log terminal; Dockerfile section (collapsed, horizontally scrollable); issue history; action buttons: `다시 배포` (not for `needs_input`/`stopped`/in-progress), `멈춤` (running only), `삭제` — stop and delete behind a confirmation with the web's exact copy (`이 배포를 멈출까요?` / `이 배포를 삭제할까요?` bodies from the web dialogs, buttons `그대로 두기` first, destructive second). Polling per the Global Constraints (1.5 s while in progress or logs arriving; a `round` counter restarts polling after redeploy/start/continue); health fetched once when status becomes `running`. Errors from actions shown as a red notice; buttons disabled while busy.

- [ ] **Step 1: Write failing tests** (mock API): running deploy shows endpoint card and health badge; failed shows ExplainCard with exact summary/cause/actions and the two buttons; `needs_input` shows the info notice, StepProgress waiting state, and hides `다시 배포`/`멈춤` but keeps `삭제`; stopped shows `다시 켜기`; stop/delete require confirmation and call the API only on confirm; polling stops for `running` after logs stop arriving and restarts after `round` changes; logs capped at 500 lines; action error is shown and busy resets.
- [ ] **Step 2: Run** `npx jest` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** the screen and components.
- [ ] **Step 4: Run** `npx jest` — Expected: pass; export builds; Playwright check (390×844 light/dark, mocked API: running with a 60-char endpoint, failed with a long `error_msg` and 3 actions, `needs_input`, stopped, a log-heavy deploy with 400 lines of 120 chars); no horizontal overflow on the page (the terminal/Dockerfile may scroll inside their box).
- [ ] **Step 5: Commit** `feat(app): 배포 상세 화면 (진행·로그·해설·동작)`

---

### Task 5: Env-var card (S-19)

**Files:** Create: `app/src/components/EnvVarsCard.js`, `app/src/components/EnvRow.js`; Modify: `app/app/deploys/[d_id].js`; tests

**Interfaces:**
- Consumes: `envApi`, `groupEnvVars`, `canContinue`, `ENV_KINDS`, `ENV_SECRET_KINDS`, `kindLabel`, `isProgress`.
- Produces: `EnvVarsCard({ deploy, onContinued, onRedeploy })` — behavior and copy identical to the web `features/envvars/ui/EnvVarsCard.jsx` as it stands on branch `test` (read it): nothing rendered when there are no rows and the status is not `needs_input`; the intro and the always-visible "자동으로 찾지 못한 변수가 있을 수 있습니다…" warning; groups `꼭 필요해 보이는 것`, `종류를 모르는 것`, `기본값이 있어 비워도 되는 것` (collapsed), `입력 완료` (collapsed); unknown-kind rows offer the five `ENV_KINDS` buttons plus `건너뛰기`; any kind outside `ENV_KINDS` is treated as `unknown`; config rows have a text input (max 2000, no autocomplete), `저장` (clears the input only after the PUT succeeds) and `건너뛰기`; secret-kind rows have NO input, the text `이 종류의 값은 아직 저장할 수 없습니다. 지금은 건너뛰기만 됩니다.` and only `건너뛰기`; done rows show `입력됨`/`건너뜀`, `값 지우기`, `건너뛰기 취소`; `변수 직접 추가` (name pattern `^[A-Za-z_][A-Za-z0-9_]{0,99}$`, duplicate name → `이미 목록에 있는 변수입니다` and no request); footer `이어서 배포` disabled with `필수 환경변수에 값이 없습니다` until `canContinue`; a 409 shows its `detail` and keeps typed text; `needs_redeploy:true` shows `다시 배포해야 적용됩니다` (the `다시 배포` button only while `!isProgress(status)`); accessible labels include the variable name (`${name} 저장`, …). The card loads its own rows when mounted and whenever the deploy status changes (polling stops at `needs_input`); `onContinued` bumps the detail screen's `round`.

- [ ] **Step 1: Write failing tests** (mock `envApi`): fixture rows from the web fixtures group correctly; typing a value + `저장` sends `put {value}` and clears the input only on success (and keeps it on failure); secret-kind rows render no TextInput and only `건너뛰기`; unknown row → kind button sends `put {kind}`, `건너뛰기` sends `put {skip:true}`; made-up kind → kind picker, no input; duplicate manual add shows the message and sends nothing; footer disabled until all required rows are set/skipped; 409 from continue shows its detail and typed text stays; continue success calls `onContinued`; `needs_redeploy:true` shows the banner and hides the redeploy button while in progress; the value string never appears in any rendered text after a save.
- [ ] **Step 2: Run** `npx jest` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** the card/row components and mount the card in the detail screen below the header card.
- [ ] **Step 4: Run** `npx jest` — Expected: pass; export builds; Playwright check (390×844 light/dark, mocked API per `needs_input` fixtures: 409 first then 200 for continue; 501 never reachable) of the full flow: set a config value, skip the rest, continue; no overflow, long names and hints wrap.
- [ ] **Step 5: Commit** `feat(app): 환경변수 입력 카드와 입력 대기 처리`

---

### Task 6: Cross-check, docs, final run

**Files:** Modify: `app/README.md`, `docs/app-web/README.md` (구현 상태), `docs/features.md` (one line: the app exists, scope of C1), `HISTORY.md` (one row, terse English), `docs/worklog/2026-11-09.md` (append, terse English), `docs/ui-spec.md` (a short "앱" pointer section)

- [ ] **Step 1:** Run the whole flow once on the web export at 390×844 dark and light with the mocks: list → new deploy → analyze → deploy → detail (`needs_input`) → set/skip → continue; check no console errors beyond intended mocked noise, no horizontal overflow, tap targets ≥ 44 pt.
- [ ] **Step 2:** `cd app && npx jest` (all pass), `npx expo export --platform web` (builds), repo root `npm run build` and `.venv/Scripts/python.exe -m pytest -q` (unchanged: all pass).
- [ ] **Step 3:** Write the docs. State plainly: not run on a real device or emulator; no connection management, push, login or store build in C1; copy and constants are duplicated from the web (list the web files) so changes to either side must be mirrored; known gaps from the review ledgers.
- [ ] **Step 4: Commit** `docs(app): Expo 앱 설명과 작업 기록`

---

## Self-review

- **Spec coverage:** C-01..C-12 core (list, new deploy two-step, detail, logs, explanation, history, redeploy/stop/start/delete), H (env input), I (analysis) — yes. Deliberately NOT in C1: connection management and the connect flows (B-01..B-07; in-app browser + deep links), notifications/push (E), incidents (D), login (A), settings, store build/EAS. Follow-up plan C2 covers connections; push/incidents/login arrive with their backend phases.
- **Types/names:** `usePolling`, `StatusBadge`, `AdvicePanel`, `ConnectionPicker`, `StepProgress`, `LogTerminal`, `ExplainCard`, `IssueHistory`, `EnvVarsCard`, `EnvRow`, `groupEnvVars`, `canContinue` are defined where first produced and used consistently.
- **Known risks (intended):** Expo/React Native APIs must be checked against current docs by the implementer; web-export rendering (react-native-web) is only a proxy for native behavior; duplicated constants can drift from the web.
