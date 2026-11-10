# Expo App Incidents and Notifications (Plan D2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Expo app (`app/`) shows what the backend of Plan D1 produces: an incident detail screen (S-13) with cause, where to fix, the timeline of what the wizard did and a 24-hour health bar; a problem banner and health dots on the deploy list/detail (S-02/S-04); per-deploy switches for auto-redeploy and auto-recovery (S-14); the in-app notification list with an unread badge (S-12); notification settings (S-15, without login); and push: permission explanation (S-17), device token registration, and tapping a notification opens the right screen.

**Architecture:** New routes under `app/app/`: `incidents/[i_id].js`, `notifications.js`, `notification-settings.js`, `deploy-settings/[d_id].js` (a separate folder so the existing `deploys/[d_id].js` is untouched). Pure logic (labels, link parsing, token/device storage rules) in small tested modules under `app/src/ops/`; components under `app/src/components/ops/`. Data comes from the endpoints of Plan D1 (`docs/api-spec.md`: Health/Incidents/Notifications/Devices/Settings), polled with the existing `usePolling`. Push uses `expo-notifications` (installed with `npx expo install`); `deploywizard://incidents/{i_id}` links are handled by Expo Router itself, the tap handler only routes `data.link`.

**Tech Stack:** Same as Plans C1/C2 (Expo SDK 58, Expo Router, plain JS, jest-expo + @testing-library/react-native, `@react-native-async-storage/async-storage`) plus `expo-notifications` and `expo-device` if the docs require it. Verify every Expo/React Native API against the current official docs (WebFetch `https://docs.expo.dev`) before using it; never invent an API or option.

**Spec:** `docs/app-web/02-feature-spec.md` (D-07..D-09, E-02..E-06, F-01, F-02), `docs/app-web/06-screens.md` (S-02, S-04, S-12, S-13, S-14, S-15, S-17), `docs/api-spec.md` (the BUILT contract of Plan D1 — read its Incidents/Notifications/Devices/Settings sections first), design flowcharts 4 and 8 in `docs/app-web/05-flowcharts.md`. Builds on C1/C2 (merged in `test`) and D1 (merged in `test`).

## Global Constraints

- Language: UI copy Korean (screens file S-12..S-17 and `docs/app-web/04-api-spec.md` §7 for push/mail wording), code comments Korean one-liners above components/functions, identifiers English; HISTORY/worklog terse English. C1/C2 conventions apply: colors only via `useColors`/theme, `monoFont` for code-like text, tap targets ≥ 44 pt, `confirmAction` with the safe option first, block/deploy name in every accessibilityLabel of repeated buttons, `alive` refs set true in the effect body, late responses dropped, `usePolling`/`request` from C1, scroll-to-top on action error/notice like the accounts screen.
- Server field names unchanged (`i_id`, `d_id`, `n_id`, `p_d_id`, `explain.fix_where`, `health_state`, `open_incident_id`, `auto_recover`, …); statuses/kinds defined once in `app/src/ops/constants.js` and identical to the backend (`incident.status`: `open|recovering|resolved|needs_action`; kinds `unhealthy|crash_loop|bad_release|unknown`; notification kinds `incident_opened|incident_recovered|incident_needs_action|deploy_succeeded|deploy_failed|new_commit`).
- Hard rule 3: the app never performs automatic actions; every change is a user-pressed button; destructive ones (stop, delete) behind a confirmation with the safe option first (reuse the C1 confirmations/copy). Incident screens show what the wizard did automatically (restart/rollback) as read-only history. Hard rule 6: no tokens in logs; the Expo push token is sent only to `POST /api/devices`, never shown (show at most its last 6 characters), never stored in plain screens/URLs; `explain` text is rendered as text only.
- Push: the permission request is explained first (S-17 copy) and asked only after the user taps a button — never on app start; no token registration without permission; the EAS project id is read from app config (`Constants.expoConfig.extra.eas.projectId`); if absent the app shows a Korean notice that push needs the store-build preparation (EAS project link) and the rest of the app keeps working. Push needs a development build / real device on Android (Expo Go limits) — state this plainly in the README, never claim it works.
- The app talks to the existing API only; backend, web, `shared/`, `features/`, `tests/`, root package files are NOT changed. Server stays local without auth (phase 1): `u_id` is null everywhere.
- Keyboard/safe area/scroll patterns as in C1/C2.
- Git: branch `feat/expo-app-ops` from `test`; Conventional Commits, Korean body, end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; never push.
- Verification (no device here): `npx jest`, `npx expo export --platform web`, Playwright MCP on the web export at 390×844 light + dark with `/api/**` mocked (`page.route`); push/permission/token paths are covered by jest with mocked `expo-notifications` only. State plainly that nothing ran on a real device/emulator, against the real backend, AWS, SMTP or the Expo push service. Stop only processes you started (by PID); never by process name; no `.playwright-mcp/` left in the repo; screenshots only under the system temp directory. Never run two test runners at once.

## Review Focus

- Incident detail: `explain` may be null/partial/unreadable; `actions[]` empty; very long `fix_where`/ARNs wrap at 390 pt; a `recovering` incident keeps updating (polling stops when `resolved`/`needs_action`, pauses in background, no timers after unmount); the user's buttons on `needs_action` (다시 배포, 멈춤, 그대로 두기) use the existing confirmed actions and refresh the screen; deleted deploy → Korean message, not a crash.
- Notifications: unread badge accuracy after read/read-all (optimistic update rolled back on failure), double-tap guards, deep links to deleted deploys/incidents (404 → Korean message with a way back), list pagination via `after` cursor without duplicates.
- Push: never asks on start; denial handled (settings explains how to enable in the OS settings); token registration idempotent (same token → one device), unregistration on turning push off, stored `p_d_id` survives restarts; tap handler works for cold start and foreground with `data.link` validation (only `deploywizard://deploys/{n}` and `deploywizard://incidents/{n}` are routed; anything else ignored — no open-redirect/arbitrary route injection).
- Settings: toggles show the saved state, change applies immediately with rollback on error, kinds list matches the backend, the mail switch explains that mail only works when the server has mail configured.
- Network failure/unreachable server on every new screen (message + retry), long strings, keyboard/safe-area, dark mode contrast of the new status colors.

---

### Task 1: API client, constants, labels, link parser, unread hook

**Files:**
- Modify: `app/src/api.js` (extend), `app/src/constants.js` only if shared labels belong there (prefer the new module)
- Create: `app/src/ops/constants.js`, `app/src/ops/links.js`, `app/src/ops/format.js`, `app/src/hooks/useUnreadCount.js`
- Test: `app/src/__tests__/opsApi.test.js`, `opsLogic.test.js`, `useUnreadCount.test.js`

**Interfaces:**
- Produces API objects, each method 1:1 with the endpoint in `docs/api-spec.md`: `incidentApi`: `getAll({status, d_id, after})`, `getOne(i_id)`, `getForDeploy(d_id)`; `healthApi`: `getHistory(d_id, hours)`; `notificationApi`: `getAll({after, unread})`, `getUnreadCount()`, `read(n_id)`, `readAll()`, `getSettings()`, `patchSettings(body)`; `deviceApi`: `register({expo_token, platform})`, `remove(p_d_id)`; `deployApi.patchSettings(d_id, body)`.
- Produces `ops/constants.js`: `INCIDENT_STATUS_LABEL` (open 감지됨 / recovering 복구 중 / resolved 해결됨 / needs_action 확인 필요 — take exact words from `06-screens.md`/web-doc wording where it exists), `INCIDENT_STATUS_TONE`, `INCIDENT_KIND_LABEL`, `NOTIFICATION_KIND_LABEL` (+ icon glyph), `RECOVERY_ACTION_LABEL` (재시작 / 이전 버전으로 되돌리기), `RECOVERY_RESULT_LABEL`, `HEALTH_STATE_LABEL`; `ops/links.js`: `parseAppLink(url) -> {route, params} | null` accepting ONLY `deploywizard://deploys/{positive int}` and `deploywizard://incidents/{positive int}` (also the same as already-parsed Expo Router paths `/deploys/7`, `/incidents/7`), else null; `ops/format.js`: `formatTime(iso)`, `durationText(a, b)`, `incidentTimeline(incident) -> [{key, time, title, detail, tone}]` (detected → each action start/result → resolved/needs_action; order by time, ties by order of creation; masked detail shown as-is).
- Produces `useUnreadCount()` → `{ count, refresh }` using `usePolling` (30 s, paused in background, `count` 0 on error, no toast).

- [ ] **Step 1: Write failing tests** — every API method hits the exact URL/method/body (`after`/`unread` query encoding, `readAll` POST, `deviceApi.remove` DELETE), `parseAppLink` table (valid deploys/incidents, uppercase scheme, `javascript:`, other hosts/paths, `incidents/0`, `incidents/-1`, `incidents/1abc`, `deploywizard://accounts?connected=github` → null since it is handled elsewhere, long numbers), labels cover every backend status/kind (iterate the lists in `docs/api-spec.md` values), `incidentTimeline` with 0/1/2 actions and unresolved vs resolved incidents, `useUnreadCount` (poll cadence with fake timers, pause in background, error → 0).
- [ ] **Step 2: Run to confirm fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `cd app && npx jest` → all pass.**
- [ ] **Step 5: Commit** `feat(app): 운영 API·라벨·링크 해석·안 읽은 수 훅`

---

### Task 2: Incident detail, health bar, banner and cards on list/detail

**Files:**
- Create: `app/app/incidents/[i_id].js`, `app/src/components/ops/{HealthBar,IncidentTimeline,IncidentCard,ProblemBanner,HealthDot}.js`
- Modify: `app/app/index.js` (ProblemBanner for deploys with `open_incident_id`; HealthDot on cards), `app/app/deploys/[d_id].js` (IncidentCard when `open_incident_id`; HealthDot next to the health badge) — minimal edits, the file is already long: extract any new JSX into the components
- Test: `app/src/__tests__/IncidentDetail.test.js`, `OpsComponents.test.js`, `DeployList.test.js` (banner/dot), `DeployDetail.test.js` (card)

**Interfaces:**
- Consumes Task 1 modules and `usePolling`, `confirmAction`, `deployApi` actions used by the detail screen (redeploy/stop with the existing confirmations).
- `IncidentDetail` (S-13): status badge, one-line summary, `원인` (explain.cause), `고칠 곳` (explain.fix_where, monospace, selectable + `복사` using the C2 clipboard pattern), `actions` list from `explain.actions`, `마법사가 한 일` timeline, `HealthBar` (24 h from `healthApi.getHistory(d_id, 24)`), buttons: `needs_action` → `다시 배포` `멈춤` `그대로 두기` (the last just goes back), others → `배포 보기`. Polls every 5 s while `open`/`recovering`, stops when `resolved`/`needs_action`; refresh on focus. `explain` null → the default guidance text from the web doc (`아직 원인을 확인하지 못했습니다`) and no crash.
- `HealthBar({ checks })`: ≤ 96 slots (bucket 24 h into 15-min cells), ok green / failed red / none grey, accessible summary `최근 24시간 정상 N%`.
- `ProblemBanner` copy: `{서비스 이름}에 문제가 있습니다 · {자동 복구 중|확인이 필요합니다}` → opens the incident.

- [ ] **Step 1: Write failing tests** — null/partial `explain`, empty `actions`, long `fix_where` renders and copies, timeline order, polling stops on `resolved`, unmount stops timers, 404 → Korean message + back button, `needs_action` buttons call the confirmed actions (cancel sends nothing) and reload; HealthBar bucket math (empty, all ok, mixed, gaps) and a11y label; list banner appears only for `open_incident_id`, tap navigates to `/incidents/{id}`; detail card likewise.
- [ ] **Step 2: Run to confirm fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npx jest` + `npx expo export --platform web`.**
- [ ] **Step 5: Commit** `feat(app): 인시던트 상세·헬스 막대·문제 배너`

---

### Task 3: Deploy settings (auto-redeploy / auto-recover switches)

**Files:**
- Create: `app/app/deploy-settings/[d_id].js`
- Modify: `app/app/deploys/[d_id].js` (a `설정` button next to the action row; small edit)
- Test: `app/src/__tests__/DeploySettings.test.js`

**Interfaces:**
- `DeploySettings` (S-14): two `Switch` rows — `새 커밋이 오면 자동 재배포` (`auto_redeploy`), `문제가 생기면 자동 복구` (`auto_recover`) with the one-line explanations from `06-screens.md` ("자동 복구는 재시작과 이전 버전으로 되돌리기만 합니다"); changes apply immediately via `deployApi.patchSettings(d_id, { field: value })` (only the changed field), optimistic with rollback + Korean error on failure, per-switch busy lock, a toast-like `Notice` on success. Loads `deployApi.getOne(d_id)` for the initial values; 404 → Korean message.

- [ ] **Step 1: Write failing tests** — initial values, only the changed field is sent, failure rolls back and shows the server message, double toggle while busy sends one request, unmount safety, 404 state.
- [ ] **Step 2: Run to confirm fail.** **Step 3: Implement.** **Step 4: `npx jest` + export.**
- [ ] **Step 5: Commit** `feat(app): 배포 설정 (자동 재배포·자동 복구 스위치)`

---

### Task 4: Notification list and unread badge

**Files:**
- Create: `app/app/notifications.js`, `app/src/components/ops/NotificationItem.js`
- Modify: `app/app/index.js` (header: bell button with unread badge using `useUnreadCount`, navigates to `/notifications`; keep the existing `계정 연결` and `＋ 새 배포` buttons reachable at 390 pt — move secondary buttons into a compact header group or a second row if they no longer fit)
- Test: `app/src/__tests__/Notifications.test.js`, `DeployList.test.js` (badge/header)

**Interfaces:**
- `Notifications` (S-12): list via `notificationApi.getAll({unread?})` with an `after` cursor ("더 보기" button, no duplicates), unread rows bold with a dot, row = icon (kind), title, one-line body, time; tap → `notificationApi.read(n_id)` (optimistic) then navigate by kind: incident kinds → `/incidents/{i_id}`, deploy kinds → `/deploys/{d_id}` (rows without the needed id only mark read); `모두 읽음` → `readAll()` with rollback on failure; empty state `새 알림이 없습니다`; pull-to-refresh; error + retry; unread badge on the list header refreshes on focus and after reads.

- [ ] **Step 1: Write failing tests** — render states, optimistic read + rollback on failure, read-all, navigation targets per kind, cursor pagination without duplicates, double-tap guard, header badge shows count (99+ cap) and hides at 0, header buttons keep ≥ 44 pt.
- [ ] **Step 2: Run to confirm fail.** **Step 3: Implement.** **Step 4: `npx jest` + export.**
- [ ] **Step 5: Commit** `feat(app): 알림 목록과 안 읽은 수 배지`

---

### Task 5: Push — permission guide, token registration, notification taps, notification settings

**Files:**
- Create: `app/app/notification-settings.js`, `app/src/ops/push.js` (pure + thin wrappers around `expo-notifications`), `app/src/hooks/usePushSetup.js`, `app/src/components/ops/PushPermissionGuide.js`
- Modify: `app/package.json` (+ lockfile via `npx expo install expo-notifications` and anything the docs say is required), `app/app.json` (expo-notifications config plugin only as the docs require; no secrets, no project id values invented), `app/app/_layout.js` (foreground handler + response listener → `parseAppLink` → `router.push`), `app/jest.setup.js` (mock `expo-notifications`), `app/app/index.js` (entry button `알림 설정` — compact), `app/README.md`
- Test: `app/src/__tests__/push.test.js`, `PushSetup.test.js`, `NotificationSettings.test.js`, `Layout.test.js` (tap routing)

**Interfaces:**
- `push.js`: `getPushState()` → `'unsupported'|'no_project'|'denied'|'undetermined'|'granted'`, `requestAndRegister()` (asks permission ONLY when called from a button; gets the Expo token with the EAS project id from config; `deviceApi.register({expo_token, platform: Platform.OS})`; stores `p_d_id` in AsyncStorage key `dw-push-device`; returns the new state; never logs or returns the token), `unregister()` (`deviceApi.remove(stored p_d_id)`, clears storage, tolerates 404/offline), `routeFromNotification(response)` → `parseAppLink(response.notification.request.content.data?.link)`.
- `PushPermissionGuide` (S-17): explanation text first ("문제가 생겼을 때 바로 알려드리려고 알림 권한이 필요합니다 …" — planner's copy, mark app-only), buttons `알림 켜기` / `나중에`; denied → text explaining how to enable it in the OS settings (+ `설정 열기` via `Linking.openSettings()`); `no_project` → notice that push needs the store-build preparation (EAS project link); `unsupported` (web/simulator) → hidden or an info line.
- `notification-settings.js` (S-15 without login): switches `메일 받기` (with the hint `서버에 메일 설정이 있을 때만 보내집니다`), `푸시 받기` (turning on runs `PushPermissionGuide`/`requestAndRegister`; turning off runs `unregister` and PATCHes `notify_push=false`), per-kind switches for the six kinds, immediate apply with rollback on error through `notificationApi.patchSettings`.
- Layout: `Notifications.setNotificationHandler` (show alert/banner/list, no sound unless the docs require, per SDK 58 API), response listener (cold start via `getLastNotificationResponse`) routes ONLY links accepted by `parseAppLink`; everything else ignored. First-run prompt (F-01) is limited to a one-time card on the deploy detail screen when the deploy becomes `running` and push state is `undetermined` — a button, never an automatic OS prompt; remember dismissal in AsyncStorage.

- [ ] **Step 1: Write failing tests** with a mocked `expo-notifications` — permission is requested only via the button handler (assert not called on mount/app start); denied/undetermined/granted/no_project states; registration sends `{expo_token, platform}` once and stores `p_d_id`; second call is idempotent; `unregister` tolerates 404 and clears storage; token never in rendered tree, logs (`console.*` spy) or error text; tap routing table (valid incident/deploy links, invalid/other-scheme/`data` missing/`link` non-string → ignored, cold start path); settings toggles apply/rollback; one-time card shows only when `running` + `undetermined` and not dismissed.
- [ ] **Step 2: Run to confirm fail.** **Step 3: Implement** (verify every `expo-notifications` API name/option for SDK 58 in the docs first). **Step 4: `npx jest` + export.**
- [ ] **Step 5: Commit** `feat(app): 푸시 권한 안내·토큰 등록·알림 탭 이동·알림 설정`

---

### Task 6: Docs, browser cross-check, final run

**Files:**
- Modify: `app/README.md` (screens table; push needs a development build/real device, EAS project id, what is verified / NOT verified), `docs/ui-spec.md` ("앱" section: incident/notification/settings screens, deviations from the web (there is no web version yet), platform notes), `docs/app-web/README.md` (D2 status; remaining: web incident/notification screens, login, store build, operations agent), `docs/features.md` (one line), `HISTORY.md` (ONE new row; keep the single pre-existing NUL byte — edit as bytes), `docs/worklog/2026-11-10.md` (append, terse English)
- Verification run: Playwright at 390×844 dark then light with `/api/**` mocked: list with a problem banner → incident detail (`recovering` → `resolved` via changing mock) → `needs_action` variant with buttons (cancel = 0 requests) → notifications list (unread bold, read, read-all, badge) → deploy settings switches → notification settings (push row shows `no_project` notice on web) → back to list; `scrollWidth <= innerWidth` on each page, tap targets ≥ 44, console only intended mocked noise.

- [ ] **Step 1:** Run the browser flow; record numbers. **Step 2:** Write docs; run `npx jest`, `npx expo export --platform web`, repo `npm run build`, `.venv/Scripts/python.exe -m pytest -q` (one runner at a time; expect backend 530 passed, 2 skipped).
- [ ] **Step 3: Commit** `docs(app): 인시던트·알림 화면 설명과 작업 기록`

---

## Self-review

- **Coverage:** D-07 (T2), D-08 (T2 HealthBar), D-09 (T3), E-02 client side (T5), E-03 (T4), E-04 (T5), E-05 (T5), E-06 (T5 + Expo Router), F-01 (T5 one-time card), F-02 (T1 parser + T5 routing); S-02/S-04 additions (T2), S-12 (T4), S-13 (T2), S-14 (T3), S-15 notification part (T5), S-17 (T5).
- **Not in this plan:** web screens for incidents/notifications (web parity, next plan), login/Google, offline cache (F-04), biometric lock (F-03), store build/EAS credentials, operations agent, mail templates (server).
- **Unverified by design:** real push delivery and tap handling on devices, permission dialogs, Android Expo Go limits, EAS project id handling; everything is mock-tested only.
- **Type consistency:** `parseAppLink` (T1) used by T5; `useUnreadCount` (T1) used by T4; `incidentTimeline` (T1) used by T2; labels defined once in `ops/constants.js`.
