# Responsive Cleanup of Existing Screens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing web screens (topbar, new-deploy form + list, deploy detail, accounts, connect-guide popup) usable and good-looking from phone width (390 px) up to desktop, without changing behavior.

**Architecture:** CSS-first. Fix layout with the existing tokens in `shared/ui/styles.css` (flex-wrap, grid collapse, `min-width: 0`, `overflow-wrap`), add `@media` rules in the existing `(max-width: 640px)` block (and one tablet rule at 900 px only if an audit shows a need). JSX changes only where a wrapper/class is required for layout. No new dependencies, no behavior or copy changes.

**Tech Stack:** React 19, Vite 8, plain CSS. Verification = `npm run build` + Playwright MCP checks (no UI test framework), API mocked.

**Spec:** Owner decision 2026-11-09 ("기존 화면도 폰 폭으로 정리", after Plan B); design basis `docs/ui-spec.md`, tokens in `shared/ui/styles.css`; new screens from Plan B (`features/envvars/ui`, `features/advice/ui`) already follow the same rules and are the reference.

## Global Constraints

- Follow `docs/conventions.md` (React): colors/spacing only via CSS variables in `shared/ui/styles.css` (no hard-coded colors); keep existing class names; Korean one-line comments above new CSS sections; no copy/behavior changes; keep existing code style (2-space, no semicolons, single quotes in JS).
- Widths to meet: 390×844 (phone), 768×1024 (tablet), 1280×900 (desktop; must look unchanged). No horizontal page scroll at any width (`document.documentElement.scrollWidth <= window.innerWidth`); only code/log/pre blocks may scroll inside their own container.
- Touch targets: buttons/links/inputs at least 40 px tall at ≤ 640 px (use padding, not font-size changes).
- Light and dark themes both checked (`emulate_media colorScheme`).
- Hard rules unchanged; do not touch backend files. Branch: create `feat/responsive-existing` from `test`; Conventional Commits, Korean body, end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Dev run: `npm run dev` (:5173); API mocked in checks (`page.route('**/api/**', ...)` via `browser_run_code_unsafe`); stop only the dev-server PID you started on port 5173; no `.playwright-mcp/` left in the repo; screenshots only under the system temp directory.

## Review Focus

- Desktop (1280) must look the same as before (no regressions from the shared rules).
- Long unbroken strings (repo URLs, endpoints, ARNs, external ids, commit hashes) at 390 px.
- Dialogs (`<dialog>`, `dialog.wide`), the guide popup page, and the accounts block pager (`‹ n / total ›`) at 390 px.
- Tap targets and focus visibility; no hover-only affordances.
- Dark mode contrast of anything newly styled.

## Mock fixtures

Use realistic data: 6 deploys of mixed statuses with long repo names (`kjfcvx12/a-very-long-repository-name-for-testing`) and an `endpoint` of ~60 chars; a `failed` deploy with `explain` (summary, cause, 3 actions, long `error_msg`); a `running` deploy with `endpoint`; a deploy with 400+ log lines of 120 chars; accounts: 2 connection blocks, an AWS account `verified` with `role_arn` of 90 chars, one `pending`, one `invalid` with a long `last_error`, a GitHub installation `active`; template status `update_needed:true` and `template_file_count:3`. Shapes follow `docs/api-spec.md`.

---

### Task 1: Topbar, new-deploy form, deploy list (shared rules first)

**Files:** Modify `shared/ui/styles.css`; `features/deploys/ui/DeployForm.jsx`, `DeployListPage.jsx`, `shared/ui/App.jsx` only if a layout class is required.

- [ ] **Step 1: Audit** `/` at 390/768/1280 in light: record per-element problems (overflow, cramped rows, tiny targets) with measured `scrollWidth`; one screenshot per width, saved under the system temp directory.
- [ ] **Step 2: Fix** the problems found: topbar wraps cleanly (brand + `계정 연결` link stay reachable), the form's row (URL input, branch button/select, submit) stacks full-width at ≤ 640 px with ≥ 40 px controls, list rows wrap their meta line and keep the badge aligned, `.page` padding sensible at phone width.
- [ ] **Step 3: Verify** the three widths in light and dark (`scrollWidth <= innerWidth`, no clipped text, desktop unchanged versus the audit screenshot); `npm run build` succeeds.
- [ ] **Step 4: Commit** `fix(web): 상단 바·새 배포 폼·목록 폰 폭 정리`

### Task 2: Deploy detail page

**Files:** Modify `shared/ui/styles.css`; `features/deploys/ui/DeployDetailPage.jsx`, `LogTerminal.jsx`, `StepProgress.jsx`, `IssueHistory.jsx`, `features/explains/ui/ExplainCard.jsx` only where a layout class is required.

- [ ] **Step 1: Audit** `/deploys/:id` for a `running`, a `failed` (explain card), and a log-heavy deploy at 390/768/1280 (light), plus the delete/stop dialogs open at 390.
- [ ] **Step 2: Fix:** header row (name + badges) wraps, endpoint link and health badge stack, step bar remains readable (existing font rule), ExplainCard buttons stack full-width, terminal height/scroll sane at phone width (log lines wrap or scroll inside the terminal only), Dockerfile `pre` scrolls inside its box, dialogs fit (`max-width` with side margins), action buttons wrap with ≥ 40 px targets. Plan B's `EnvVarsCard` is the reference for wrapping behavior; do not alter its behavior.
- [ ] **Step 3: Verify** all three states at 390 (light + dark) and 768/1280 (light): no horizontal page scroll, dialogs fully visible, desktop unchanged; `npm run build`.
- [ ] **Step 4: Commit** `fix(web): 배포 상세 폰 폭 정리`

### Task 3: Accounts page and guide popup

**Files:** Modify `shared/ui/styles.css`; `features/accounts/ui/AccountsPage.jsx`, `AccountBox.jsx`, `AccountPicker.jsx`, `ConnectGuidePage.jsx`, `AwsStackGuide.jsx`, `AwsStackUpdateGuide.jsx` only where a layout class is required.

- [ ] **Step 1: Audit** `/accounts` (2 blocks; AWS `verified`/`pending`/`invalid` with long strings; GitHub active; update-needed notice) and `/guide/aws`, `/guide/github` at 390/768/1280 (light); open the AWS connect dialog and the stack-guide dialog at 390.
- [ ] **Step 2: Fix:** account boxes already collapse to one column at 640 px — verify the box internals (`.account-pick`, `.account-foot`, `.block-pick`) don't overflow, long ARNs/ids wrap (`overflow-wrap: anywhere`), copy buttons and `.shot` mock-ups wrap, dialogs and `dialog.wide` fit the viewport with margins, the guide pages keep ≥ 16 px gutters.
- [ ] **Step 3: Verify** at 390/768/1280 (light) and 390 dark, including dialogs; `npm run build`.
- [ ] **Step 4: Commit** `fix(web): 계정 연결·안내 창 폰 폭 정리`

### Task 4: Cross-check and docs

**Files:** Modify `docs/ui-spec.md` (a short "반응형" section: widths, rules, what was verified), `HISTORY.md` (one row, terse English), `docs/worklog/2026-11-09.md` (append, terse English), `docs/features.md` only if needed.

- [ ] **Step 1:** Re-run one flow per page at 390 dark and 1280 light (list → detail (failed) → accounts) after all tasks; confirm no console errors beyond mocked noise and no horizontal scroll.
- [ ] **Step 2:** Update the docs; run `npm run build` and `.venv/Scripts/python.exe -m pytest -q` (backend untouched; expect all pass).
- [ ] **Step 3: Commit** `docs(web): 반응형 정리 내용과 작업 기록`

---

## Self-review

- **Coverage:** every existing screen (topbar/form/list, detail + dialogs, accounts + dialogs + guide popups) has a task; docs in Task 4. Not in scope: new features, copy changes, backend, the Expo app.
- **Gaps (intended):** no automated visual regression (no framework); the audit step makes findings concrete per screen instead of guessing them in the plan.
