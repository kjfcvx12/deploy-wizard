# Web UI: Env-Var Input and Pre-Deploy Analysis — Implementation Plan (Plan B of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the web screens for env-var input (S-19) and "analyze before deploy" (S-20) on top of the Plan A backend, and make the `needs_input` status work end to end in the web UI.

**Architecture:** Two new UI feature folders, `features/envvars/ui/` and `features/advice/ui/` (api client + constants + components), mounted from the existing deploy pages. No router changes: the env card lives inside the deploy detail page; the analysis panel lives inside the new-deploy form. Colors come only from `shared/ui/styles.css` tokens. The new screens must work at 390 px width.

**Tech Stack:** React 19, react-router 7, Vite 8 (no UI test framework exists). Verification = `npm run build` + a browser check with Playwright MCP tools against the Vite dev server with `/api` mocked.

**Spec:** `docs/app-web/06-screens.md` (S-19, S-20, design basis), `docs/app-web/02-feature-spec.md` (H-05, H-07, H-10, I-01..I-08), `docs/app-web/04-api-spec.md` ("환경변수", "배포 수준·비용 추천") and the built behavior in `docs/api-spec.md` ("Env", "Advice"). Backend = Plan A (`docs/superpowers/plans/2026-11-09-backend-env-and-advice.md`, merged on branch `test`).

## Global Constraints

- Follow `docs/conventions.md` (React section): screens in `features/<feature>/ui/`; components `PascalCase.jsx`, others `camelCase.js`; one `ui/api.js` per feature mirroring its router; server field names unchanged (`d_id`, `repo_url`, `needs_redeploy`); colors/spacing only via CSS variables in `shared/ui/styles.css` (no hard-coded colors); status strings only in `features/deploys/ui/constants.js`; polling uses an `alive` flag + `clearTimeout`.
- Language: all user-visible text Korean; code comments Korean one-liners above functions/components (no docstrings); identifiers English. Keep existing code style (2-space JS, no semicolons, single quotes).
- Hard rule 6: an env var value is write-only. After a successful save the input state is cleared; values never go to `localStorage`, URLs, `console`, or error text. Secret-kind rows never offer a value input (backend answers 501 until D8 is verified); the UI says so plainly.
- Hard rule 3: no automatic create/change/delete. Every state change is a button the user presses; no open questions, 2–3 buttons.
- Backend responses must not be assumed beyond `docs/api-spec.md`. `cpu`, `memory`, `cost.*` are `null` today and must render as "아직 계산할 수 없습니다", never as 0 or a made-up number.
- Scope: new screens only. Existing screens (list, detail, accounts) are touched only where this plan says; their phone-width cleanup is a separate work item. Tier selection UI (S-20 "수준 선택 3칸") and `size_tier` are NOT in scope (no backend column yet, decision D10).
- Branch: create `feat/web-env-advice` from `test`. Commits: Conventional Commits, Korean body, end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Dev run: API `uvicorn main:app --port=8081` is NOT needed (API is mocked in checks); UI `npm run dev` serves :5173. Stop only processes you started (by port listener PID); other projects share this PC.

## Review Focus

- A secret-kind variable (`database`, `cache`, `external_api`, `secret`) must never show a value input, and a config value must not linger in React state or the DOM after saving (Tasks 1, 2).
- After the pause the detail page stops polling (`isProgress('needs_input')` is false); the card must still load, and after [이어서 배포] the page must resume polling and leave `needs_input`; a 409 from continue must show its Korean `detail` without losing typed values (Task 2).
- Editing the repo URL, branch or account block after an analysis must discard the stale analysis result; a failed analysis (400/500) shows the server `detail`; double-clicks cannot start two analyses or two deploys (Task 4).
- Phone width 390 px: long variable names, `source_hint` paths, URLs and reasons wrap; no horizontal page scroll; buttons reachable (Tasks 2, 4, 5).
- Empty and odd data: `needs_input` with zero env rows, 60+ rows, unknown `kind`/`source` values from the server, `needs`/`reasons`/`unknowns` empty arrays, `cost` all null (Tasks 1, 2, 4).

## UI check fixtures (used by the verification steps)

Mock these with Playwright (`page.route('**/api/**', ...)` via `browser_run_code_unsafe`, or any equivalent); the tasks name the scenario. Statuses and shapes follow `docs/api-spec.md`.

- `GET /api/deploys` → `[{"d_id":7,"repo_url":"https://github.com/o/app","branch":"main","language":"python","status":"needs_input","env_pending":2,"endpoint":null,"explain":null,"created_at":"2026-11-09T01:00:00","updated_at":"2026-11-09T01:02:00","commit_sha":"abcdef1234567","support_level":"official","app_dir":".","fix_count":0,"service_arn":null,"image_uri":"x","port":8000,"health_check_path":"/","error_step":null,"error_msg":null,"aws_account_id":null,"github_installation_id":null,"auto_redeploy":true}]` plus a second deploy `running` with `env_pending:0`.
- `GET /api/deploys/7` → the first object above; `GET /api/deploys/7/logs?after=0` → `[]`; `GET /api/deploys/7/issues` → `[]`.
- `GET /api/deploys/7/env` → rows: `{name:"MY_THING_URL",required:true,has_default:false,kind:"unknown",source:"code",source_hint:"app/config.py:12",status:"detected",has_value:false,needs_redeploy:false}`, `{name:"DATABASE_URL",kind:"database",...,status:"detected"}`, `{name:"LOG_LEVEL",kind:"config",required:true,...,status:"detected"}`, `{name:"PAGE_SIZE",required:false,has_default:true,kind:"config",status:"detected"}`, `{name:"OLD_FLAG",kind:"config",status:"skipped"}`.
- `PUT /api/deploys/7/env/LOG_LEVEL` `{value:"info"}` → row with `status:"set",has_value:true,needs_redeploy:false`; `PUT .../DATABASE_URL` `{value:"x"}` → 501 `{"detail":"시크릿 값 저장은 아직 지원하지 않습니다 (사용자 AWS 보안 저장소 검증 후 지원)"}`; `POST /api/deploys/7/env/continue` → 409 `{"detail":"필수 환경변수에 값이 없습니다 :DATABASE_URL, MY_THING_URL"}` first, then 200 with the deploy `status:"queued"`.
- `POST /api/deploys/advice` → `{"tier":"medium","confidence":"medium","cpu":null,"memory":null,"cost":{"monthly_min":null,"monthly_max":null,"currency":"USD","basis_date":null,"note":"트래픽에 따라 늘어납니다"},"reasons":["pandas를 사용해 메모리를 넉넉히 잡았습니다"],"needs":[{"kind":"database","supported":false,"message":"마법사가 아직 만들어 주지 못합니다"},{"kind":"env_vars","supported":true,"count":4}],"unknowns":["환경변수 MY_THING_URL의 종류를 알 수 없습니다"],"language":"python","support_level":"official","app_dir":".","commit_sha":"abcdef1"}`; error variant 400 `{"detail":"https://github.com/소유자/레포 형식의 주소만 받습니다."}`.

---

### Task 1: API clients, constants, and pure helpers

**Files:**
- Create: `features/envvars/ui/api.js`, `features/envvars/ui/constants.js`, `features/advice/ui/api.js`, `features/advice/ui/constants.js`
- Modify: none (the continue call lives in `envApi`; `features/deploys/ui/api.js` and `constants.js` stay unchanged — `needs_input` is already in `STATUS_LABEL` and intentionally not in `PROGRESS`)

**Interfaces:**
- Produces (`envvars/ui/api.js`): `envApi = { getAll(d_id), put(d_id, name, body), clearValue(d_id, name), continueDeploy(d_id) }` using `request` from `@shared/ui/api.js`; URLs `/api/deploys/${d_id}/env`, `/env/${encodeURIComponent(name)}`, `/env/${encodeURIComponent(name)}/value` (DELETE), `/env/continue` (POST).
- Produces (`envvars/ui/constants.js`): `ENV_KINDS = [{key,label}]` for `database` 데이터베이스 주소, `cache` 캐시 주소, `external_api` 외부 서비스 키, `secret` 비밀값, `config` 일반 설정; `ENV_SECRET_KINDS = new Set(['database','cache','external_api','secret'])`; `kindLabel(key)` (unknown keys → `알 수 없음`); `groupEnvVars(rows) -> {need, unknown, optional, done}` as defined below; `canContinue(rows) -> boolean` (true iff no row has `required && status==='detected'`).
  - `done`: status `set` or `skipped`; `unknown`: detected, required, kind `unknown`; `need`: detected, required, kind ≠ `unknown`; `optional`: detected and not required. Rows with an unexpected status/kind fall into `unknown`/`need` safely (never dropped).
- Produces (`advice/ui/api.js`): `adviceApi = { analyze({repo_url, branch, aws_account_id, github_installation_id}) }` → `POST /api/deploys/advice`, normalizing empty values to `null` exactly like `deployApi.create`.
- Produces (`advice/ui/constants.js`): `TIER_LABEL = {small:'가벼움', medium:'보통', large:'무거움'}`, `CONFIDENCE_LABEL = {high:'높음', medium:'보통', low:'낮음'}`, `NEED_LABEL = {database:'데이터베이스', cache:'캐시', worker:'백그라운드 작업', env_vars:'환경변수', disk_write:'디스크 쓰기', static_site:'정적 사이트'}`, `tierLabel/confidenceLabel/needLabel(key)` helpers falling back to the raw key.

- [ ] **Step 1: Write the pure-logic check** as a throwaway Node script in the system temp dir (not committed) that imports `groupEnvVars`/`canContinue` from the new constants file and asserts: the five fixture rows group into `unknown:[MY_THING_URL]`, `need:[DATABASE_URL, LOG_LEVEL]`, `optional:[PAGE_SIZE]`, `done:[OLD_FLAG]`; `canContinue` is false; after marking `DATABASE_URL`, `LOG_LEVEL`, `MY_THING_URL` as `skipped` it is true; an unexpected `kind:"x"` required detected row lands in `need`; an empty array gives four empty groups.
- [ ] **Step 2: Run it** (`node <script>`) — Expected: fails (module missing).
- [ ] **Step 3: Implement** the four files as specified (constants files import nothing from React).
- [ ] **Step 4: Run** the script — Expected: all assertions pass; then `npm run build` — Expected: build succeeds with no new warnings.
- [ ] **Step 5: Commit** `feat(web): 환경변수·분석 API 클라이언트와 상수`

---

### Task 2: Env-var card on the deploy detail page (S-19)

**Files:**
- Create: `features/envvars/ui/EnvVarsCard.jsx`
- Modify: `features/deploys/ui/DeployDetailPage.jsx`, `features/deploys/ui/StepProgress.jsx`, `features/deploys/ui/StatusBadge.jsx`, `shared/ui/styles.css` (new section "환경변수", tokens only, phone rules inside the existing `@media (max-width: 640px)` block or a new one)

**Interfaces:**
- Consumes: `envApi`, `groupEnvVars`, `canContinue`, `ENV_KINDS`, `ENV_SECRET_KINDS`, `kindLabel` (Task 1); `deployApi.getOne` indirectly via the page.
- Produces: `EnvVarsCard({ deploy, onContinued, onRedeploy })` — renders nothing when there are no rows and `deploy.status !== 'needs_input'`; when `needs_input` with zero rows it shows `입력할 환경변수를 찾지 못했습니다. [이어서 배포]를 눌러 계속하세요.` plus the continue button. `onContinued()` is called after a successful continue; `onRedeploy()` after the user presses the redeploy button in the needs-redeploy banner.

Behavior (exact copy in Korean where given):
- Heading `환경변수` with intro `코드에서 필요한 값을 찾았습니다. 값은 이 화면에서만 입력하고, 한 번 저장하면 다시 보여 드리지 않습니다.` and, always visible, `자동으로 찾지 못한 변수가 있을 수 있습니다. 배포 후 앱이 시작하지 못하면 알려 드립니다.`
- Groups in order: `꼭 필요해 보이는 것` (need), `종류를 모르는 것` (unknown; buttons from `ENV_KINDS` → `envApi.put(d_id, name, {kind})`, then the row moves to `need`), `기본값이 있어 비워도 되는 것` (optional, inside a collapsed `<details>`), `입력 완료` (done, collapsed, shows `건너뜀` or `입력됨`, with [값 지우기] → `clearValue` for set rows).
- Row: name in monospace, `source_hint` muted (wraps), kind badge. For config kind: text input + [저장] (`put {value}`) + [건너뛰기] (`put {skip:true}`). For secret kinds: no input; text `이 종류의 값은 아직 저장할 수 없습니다. 지금은 건너뛰기만 됩니다.`; only [건너뛰기]. After a successful save: clear the input state, reload rows, keep focus order sane.
- [변수 직접 추가]: name input (pattern `^[A-Za-z_][A-Za-z0-9_]{0,99}$`, enforced client-side with a Korean message, server `detail` still shown) + kind select; adds via `put(name, {kind})`.
- Footer: [이어서 배포] (primary) → `envApi.continueDeploy`; disabled with reason text `필수 환경변수에 값이 없습니다` while `!canContinue(rows)`; on 409 show `detail` in a `.notice err` and keep inputs; on success call `onContinued()`.
- If any PUT response has `needs_redeploy: true` (deploy already running/stopped/failed), show `.notice warn` `다시 배포해야 적용됩니다` with a [다시 배포] button that calls `onRedeploy`.
- Every request error is shown as a `.notice err` with the server message; buttons disable while a request is in flight (`busy`).
Detail page integration: render `<EnvVarsCard>` below the step-progress card when rows may exist (status `needs_input`, or any status after `analyzing`); for `needs_input` also show a top `.notice info` `환경변수 입력이 필요합니다. 아래에서 값을 입력하거나 건너뛴 뒤 [이어서 배포]를 누르세요.`; `onContinued` = `setRound((n) => n + 1)` (restarts polling); `onRedeploy` = the page's existing `redeploy`. In the bottom action row, hide [다시 배포]/[멈춤] for `needs_input` and keep [삭제].
`StepProgress`: treat `needs_input` as "after pushing, before deploying": steps up to `pushing` done, `deploying` shown as waiting (not failed). `StatusBadge`: `needs_input` uses tone `exp` (warn).

- [ ] **Step 1: Write the browser check script steps** (Playwright MCP): open `http://localhost:5173/deploys/7` with the fixtures; expectations listed below; run it against the current code — Expected: the card does not exist yet (fails).
- [ ] **Step 2: Implement** `EnvVarsCard.jsx`, CSS, and the page/StepProgress/StatusBadge edits.
- [ ] **Step 3: Verify at 1280×900:** the info notice, groups in the specified order, `MY_THING_URL` shows five kind buttons; clicking `일반 설정` moves it to the need group with an input; `DATABASE_URL` shows no input and the secret-kind text; typing `info` for `LOG_LEVEL` and [저장] sends `PUT` with `{value:"info"}` (inspect the mocked request body), clears the input, and the row moves to `입력 완료`; [이어서 배포] is disabled with the reason until the remaining required rows are skipped; with the first continue mocked as 409 the `detail` text appears and typed text stays; the second continue (200) triggers a reload of `GET /api/deploys/7`; `PAGE_SIZE` is inside a collapsed details; a PUT response with `needs_redeploy:true` shows the warn banner and [다시 배포] posts to `/redeploy`. Check the step bar shows `deploying` as waiting and the badge reads `입력 필요`.
- [ ] **Step 4: Verify at 390×844 and in dark mode** (`emulate_media` colorScheme dark): `document.documentElement.scrollWidth <= window.innerWidth`, long `source_hint` and a 60-character variable name wrap, buttons not clipped, contrast readable. Take one screenshot per width; fix what they show once; the last passing screenshot is final.
- [ ] **Step 5: Run** `npm run build` — Expected: success. Commit `feat(web): 환경변수 입력 카드와 입력 대기 상태 화면`

---

### Task 3: Env-pending hint on the deploy list

**Files:**
- Modify: `features/deploys/ui/DeployListPage.jsx` (meta line), `features/deploys/ui/StatusBadge.jsx` only if Task 2 did not already cover the tone

**Interfaces:** Consumes `Deploy_Read.env_pending` (int, default 0) and `status === 'needs_input'`.

Behavior: in a list row, when `deploy.env_pending > 0` append ` · 환경변수 {n}개 입력 필요` to the meta line; polling intervals unchanged (needs_input is not in progress, so the list polls every 15 s — acceptable).

- [ ] **Step 1: Check (browser):** with the list fixtures, row `#7` shows `환경변수 2개 입력 필요` and a `입력 필요` badge; the `running` row shows no such text — Expected before the change: text absent (fails).
- [ ] **Step 2: Implement** the meta addition.
- [ ] **Step 3: Verify at 1280 and 390** (the meta wraps, no horizontal scroll); then `npm run build`.
- [ ] **Step 4: Commit** `feat(web): 목록에 환경변수 입력 필요 표시`

---

### Task 4: Analyze-before-deploy panel on the new-deploy form (S-20)

**Files:**
- Create: `features/advice/ui/AdvicePanel.jsx`
- Modify: `features/deploys/ui/DeployForm.jsx`, `shared/ui/styles.css` (section "분석 결과")

**Interfaces:**
- Consumes: `adviceApi`, `TIER_LABEL`/`CONFIDENCE_LABEL`/`NEED_LABEL` helpers (Task 1), `deployApi.create`.
- Produces: `AdvicePanel({ advice, busy, onDeploy, onReset })` — presentational; `DeployForm` owns state `advice`, `analyzing`, `error`.

Behavior (decision D11: two steps):
- The submit button changes from `배포` to `분석` (type submit, primary). Submitting calls `adviceApi.analyze` with the same inputs as the old create (repo, branch, account block ids). While analyzing the button is disabled and reads `분석 중...`.
- Result panel (below the form, inside the same card flow): heading `분석 결과`; language + support badge (`공식 지원` / `실험 지원`, reuse `.badge exp` for experimental); big tier line `추천 수준: {보통}` with a confidence badge — `낮음` uses `.badge exp` and the line `추정입니다. 근거가 부족해 틀릴 수 있습니다.`; `reasons` as a list under `왜 이렇게 추천했나`; cost line: when `cost.monthly_min` and `monthly_max` are both null show `예상 비용: 아직 계산할 수 없습니다 (실제 배포로 요금 구성을 확인한 뒤 표시됩니다). 트래픽에 따라 늘어납니다.`; otherwise show `{min}~{max} {currency}/월` with `기준일 {basis_date}` and the `note` (not exercised today, keep it simple); `필요한 것` list from `needs` — supported items plain, unsupported (`supported:false`) muted with their `message`; `env_vars` shows `환경변수 {count}개 입력이 필요합니다`; `unknowns` inside a collapsed `<details>` `알 수 없었던 것`.
- Buttons: `이 레포로 배포` (primary → `deployApi.create` with the same inputs → navigate to `/deploys/{d_id}` as today) and `다른 레포로` (clears the result). Text under them: `분석은 읽기만 합니다. 배포를 누르기 전에는 AWS에 아무것도 만들지 않습니다.`
- Any change to repo URL, branch, or the account picker clears `advice` (stale result must not be deployable). Errors from analyze/create show as `.notice err` with the server `detail`. A second click while busy is ignored.
- Existing helper text under the form is adjusted: remove `배포` wording that no longer applies (`브랜치를 고르지 않으면 레포의 기본 브랜치를 분석하고 배포합니다.`).

- [ ] **Step 1: Check (browser):** with fixtures, typing a repo URL and pressing `분석` currently deploys directly (old behavior) — Expected: the panel is absent (fails).
- [ ] **Step 2: Implement** `AdvicePanel.jsx` and the `DeployForm.jsx` changes.
- [ ] **Step 3: Verify at 1280×900:** `분석` posts to `/api/deploys/advice` with `branch:null` when none is chosen; the panel shows `보통`, a `보통` confidence badge, the reason, the cost sentence for all-null cost, the database need muted with its message, `환경변수 4개 입력이 필요합니다`, the unknowns details; `이 레포로 배포` posts to `/api/deploys` and navigates; changing the URL clears the panel; the 400 fixture shows its `detail` and no panel; a confidence `low` variant shows the `추정입니다` line; empty `reasons`/`needs`/`unknowns` render without empty headings.
- [ ] **Step 4: Verify at 390×844 and dark mode:** no horizontal scroll, buttons stack, long reasons wrap. One screenshot per width (fix once, last passing one is final).
- [ ] **Step 5: Run** `npm run build` — Expected: success. Commit `feat(web): 배포 전 분석·추천 패널과 두 단계 배포`

---

### Task 5: Cross-check, dark mode, and docs

**Files:**
- Modify: `docs/ui-spec.md` (new/changed screens), `docs/features.md` (UI notes for `envvars`, `advice`), `HISTORY.md` (one row, terse English), `docs/worklog/2026-11-09.md` (append, terse English), `docs/app-web/README.md` (mark Plan B implemented, link this plan)

- [ ] **Step 1: Re-run** the Task 2 and Task 4 browser checks once end to end on the final code at 390 px dark and 1280 px light (one flow: list → new deploy → analyze → deploy → detail `needs_input` → set/skip → continue) with the fixtures; confirm no console errors (`browser_console_messages`) and no failed requests other than the intended 409/501/400 mocks.
- [ ] **Step 2: Update the docs** listed above: `docs/ui-spec.md` gets the S-19 card (groups, copy, secret-kind rule, redeploy banner), the S-20 two-step form, and the `needs_input` badge/step behavior; note that the tier-selection UI is deferred and why (no `size_tier` backend, decision D10).
- [ ] **Step 3: Run** `npm run build` and `.venv/Scripts/python.exe -m pytest -q` — Expected: build succeeds; Python suite unchanged (all pass).
- [ ] **Step 4: Commit** `docs(web): 환경변수·분석 화면 명세와 작업 기록`

---

## Self-review

- **Spec coverage:** S-19 (Task 2), S-20 two-step flow (Task 4), `env_pending` hint (Task 3), `needs_input` in step bar/badge/actions (Task 2), responsive for the new screens only (Tasks 2–5). Deferred on purpose: tier selection (needs `size_tier` backend, D10), secret value saving (D8), existing-screen phone cleanup (owner decision).
- **Types:** `groupEnvVars`/`canContinue` defined in Task 1 and used in Task 2; `EnvVarsCard`/`AdvicePanel` props defined where created; API helper names consistent.
- **Known gaps (intended):** no automated UI regression tests (no framework; owner chose build + Playwright checks); real-backend integration of these screens is part of the first real deploy.
