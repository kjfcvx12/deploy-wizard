# Expo App Account Connections (Plan C2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Expo app (`app/`) gets the web's account-connection screen (S-08..S-11, features B-01..B-07): connection blocks (one AWS account + one GitHub installation each), connecting AWS through the 7-step CloudFormation guide, connecting GitHub through the GitHub App install page, re-verifying, stack-update notice, template-file cleanup, releasing and deleting — plus the "picked block" that the new-deploy screen pre-selects.

**Architecture:** One new route `/accounts` (`app/app/accounts.js`) reached from a header button on the list screen. Logic lives in small modules (`src/accounts/*.js`: status labels, delete texts, notice builders, picked-block storage) that are unit-tested; UI is split into components (`BlockCard`, `AwsBox`, `GithubBox`, `AwsGuide`, `AwsUpdateGuide`, `ExistingPicker`) under `app/src/components/accounts/`. External pages (AWS console, GitHub install, template download) open with `Linking.openURL`; the screen reloads when the app returns to the foreground — there is no deep-link return and no backend change (the server's GitHub callback redirect to `/accounts?connected=github` is ignored by the app). The web behaviors and Korean copy are the reference: `features/accounts/ui/AccountsPage.jsx`, `AccountBox.jsx`, `AwsStackGuide.jsx`, `AwsStackUpdateGuide.jsx`, `ConnectGuidePage.jsx`, `pickedBlock.js`.

**Tech Stack:** Same as Plan C1 (Expo SDK 58, Expo Router, plain JS, jest-expo + @testing-library/react-native, `expo-clipboard`, `Linking`) plus `@react-native-async-storage/async-storage` (installed with `npx expo install`; used only for the picked block id). Verify every Expo/React Native API against the official docs before using it; never invent an API or option.

**Spec:** `docs/app-web/02-feature-spec.md` (B-01..B-07), `docs/app-web/06-screens.md` (S-08..S-11), `docs/api-spec.md` ("Accounts" — the built contract, response shapes included), web reference files above. Builds on Plan C1 (`docs/superpowers/plans/2026-11-09-expo-app-core.md`, merged in `test`).

## Global Constraints

- Language: UI copy Korean and identical to the web where the web has copy (copy it from the web files, do not paraphrase); code comments Korean one-liners above components/functions; identifiers English; saved records (HISTORY/worklog) terse English. Existing C1 conventions apply (colors only via `useColors`, `monoFont` for code-like text, tap targets ≥ 44 pt, `confirmAction` with the safe option first, `usePolling`/`request` from C1).
- Server field names unchanged (`c_id`, `a_id`, `g_id`, `external_id`, `role_arn`, `aws_account_id`, `template_file_count`, …). Responses are `Connection_Read`, `Aws_Account_Read`, `Github_Installation_Read`, `Aws_Account_Setup`, `Aws_Account_Template_Status`, `Github_Installation_Check` exactly as in `docs/api-spec.md`.
- Hard rule 3: every change is a user-pressed button; blocks/AWS releases/template-file deletion go through a confirmation with the safe option first and the same body text as the web (`DELETE_TEXT`, cleanup dialog). Nothing is deleted in the user's AWS account by the app — the texts say so.
- Hard rule 6 / secrets: `external_id` exists only in the `Aws_Account_Setup` response; keep it in component state while the guide is open, never in a URL, route param, storage, log, error text or accessibility label. Role ARN input is a normal TextInput (not secret) but is never logged. The picked block stores only the `c_id` number.
- External URLs (`stack_create_url`, `template_download_url` resolved against the API base, GitHub install `url`) are opened only if they start with `https://` (or, for the template download which is served by the API itself, the API base URL); otherwise show `주소를 열 수 없습니다`.
- The app talks to the existing API only. Backend, web, `shared/`, `features/`, `tests/` and root package files are NOT changed. Server stays local without auth (phase 1).
- Keyboard and safe area: follow the C1 screens (KeyboardAvoidingView wrapper, `keyboardShouldPersistTaps="handled"`, bottom inset padding).
- Git: branch `feat/expo-app-accounts` from `test`; Conventional Commits, Korean body, end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; never push.
- Verification (no device here): `npx jest`, `npx expo export --platform web`, and a Playwright MCP check of the web export at 390×844 light + dark with `/api/**` mocked (`page.route`). State plainly that nothing ran on a real device/emulator, against the real backend, AWS or GitHub. Stop only processes you started (by PID); never by process name; no `.playwright-mcp/` left in the repo; screenshots only under the system temp directory.

## Rulings (planner)

- Blocks are shown as a vertical list of cards (phone-natural) instead of the web's one-block-at-a-time pager with arrows; each card still has `선택` (picked block).
- The web's arrows that flip through several connected accounts inside a box are replaced by `ExistingPicker`: a button `이미 연결한 계정에서 고르기` opens a list of the accounts/installations from `GET /aws` / `GET /github` that this block does not use; tapping one calls `PATCH /connections/{c_id}`.
- No deep link back from GitHub: after `Linking.openURL(install url)` the screen shows a hint and reloads when the app becomes active again (AppState) and via a `새로고침` pull/button.
- Picked-block storage is async (`AsyncStorage`); readers handle failure like the web's try/catch (null).

## Review Focus

- `external_id` never leaks (state cleared when the guide closes, not in URLs/logs/storage/error text); Role ARN trimmed; double-tap guards (`busy`) on every action; late responses dropped after navigation/unmount.
- Destructive actions confirm first and say the AWS stack / GitHub app install is not removed; `연결 해제` logic matches the web (`releaseAws`: other blocks share → just detach, else confirm + delete).
- External URL scheme check (only `https`); `503` from install-url (`GITHUB_APP_SLUG` unset) and `409` (AWS already connected) shown as the server's Korean message, not a crash.
- Network failure / server unreachable on load and on every action (message + retry, buttons unlocked); empty states (no blocks).
- Long ARNs/ids/labels at 390 pt wrap; keyboard does not cover the ARN input; safe-area padding.
- Returning from the browser: reload happens once per foreground, no polling timers left running after unmount.

---

### Task 1: API client, account logic modules, picked-block storage

**Files:**
- Modify: `app/src/api.js` (extend `accountApi`), `app/package.json` (+ lockfile via `npx expo install @react-native-async-storage/async-storage`), `app/jest.setup.js` (official async-storage jest mock)
- Create: `app/src/accounts/constants.js`, `app/src/accounts/notices.js`, `app/src/accounts/pickedBlock.js`
- Test: `app/src/__tests__/accountsApi.test.js`, `accountsLogic.test.js`, `pickedBlock.test.js`

**Interfaces:**
- Produces `accountApi` methods, each 1:1 with `features/accounts/ui/api.js` (same names): `getConnections, createConnection(label), createConnectionAws(c_id), setConnectionAws(c_id, aws_account_id), setConnectionGithub(c_id, github_installation_id), deleteConnection(c_id), listAws(), createAws(label, region), attachRole(a_id, role_arn), reverifyAws(a_id), getTemplateStatus(a_id), deleteTemplateFiles(a_id), deleteAws(a_id), listGithub(), getGithubInstallUrl(c_id), getGithubRepositories(g_id), checkGithub(g_id), deleteGithub(g_id)`. Existing `getConnections`/`getGithubRepositories` keep working.
- Produces `constants.js`: `AWS_STATUS_LABEL`, `GITHUB_STATUS_LABEL`, `DELETE_TEXT` (block/aws) — values copied verbatim from `AccountsPage.jsx`; `isHttps(url)`.
- Produces `notices.js`: `githubCheckNotice(check)`, `awsVerifiedNotice(account, state)`, `cleanupNotice(deleted)`, `STACK_UPDATED_NOTICE` — strings identical to the web's.
- Produces `pickedBlock.js`: `async readPickedBlock(): number|null`, `async writePickedBlock(c_id): void` (never throws).

- [ ] **Step 1: Write failing tests** — every API method hits the exact URL/method/body of its web twin (`createConnection` body `{label}`, `setConnectionAws` body `{aws_account_id}`, install-url with and without `?c_id=`); `DELETE_TEXT.block.body`/`aws.body` equal the web strings; notice builders produce the web sentences for (repos listed / more than shown `외` / zero repos), AWS verified, cleanup 0 vs N; `isHttps` rejects `http:`, `javascript:`, empty, mixed-case `HTTPS://` accepted; picked block round-trips, returns `null` for missing/garbage values, and swallows storage errors (mock a rejecting AsyncStorage).
- [ ] **Step 2: Run to confirm fail** — `cd app && npx jest accountsApi accountsLogic pickedBlock` → FAIL (modules missing).
- [ ] **Step 3: Implement** the modules above; key `dw-picked-block` for storage.
- [ ] **Step 4: Run full `npx jest`** → all pass (229 existing + new).
- [ ] **Step 5: Commit** `feat(app): 계정 연결 API와 기본 로직`

---

### Task 2: Accounts screen shell — blocks, add, delete, pick, entry from list

**Files:**
- Create: `app/app/accounts.js`, `app/src/components/accounts/BlockCard.js`, `app/src/components/accounts/AddBlockForm.js`
- Modify: `app/app/index.js` (header button `계정 연결` next to `＋ 새 배포`, refresh the list on screen focus via `useFocusEffect` — fixes the C1 stale-card gap), `app/app/_layout.js` only if a route option is needed
- Test: `app/src/__tests__/AccountsScreen.test.js`, `BlockCard.test.js`, `DeployList.test.js` (focus refresh + header link)

**Interfaces:**
- Consumes: `accountApi` (Task 1), `confirmAction`, `usePolling`/`useColors`, `readPickedBlock`/`writePickedBlock`.
- Produces `BlockCard({ block, picked, busy, onPick, onDelete, children })` — renders title `block.label`, `선택`/`선택됨` button (disabled when picked), `블록 삭제` danger button; `children` slot receives the AWS and GitHub boxes (Tasks 3–4). `AccountsScreen` loads `listConnections + listAws + listGithub` together and exposes shared helpers to boxes via props: `reload()`, `run(work)` (busy lock + error to the error notice), `setNotice(text)`.

- [ ] **Step 1: Failing tests** — loading state then block cards from a mocked API; empty list shows `＋ 블록 추가` as the primary button; add-block form rejects an empty/blank label (button disabled), creates via `createConnection(label)` then reloads and scrolls the new card into view; `블록 삭제` asks `confirmAction` with `DELETE_TEXT.block` and sends no request on cancel; `선택` writes the picked block and the card shows `선택됨`; a failing load shows the Korean error with a retry button; double press on an action while `busy` sends one request; list screen shows the `계정 연결` header button that navigates to `/accounts`; the list reloads when the screen regains focus (call count).
- [ ] **Step 2: Run to confirm fail.**
- [ ] **Step 3: Implement** the screen, `BlockCard`, `AddBlockForm`; first-load picked block = stored id, else the only block; error/notice banners use the C1 `Notice` style (`ui.js`).
- [ ] **Step 4: Run `npx jest` + `npx expo export --platform web`** → pass/build.
- [ ] **Step 5: Commit** `feat(app): 계정 연결 화면 틀 (블록 목록·추가·삭제·선택)`

---

### Task 3: AWS box — 7-step guide, role ARN, verify, update guide, cleanup, release

**Files:**
- Create: `app/src/components/accounts/AwsBox.js`, `AwsGuide.js` (RN `Modal`, 7 steps — read `features/accounts/ui/AwsStackGuide.jsx` and `ConnectGuidePage.jsx` for the exact steps, copy and which values are copied), `AwsUpdateGuide.js` (from `AwsStackUpdateGuide.jsx`), `ExistingPicker.js` (shared with Task 4: props `{ title, items, onPick, onClose }`)
- Modify: `app/app/accounts.js` (wire AWS box into `BlockCard`, template status load, notices)
- Test: `app/src/__tests__/AwsBox.test.js`, `AwsGuide.test.js`

**Interfaces:**
- `AwsBox({ block, awsAccounts, templateStatus, busy, run, reload, setNotice })`. Actions (copy each web behavior): `계정 추가` (block without AWS → `createConnectionAws(c_id)`; with AWS → ask a label first, then `createAws(label)`), guide modal with `ExternalId` copy, stack name copy, `콘솔 열기` (`Linking.openURL(setup.stack_create_url)`) and `템플릿 받기` (resolved `template_download_url`), Role ARN input → `attachRole(a_id, trimmed)` → `reload()` + `awsVerifiedNotice`; pending account shows `역할 ARN 입력` (resume without ExternalId, as on the web); `연결 확인`/`다시 확인` → `reverifyAws`; `연결 해제` implements `releaseAws` (shared by several blocks → `setConnectionAws(c_id, null)`; else confirm with `DELETE_TEXT.aws` then `deleteAws`); verified accounts show the status label, `role_arn`, `aws_account_id` (wrapping), `last_error` when `invalid`; `update_needed` → notice + `스택 업데이트` opens `AwsUpdateGuide` (`템플릿 받기`, `스택 목록 열기`, `업데이트 확인` → `getTemplateStatus`); `template_file_count > 0` → `템플릿 파일 삭제` with the web's confirm text then `deleteTemplateFiles` + `cleanupNotice`; `이미 연결한 계정에서 고르기` → `ExistingPicker` of `awsAccounts` not used by this block → `setConnectionAws(c_id, a_id)`.

- [ ] **Step 1: Failing tests** — guide: step content/copy buttons present, `Clipboard.setStringAsync` called with the external id and stack name (value never rendered into a link or accessibility label — assert on `JSON.stringify(screen.toJSON())` for the label props), console button opens only `https://` URLs (an `http://` or `javascript:` setup url shows `주소를 열 수 없습니다` and calls nothing); closing the guide drops `external_id` from the tree; Role ARN trimmed and sent once on double press; 409 on `계정 추가` shows the server message; release: shared account → detach without confirm, sole account → confirm text then delete, cancel sends nothing; cleanup and update flows incl. `update_needed` still true after `업데이트 확인` stays open with the web's message; invalid status shows `last_error`.
- [ ] **Step 2: Run to confirm fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npx jest` + export.**
- [ ] **Step 5: Commit** `feat(app): AWS 계정 연결 (7단계 안내·역할 ARN·재확인·업데이트·정리·해제)`

---

### Task 4: GitHub box — install, return handling, check, release, pick existing

**Files:**
- Create: `app/src/components/accounts/GithubBox.js`, `app/src/hooks/useOnForeground.js` (calls a callback once each time `AppState` becomes `active` after being away; removes the listener on unmount)
- Modify: `app/app/accounts.js`
- Test: `app/src/__tests__/GithubBox.test.js`, `useOnForeground.test.js`

**Interfaces:**
- `GithubBox({ block, installations, busy, run, reload, setNotice })`: `계정 추가` → `getGithubInstallUrl(block.c_id)` → https check → `Linking.openURL(url)` → notice `GitHub 설치 화면에서 설치를 마치고 이 앱으로 돌아오세요.` (**planner's copy — mark in the code as app-only**); server `503` message shown as is; on foreground return the screen calls `reload()` and, if the block gained a GitHub installation that it did not have before, runs `checkGithub(g_id)` and shows `githubCheckNotice`; `연결 확인` → `checkGithub`; `연결 해제` → `setConnectionGithub(c_id, null)` (no confirm, installation stays, as on the web); status label from `GITHUB_STATUS_LABEL` (`suspended`/`revoked` shown); `ExistingPicker` of installations not used by this block → `setConnectionGithub(c_id, g_id)`.

- [ ] **Step 1: Failing tests** — install flow opens the URL once and sets the notice; non-https url refused; 503 shows the message and unlocks buttons; foreground event triggers exactly one reload and, only when a new installation appeared, one check + notice; no reload after unmount; check failure (400) shows the server message; release sends `{github_installation_id: null}`; picker lists only unused installations.
- [ ] **Step 2: Run to confirm fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npx jest` + export.**
- [ ] **Step 5: Commit** `feat(app): GitHub 연결 (설치 열기·복귀 확인·해제·기존 고르기)`

---

### Task 5: New-deploy integration, empty-state hints, responsive/keyboard polish

**Files:**
- Modify: `app/app/new.js` (default block = stored picked block if usable, else the only usable block — same rule as `AccountPicker.jsx`; hint with a link to `/accounts` when there is no usable block), `app/src/components/ConnectionPicker.js` only if the hint belongs there, `app/app/accounts.js` (KeyboardAvoidingView wrapper, safe-area padding, `RefreshControl`)
- Test: `app/src/__tests__/NewDeploy.test.js` (picked block default, single-block default, no block hint navigates to `/accounts`), `AccountsScreen.test.js` (keyboard wrapper, refresh)

- [ ] **Step 1: Failing tests** for the three defaults above plus: stored picked block that is no longer usable falls back to the single/none rule; the hint text is the web's/ConnectionPicker's wording extended with the link label `계정 연결 열기`.
- [ ] **Step 2: Run to confirm fail.**
- [ ] **Step 3: Implement; ensure stale-guards in `new.js` (analysis cleared on connection change) still hold.**
- [ ] **Step 4: Run `npx jest` + export.**
- [ ] **Step 5: Commit** `feat(app): 새 배포 화면이 고른 블록을 미리 선택하고 연결 안내를 보여준다`

---

### Task 6: Docs, browser cross-check, final run

**Files:**
- Modify: `app/README.md` (screens table: `/accounts`; what is verified / not verified), `docs/ui-spec.md` ("앱" section: accounts screen, deviations: vertical cards, ExistingPicker, no deep link), `docs/app-web/README.md` (C2 status; remaining: push, incidents, login, store build), `docs/features.md` (one line), `HISTORY.md` (one row, terse English; keep the single pre-existing NUL byte — edit as bytes), `docs/worklog/2026-11-09.md` (append, terse English)
- Verification run: Playwright on the web export at 390×844 dark then light with `/api/**` mocked: list → `계정 연결` → empty state → add block → `계정 추가` (AWS) → guide (copy buttons, https-only console button) → paste ARN → verified → GitHub `계정 추가` (install url opened via a stubbed `window.open`/Linking, 503 variant) → back to list → `＋ 새 배포` shows the picked block pre-selected; `scrollWidth <= innerWidth` on each page; console only intended mocked noise.

- [ ] **Step 1:** Run the browser flow; record numbers in the report.
- [ ] **Step 2:** Write the docs; run `npx jest`, `npx expo export --platform web`, repo `npm run build`, `.venv/Scripts/python.exe -m pytest -q` (expect 266 passed, 2 skipped).
- [ ] **Step 3: Commit** `docs(app): 계정 연결 화면 설명과 작업 기록`

---

## Self-review

- **Coverage:** B-01 (Tasks 2, 5), B-02 (4), B-03 (3), B-04 (3, 4), B-05 (3), B-06 (3), B-07 (2, 3, 4); S-08..S-11 map to the screen, boxes, guide and update guide; picked block (2, 5); C1 carry-over "list not refreshed after delete" (2).
- **Not in this plan:** deep-link return from GitHub/AWS (needs a backend `return_to` change, phase with login), "PC에서 이어서 하기" link (candidate `[가정]` in B-03), pager arrows, push, incidents, login, store build.
- **Unverified by design:** real AWS CloudFormation / AssumeRole, real GitHub App install, native browser hand-off and AppState behavior on a device; the server's GitHub callback redirect target (`/accounts?connected=github`) is not used by the app.
- **Type consistency:** `run`, `reload`, `setNotice`, `busy` are defined once in Task 2 and passed to the boxes in Tasks 3–4; `ExistingPicker` is created in Task 3 and reused in Task 4; `readPickedBlock`/`writePickedBlock` async in Tasks 1, 2, 5.
