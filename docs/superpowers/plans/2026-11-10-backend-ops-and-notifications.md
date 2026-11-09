# Backend Ops Recovery and Notifications (Plan D1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server watches every `running` deploy, opens an incident after repeated health failures, explains it (rule table), automatically tries restart then rollback to the previous healthy image when the deploy's `auto_recover` is on, and tells the owner through an in-app list, email and Expo push — with the APIs the app/web screens need (health history, incidents, notifications, devices, settings). No login yet (u_id stays null).

**Architecture:** Three new feature folders following the project layout: `features/health/` (health_checks table, monitor loop), `features/incidents/` (incidents + recovery_actions tables, detection, rule-table explain, recovery executor, router), `features/notifications/` (notifications, push_devices, notification_settings tables; compose + mask; in-app, SMTP email and Expo push dispatch; router). `deploy_releases` and four new `deploys` columns live in `features/deploys/`. Dependencies: `features/* -> shared/*` only; feature-to-feature through `*_Service` classes (incidents → deploys, express, notifications; health → incidents). Background loops start in `main.py` lifespan like the existing watch poll. All external effects (HTTP health GET, AWS update, SMTP, Expo push) sit behind small injectable functions so pytest needs no AWS/network.

**Tech Stack:** FastAPI, SQLAlchemy 2 async (SQLite), Pydantic v2, httpx (already a dependency), stdlib `smtplib`/`email` (run in `asyncio.to_thread`), pytest + pytest-asyncio as in the existing tests.

**Spec:** `docs/app-web/02-feature-spec.md` D-01..D-06, D-09, E-01, E-02, E-04 (server side), `docs/app-web/03-db-erd.md` (tables `health_checks`, `incidents`, `recovery_actions`, `notifications`, plus `deploy_releases` and the `deploys` columns), `docs/app-web/04-api-spec.md` §2–§5, §7, flowcharts 4 and 8 in `docs/app-web/05-flowcharts.md`; CLAUDE.md Hard rules 2, 3, 4 (rule-table fallback only here), 6, 7, 8. Decisions already made: D12 (agent only for ops/recovery — NOT in this plan, see Self-review), monitoring every 60 s, incident after 3 consecutive failures, dev mail = a simple `.env` address, free/paid plans later.

## Global Constraints

- Follow `docs/conventions.md`: Pascal_Snake classes, `<layer>_<domain>_<action>` functions, short PK names (`h_c_id`, `i_id`, `r_a_id`, `n_id`, `p_d_id`, `d_r_id`), `Service`/`Crud` = classes of `@staticmethod`, first arg `db: AsyncSession` (DB) or `session` (AWS), crud flush-only / services commit-rollback, one-line Korean comment above each function, no docstrings, keep existing `=` spacing, folder `scheme` (not `schemas`). User-facing strings Korean; identifiers English; HISTORY/worklog terse English.
- Hard rule 3: automatic actions are exactly **restart** (update the service with the same image) and **rollback to the previous healthy image**, only for a `running` deploy with `auto_recover` on, with an open incident, within attempt/cooldown limits (code re-checks; limits in settings: `RECOVERY_MAX_ATTEMPTS_PER_INCIDENT=2` one restart + one rollback, `RECOVERY_DAILY_LIMIT=6` automatic actions per deploy per 24 h, `RECOVERY_WAIT_SECONDS=120` before checking health after an action, `RECOVERY_VERIFY_SECONDS=300` window of healthy checks to call it resolved). Never delete resources, never change spec/scale. Every automatic action is a `recovery_actions` row and a notification with cause and where to fix.
- Hard rule 2: only AWS calls already in `docs/aws-notes.md` / `features/express/services.py` (`services_express_update`, `services_express_describe`, `services_express_wait`). Restart = `services_express_update` with the unchanged `image_uri` — whether Express Mode really restarts tasks on a same-image update is **unverified**; record it in `docs/aws-notes.md` as such. No log/event collection from CloudWatch or ECS events (unverified): evidence = `services_express_describe` result + the last health check details, masked.
- Hard rule 6: every text that reaches DB (`explain`, `evidence`, `detail`, notification `body`), mail, push or logs goes through `mask_text` first; push bodies are short (title + one line), never raw logs; no tokens, Expo push tokens or SMTP passwords in logs/errors/responses (`Device_Read` shows only the last 6 chars of the token).
- Hard rule 7/8: no `shell=True`; nothing here creates AWS resources.
- Status values: **`deploys.status` is NOT changed** (recovery state lives in `incidents.status`); CLAUDE.md status flow unchanged. `deploy_releases.state`: `current|previous|failed`. `incidents.status`: `open|recovering|resolved|needs_action`; `kind`: `unhealthy|crash_loop|bad_release|unknown`; `recovery_actions.action`: `restart|rollback`, `result`: `running|ok|failed`; notification `kind`/`channel`/`status` as in `docs/app-web/03-db-erd.md`.
- One `open`/`recovering` incident per deploy at a time (unique check in code + partial protection in a test).
- Existing local `data/wizard.db` must keep working: SQLite `create_all` does not add columns, so Task 1 adds an idempotent `ensure_columns` step (see Task 1).
- Tests: `pytest` needs no AWS/LLM/Docker/network (inject fakes); baseline 266 passed, 2 skipped must stay green; every new endpoint documented in `docs/api-spec.md` in the same task (Hard rule 10).
- Git: branch `feat/backend-ops` from `test`; Conventional Commits, Korean body, end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; never push. Python: `.venv/Scripts/python.exe -m pytest -q`.

## Review Focus

- Automatic actions never exceed the limits (attempts per incident, daily cap, cooldown), never run for `auto_recover=false`, a non-`running` deploy, or without an open incident; restart/rollback never runs twice concurrently for one deploy (per-deploy lock) and survives a server restart sensibly (incident left `recovering` → loop resumes or becomes `needs_action`).
- Rollback does not loop: a rolled-back deploy must not be auto-redeployed to the same bad commit by the watch poll (`deploys.bad_commit_sha`); purged/missing previous image → `needs_action`, not a crash.
- Secrets: mail/push/DB text masked; the monitor never GETs anything but the deploy's own `endpoint` + `health_check_path`; no SSRF through user-controlled paths beyond what `services_deploy_health` already does.
- Monitor load and failure isolation: one failing/slow endpoint never stalls the loop (timeouts, bounded concurrency), exceptions inside one deploy's check never kill the loop; `health_checks` pruned after 7 days.
- Notification fan-out: duplicate suppression per incident+kind, settings (email/push off, kinds) respected, a failing channel (SMTP down, Expo error, `DeviceNotRegistered`) never breaks incident handling and invalid devices are removed.
- API robustness: unknown ids → 404 Korean message; `after`/`hours` bounds validated; large lists capped.

---

### Task 1: Tables, settings, existing-DB column upgrade, release tracking

**Files:**
- Create: `features/health/{__init__,models,scheme,crud,services}.py` (model + schemas only for now), `features/incidents/{__init__,models,scheme,crud}.py`, `features/notifications/{__init__,models,scheme,crud}.py`
- Modify: `features/deploys/models.py` (+ `Deploy_Release`, columns `auto_recover` bool default True, `health_state` str default 'unknown', `last_health_at`, `bad_commit_sha`), `features/deploys/scheme.py` (`Deploy_Read` + `auto_recover`, `health_state`, `last_health_at`, `open_incident_id`), `features/deploys/crud.py`/`services.py` (list/get fill `open_incident_id` through a service wrapper, not an import of incidents models), `features/deploys/pipeline.py` (when a deploy reaches `running`, create a release: previous `current` → `previous`, new row `current` with `commit_sha`/`image_uri`; a redeploy that fails before `running` leaves releases unchanged), `shared/settings.py` (new settings listed below), `shared/database.py` (`ensure_columns`), `main.py` (import new models; run `ensure_columns` after `create_all`)
- Test: `tests/test_ops_models.py`, `tests/test_deploy_releases.py`, `tests/test_ensure_columns.py`

**Interfaces:**
- Produces tables: `health_checks(h_c_id, d_id FK CASCADE index, ok, status_code, latency_ms, detail, checked_at index)`, `incidents(i_id, d_id FK CASCADE index, kind, status, summary, explain Text, evidence Text, detected_at, resolved_at, created_at, updated_at)`, `recovery_actions(r_a_id, i_id FK CASCADE, action, d_r_id FK nullable, result, detail, started_at, finished_at)`, `deploy_releases(d_r_id, d_id FK CASCADE, commit_sha, image_uri, state, healthy_since nullable, created_at)`, `notifications(n_id, u_id nullable, d_id, i_id FK nullable, kind, channel, title, body, status, error, read_at, sent_at, created_at)` with index `(u_id, read_at)`, `push_devices(p_d_id, u_id nullable, expo_token unique, platform, created_at, last_seen_at)`, `notification_settings(id=1 single row: notify_email, notify_push default true, kinds JSON/Text default all six)`.
- Produces `Deploy_Release` + `Deploy_Service.services_deploy_release_record(db, d_id)` / `services_deploy_release_previous(db, d_id) -> Deploy_Release|None` (the newest release with state `previous` and a non-empty `image_uri`).
- Produces settings (env aliases): `HEALTH_MONITOR_ENABLED=true`, `HEALTH_INTERVAL_SECONDS=60`, `HEALTH_FAILURE_THRESHOLD=3`, `HEALTH_TIMEOUT_SECONDS=10`, `HEALTH_RETENTION_DAYS=7`, `RECOVERY_*` (above), `NEW_RELEASE_WINDOW_SECONDS=900`, `MAIL_HOST`, `MAIL_PORT=587`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM`, `MAIL_TO` (all optional; mail off when `MAIL_HOST`/`MAIL_TO` unset), `EXPO_PUSH_URL=https://exp.host/--/api/v2/push/send`, `APP_LINK_BASE=deploywizard://`.
- Produces `ensure_columns(conn)`: for the listed new `deploys` columns, if absent in the live SQLite table run `ALTER TABLE ... ADD COLUMN` with the model's default; idempotent.

- [ ] **Step 1: Write failing tests** — every table can be created and a row round-trips; `Deploy_Read` exposes the four new fields (`health_state` `unknown`, `auto_recover` true, `open_incident_id` null); `ensure_columns` on a hand-built old-schema SQLite (deploys without the new columns) adds them once and a second call changes nothing; two successful deploys record releases `previous` then `current`, a third marks the second `previous` and the first stays `previous` only if it is the newest previous (define: at most ONE `previous` kept as rollback target, older ones get state `old`—add to the allowed values), a failed redeploy leaves releases unchanged; `services_deploy_release_previous` ignores rows with empty `image_uri`.
- [ ] **Step 2: Run to confirm fail** (`pytest tests/test_ops_models.py tests/test_deploy_releases.py tests/test_ensure_columns.py -q`).
- [ ] **Step 3: Implement** models, schemas, settings, `ensure_columns`, pipeline hook; comments in Korean above each function. Update the `deploys.status` comment: unchanged.
- [ ] **Step 4: Run full `pytest -q`** → all pass (266 + new).
- [ ] **Step 5: Commit** `feat(ops): 헬스·인시던트·알림 테이블과 배포 버전 기록`

---

### Task 2: Health monitor and per-deploy settings

**Files:**
- Modify/Create: `features/health/{crud,services,router}.py`, `features/deploys/router.py` (`PATCH /{d_id}/settings`, `GET /{d_id}/health-history`), `features/deploys/services.py` (settings update; `health_state` writes go through a service method), `main.py` (start/stop the monitor loop; disabled when `HEALTH_MONITOR_ENABLED` false), `docs/api-spec.md`
- Test: `tests/test_health_monitor.py`, `tests/test_deploy_settings_api.py`

**Interfaces:**
- Produces `Health_Service.services_health_check_once(db, now=None, checker=None) -> list[int]` (checks every `running` deploy with an `endpoint`, bounded concurrency 10, each GET uses `HEALTH_TIMEOUT_SECONDS`; `checker(url) -> (ok, status_code, latency_ms, detail)` injectable; saves `health_checks`, updates `deploys.health_state` (`healthy`/`unhealthy`) and `last_health_at`, calls `Incident_Service.services_incident_on_result(db, d_id, ok)` per deploy; returns checked d_ids; a deploy's exception is swallowed and logged without secrets), `Health_Service.services_health_monitor_loop()` (sleep `HEALTH_INTERVAL_SECONDS`, prune rows older than `HEALTH_RETENTION_DAYS`), `Health_Service.services_health_consecutive_failures(db, d_id) -> int`, `services_health_history(db, d_id, hours) -> list[Health_Check_Read]` (hours 1..168, max 1440 rows, oldest first).
- Produces `PATCH /api/deploys/{d_id}/settings` body `{auto_redeploy?: bool, auto_recover?: bool}` (unknown fields rejected, empty body 400, deleted/unknown deploy 404) → `Deploy_Read`; `GET /api/deploys/{d_id}/health-history?hours=24` → `Health_Check_Read[]`.
- Consumes `Incident_Service.services_incident_on_result` — stub in this task (no-op returning None) so the loop can be tested; Task 3 fills it.

- [ ] **Step 1: Write failing tests** — success/failure rows saved; non-`running` and endpoint-less deploys skipped; one slow/raising checker does not stop the others; `health_state` flips; the 3-failure count helper (failures after the last success); history bounds (hours 0 and 200 → 422) and order; retention prune deletes only old rows; settings PATCH changes only sent fields, rejects unknown fields and empty body, 404 for a deleted deploy; the monitor loop is not started when disabled (unit-test the start decision, not `main.py` I/O).
- [ ] **Step 2: Run to confirm fail.**
- [ ] **Step 3: Implement.** Health GET follows redirects like `services_deploy_health` but only to the deploy's own `endpoint` URL.
- [ ] **Step 4: Run full `pytest -q`.**
- [ ] **Step 5: Commit** `feat(ops): 상태 감시 루프와 배포 설정·헬스 이력 API`

---

### Task 3: Incident detection, rule-table explain, incident API

**Files:**
- Modify/Create: `features/incidents/{crud,services,router,scheme}.py`, `features/express/services.py` only if a read helper is missing (use `services_express_describe`), `main.py` (include router), `docs/api-spec.md`
- Test: `tests/test_incidents.py`, `tests/test_incident_api.py`

**Interfaces:**
- Produces `Incident_Service.services_incident_on_result(db, d_id, ok, now=None)`: on a failure, when `Health_Service.services_health_consecutive_failures >= HEALTH_FAILURE_THRESHOLD` and the deploy has no `open`/`recovering` incident → create one (`status=open`, `kind` chosen by `services_incident_pick_kind`: `bad_release` if the current release is younger than `NEW_RELEASE_WINDOW_SECONDS` and a previous release exists, `crash_loop` if the last failures are connection refused, otherwise `unhealthy`), collect evidence, explain, notify (`incident_opened`), then hand to `Recovery_Service.services_recovery_start` (stub returning None in this task; `auto_recover` off → set `needs_action` and notify `incident_needs_action`); on a success with an `open`/`needs_action` incident whose deploy is healthy again → resolved (`resolved_at`) and notify `incident_recovered` only if the incident had been `recovering`.
- Produces `services_incident_collect_evidence(db, d_id, session=None) -> str` (masked, ≤ 4000 chars: service status from `services_express_describe` via the deploy's AWS session when available — injectable, failures tolerated — plus the last 5 health check lines), `services_incident_explain(kind, evidence, last_details) -> Incident_Explain` rule table (min. rules: connection refused / timeout / HTTP 5xx / HTTP 404 on the health path / describe says not running / unknown→default guidance; each rule has `summary`, `cause`, `fix_where` (a sentence pointing at the user's repo setting or console place, never claiming to fix code), `actions[]`, `source='rule'`; default `source='none'`), `Incident_Explain` Pydantic model.
- Produces API per `docs/app-web/04-api-spec.md` §3: `GET /api/incidents?status=&d_id=&after=` (limit 100, newest first), `GET /api/incidents/{i_id}` → `Incident_Detail` with `actions[]`, `GET /api/deploys/{d_id}/incidents`. 404 Korean messages.
- Consumes `Notification_Service.services_notification_send_incident(db, incident, kind)` — stub (no-op) until Task 5.

- [ ] **Step 1: Write failing tests** — the threshold is exactly 3 consecutive failures (2 failures + success + 2 failures = no incident); only one open incident per deploy under repeated calls; kind selection (bad_release inside the window with a previous release, otherwise by details); explain rules produce masked text (a token-looking string in a health `detail` never appears in `explain`/`evidence`); `auto_recover=false` → `needs_action` and no recovery start; healthy again → `resolved`; API list filters/ordering/`after`; detail includes actions ordered by time; unknown ids 404; `open_incident_id` appears in `Deploy_Read`.
- [ ] **Step 2: Run to confirm fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run full `pytest -q`.**
- [ ] **Step 5: Commit** `feat(ops): 인시던트 감지·원인 설명(규칙 표)·조회 API`

---

### Task 4: Recovery executor — restart, rollback, verification

**Files:**
- Create: `features/incidents/recovery.py` (class `Recovery_Service`, kept out of `services.py` to keep files small), `features/watches/services.py` (skip auto-redeploy when the remote commit equals `deploys.bad_commit_sha` — via `Deploy_Service` method), `docs/aws-notes.md`
- Modify: `features/incidents/services.py` (call `Recovery_Service.services_recovery_start`), `features/deploys/services.py` (`services_deploy_apply_rollback(db, d_id, release)` updates `image_uri`, `commit_sha`, marks `bad_commit_sha`, release states), `main.py` (resume `recovering` incidents on startup)
- Test: `tests/test_recovery.py`, `tests/test_recovery_limits.py`, `tests/test_watch_bad_commit.py`

**Interfaces:**
- Produces `Recovery_Service.services_recovery_start(db, i_id, updater=None, waiter=None, sleeper=None)` (async; per-deploy `asyncio.Lock`; runs as a background task created by the incident service, errors caught and turned into `needs_action` with a masked detail): re-checks every condition in code — deploy `running`, `auto_recover` on, incident `open`, attempts < `RECOVERY_MAX_ATTEMPTS_PER_INCIDENT`, automatic actions in the last 24 h < `RECOVERY_DAILY_LIMIT` — then plan by the rule table: kind `bad_release` with a previous release → rollback only; otherwise restart first, then rollback if the restart's verification fails; no previous release (or its `image_uri` empty) → no rollback, `needs_action`. Each attempt = `recovery_actions` row (`running` → `ok|failed`), `incident.status=recovering` while running, notification only on terminal states.
- Execution: restart = `Express_Service.services_express_update(session, service_arn, image_uri, port, …)` with the deploy's current image; rollback = same call with the previous release image (all other arguments exactly as the pipeline passes them — read `pipeline.py` ~:325 and reuse the same helper rather than re-deriving them); AWS session through the same `pipeline_get_aws_session`-style service used by the pipeline (via `Aws_Account_Service`, not an import of pipeline internals — extract a shared service method if needed). After an action: `sleeper(RECOVERY_WAIT_SECONDS)`, then poll `Health_Service` checks every 15 s for up to `RECOVERY_VERIFY_SECONDS`; `RECOVERY_VERIFY_OK_COUNT=3` consecutive OK → success.
- Success → incident `resolved`, notify `incident_recovered`; for rollback also `Deploy_Service.services_deploy_apply_rollback` (current→`failed`, previous→`current`, `deploys.bad_commit_sha` = the bad commit). Failure of all allowed attempts → `needs_action`, notify `incident_needs_action`.
- Watch interaction: `Watch_Service` must not trigger an automatic redeploy while the newest remote commit equals `bad_commit_sha`; a newer commit clears it.
- Startup: `Recovery_Service.services_recovery_resume(db)` — incidents left `recovering` after a server restart become `needs_action` with the detail `서버가 다시 시작되어 자동 복구가 중단되었습니다` (no half-run loops).

- [ ] **Step 1: Write failing tests** with fake `updater`/`sleeper`/health results — restart success; restart fails → rollback success; `bad_release` goes straight to rollback; no previous release → `needs_action` and zero AWS calls; `auto_recover` off / deploy not running / no open incident / attempts exhausted / daily limit reached → zero AWS calls (parametrized); two concurrent starts → one execution; AWS error text is masked in `detail`; rollback sets `bad_commit_sha` and the watch poll does not redeploy it (and does for a newer commit); resume turns `recovering` into `needs_action`; the update call receives the unchanged image for restart and the previous image for rollback.
- [ ] **Step 2: Run to confirm fail.**
- [ ] **Step 3: Implement; add to `docs/aws-notes.md` a short "운영 복구 (2026-11-10, 실제 AWS 미검증)" section: restart = same-image update (effect unverified), rollback = update with the previous image (needs the image to still exist in ECR; `session_end.py` deletes images → those releases cannot be rolled back).**
- [ ] **Step 4: Run full `pytest -q`.**
- [ ] **Step 5: Commit** `feat(ops): 자동 복구(재시작·이전 정상 버전 되돌리기)와 한도`

---

### Task 5: Notifications — in-app, email, Expo push, devices, settings

**Files:**
- Modify/Create: `features/notifications/{crud,services,router,scheme}.py`, `features/notifications/dispatch.py` (mail + push senders), `features/deploys/pipeline.py` (notify `deploy_succeeded`/`deploy_failed` at the terminal points through `Notification_Service`), `features/watches/services.py` (`new_commit` notification when a new commit is first seen), `features/incidents/services.py` (replace the stub), `main.py` (include router), `docs/api-spec.md`, `.env.example` (if present)
- Test: `tests/test_notifications.py`, `tests/test_notification_dispatch.py`, `tests/test_notification_api.py`

**Interfaces:**
- Produces `Notification_Service.services_notification_send_incident(db, incident, kind, mailer=None, pusher=None)` and `services_notification_send_deploy(db, deploy, kind, …)`: build title/body (Korean; body order ① what ② why ③ where to fix ④ what was done automatically and the result ⑤ app link `APP_LINK_BASE + incidents/{i_id}`), `mask_text` everything, respect `notification_settings` (email on/off, push on/off, kinds list), save an `inapp` row always (if the kind is enabled), then `email`/`push` rows with `status` `queued→sent|failed` and `error` (masked); one incident+kind combination produces at most one row per channel (duplicates suppressed); a channel failure never raises.
- Produces mail: `dispatch_mail_send(subject, body)` using `smtplib.SMTP(MAIL_HOST, MAIL_PORT)` + STARTTLS + login in `asyncio.to_thread`, subject `[배포 마법사] {service} {title}`, no-op with status `failed` and error `메일 설정이 없습니다` is NOT written when mail is unconfigured (skip silently, no row); push: `dispatch_push_send(devices, title, body, link)` POSTs batches of ≤ 100 messages `{to, title, body, data:{link}}` to `EXPO_PUSH_URL` with httpx; response tickets with `details.error == 'DeviceNotRegistered'` delete that `push_devices` row; body ≤ 120 chars, no logs.
- Produces API: notifications (§4: list with `after`/`unread`, `unread-count`, `read`, `read-all`), devices (`POST /api/devices` `{expo_token, platform}` — token must match `^(Exponent|Expo)PushToken\[.+\]$`, platform `ios|android` — upsert, 201 `Device_Read` with masked token; `DELETE /api/devices/{p_d_id}`), settings (`GET/PATCH /api/notifications/settings` → `{notify_email, notify_push, kinds[]}`; unknown kinds rejected).
- Pre-login rule: all rows have `u_id` null; the settings table has a single row created on first read.

- [ ] **Step 1: Write failing tests** — composed texts contain no token-looking secret (feed a fake `AKIA…`/`ghp_…` in the incident explain and assert masked in all three channels); settings gates (push off → no push row; kind off → nothing); duplicate suppression; mail sender called with the right subject/body, unconfigured mail → no row and no exception; push batches of 100 for 250 devices, `DeviceNotRegistered` removes only that device; Expo HTTP error → `failed` row, no exception to the caller; API list/unread/read/read-all; invalid token format 422; masked token in `Device_Read`; deploy succeeded/failed/new_commit notifications fire once.
- [ ] **Step 2: Run to confirm fail.**
- [ ] **Step 3: Implement.** Verify the Expo Push request/response shape against the official docs (https://docs.expo.dev/push-notifications/sending-notifications/) before coding; never invent fields.
- [ ] **Step 4: Run full `pytest -q`.**
- [ ] **Step 5: Commit** `feat(ops): 알림(앱 안·메일·Expo 푸시)과 기기·설정 API`

---

### Task 6: End-to-end integration test, docs, cross-check

**Files:**
- Create: `tests/test_ops_flow.py`
- Modify: `docs/api-spec.md` (final pass over §Health/Incidents/Notifications/Devices/Settings), `docs/architecture.md` (monitor loop, recovery limits, new folders), `docs/features.md` (where new code goes), `docs/milestones.md` if it lists this work, `HISTORY.md` (one row, terse English; the file contains one pre-existing NUL byte which must be preserved — edit as bytes), `docs/worklog/2026-11-10.md` (create, terse English)
- Verify: `.venv/Scripts/python.exe -m pytest -q`

- [ ] **Step 1: Write the flow test** with fakes: deploy `running` with a previous release → 3 failing checks → incident `open` → `incident_opened` notification rows (inapp + email + push) → restart fails verification → rollback succeeds → incident `resolved`, 2 `recovery_actions`, `incident_recovered` notification, `deploys.image_uri`/`bad_commit_sha` updated, watch poll does not redeploy the bad commit; second scenario: `auto_recover=false` → `needs_action` with zero AWS calls; third: no previous release → `needs_action` after restart failure.
- [ ] **Step 2: Run** → pass; then full `pytest -q` (expect 266 + new, 2 skipped).
- [ ] **Step 3: Docs.** State plainly: nothing ran against real AWS, real SMTP or the real Expo push service; restart effect unverified; log/event collection and the D12 operations agent are NOT built (rule table only); u_id null until login; the existing `data/wizard.db` gets columns through `ensure_columns`.
- [ ] **Step 4: Commit** `docs(ops): 운영 복구·알림 구조와 작업 기록`

---

## Self-review

- **Coverage:** D-01 (T2), D-02 (T3), D-03 partial (evidence from describe + health; logs/events unverified — not built), D-04 rule table + default (T3), D-04a/agent NOT built (needs the verified read tools; a later plan, noted in docs), D-05/D-06 (T4), D-08 data (T2), D-09 (T2), E-01/E-02/E-04/E-05 server side (T5), E-03 data (T5). Screens, push permission, token registration from the device, notification taps and settings UI are Plan D2 (app).
- **Not in this plan:** operations agent (D12), log/event collection, login-scoped notifications (u_id), per-kind mail grouping beyond duplicate suppression, EAS/FCM/APNs credentials.
- **Unverified by design:** same-image update restarting tasks; rollback via image update; Expo push and SMTP delivery; CloudWatch/ECS events.
- **Type consistency:** `Incident_Service.services_incident_on_result` (stub in T2, real in T3); `Recovery_Service.services_recovery_start` (stub in T3, real in T4); `Notification_Service.services_notification_send_incident` (stub in T3, real in T5); `Deploy_Release` created in T1 and used in T3/T4; settings names defined once in T1.
