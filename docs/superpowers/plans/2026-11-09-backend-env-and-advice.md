# Backend: Env-Var Detection/Input and Pre-Deploy Advice — Implementation Plan (Plan A of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add backend support for (1) finding env-var *names* in a cloned repo and collecting values from the user before the first deploy, and (2) a read-only "analyze before deploy" endpoint that returns a size tier, needs, and confidence.

**Architecture:** Two new feature folders: `features/envvars/` (table, scanner, classifier, service, router) and `features/advice/` (signals, tier rules, router). `pipeline.py` stays the only assembly point: it scans at `analyzing`, pauses before the first `deploying` with new status `needs_input`, and injects plain config values through the already-verified `primaryContainer.environment`. Secret-kind values are NOT stored yet (decision D8 unverified) — the API answers 501.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0 async (SQLite), Pydantic v2, pytest + pytest-asyncio, existing `LLM_Client.llm_parse`.

**Spec:** `docs/app-web/02-feature-spec.md` sections H and I, `03-db-erd.md` (`deploy_env_vars`), `04-api-spec.md` ("배포 수준·비용 추천", "환경변수"), `05-flowcharts.md` flows 6 and 7, `01-requirements.md` (FR-14..21, D8, D9, D10, D11). Plans B (web UI) and C (Expo app) come later and consume these APIs.

## Global Constraints

- Follow `docs/conventions.md`: classes `Pascal_Snake`; functions `<layer>_<domain>_<action>` (`services_env_scan`, `crud_env_get_by_d_id`, `router_env_get_all`); Service/Crud are classes of `@staticmethod`; first arg `db: AsyncSession` if DB; CRUD only `flush()`; commit/rollback/HTTPException only in Service; one-line Korean comment above every function, no docstrings; keep existing `=` spacing; absolute imports; user-facing strings Korean.
- PK/FK short names: `d_e_id` (deploy_env_vars), FK `d_id`.
- Hard rule 2: no new Express Mode API. Only `primaryContainer.environment[{name,value}]` (documented in `docs/aws-notes.md` for create and update).
- Hard rule 4: LLM only fills a fixed-list blank (`Env_Kind_Pick`) via `LLM_Client.llm_parse`; official languages must work with LLM off.
- Hard rule 5: never send the whole repo to the LLM; the exclude filter in `features/repos/services.py` (`EXCLUDE_DIRS`, `EXCLUDE_FILES`) is NOT loosened. `.env.example` is read only by the new scanner, names only.
- Hard rule 6: env var **values** never appear in logs, API responses, LLM prompts, DB columns other than `plain_value` (config kind only), or error messages.
- Hard rule 10: new status `needs_input` changes `features/deploys/models.py` comment, `features/deploys/ui/constants.js`, `CLAUDE.md` status flow, in the same task. `PROGRESS_STATUSES` intentionally does NOT include it (waiting, not running; `pipeline_recover` must leave it alone).
- API change → `docs/api-spec.md` updated in the same change (Task 8).
- Tests never call real AWS/LLM/Docker/GitHub. Run `pytest tests/<file> -v` per task; full `pytest` only at Task 8 (slow; CPU is shared).
- Branch: create `feat/backend-env-advice` from `docs/app-web-design`. Commits: Conventional Commits, Korean body, end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Existing behavior unchanged: deploys without env vars, and `docs/api-spec.md` responses, keep working (new fields only added with defaults).

## Review Focus

- Value leakage: a `.env.example`/compose value, or a hard-coded secret in code, showing up in scan results, `GET .../env` JSON, pipeline log lines, or the LLM prompt. Expect: never (Tasks 2, 3, 4, 5).
- Server restart while a deploy waits in `needs_input`: `pipeline_recover` must not flip it to `failed` (Task 5).
- Redeploy of a running service: `services_express_update` replaces `primaryContainer`, so env must be re-sent or the redeploy silently drops it (Task 5).
- Hostile/odd repos: huge or binary or UTF-16 source files, thousands of files, `node_modules`, test folders. Expect: no crash, bounded work, test-only variable names ignored (Task 2).
- Names the scanner cannot see (computed names, config files, pydantic-settings field names): scan must not claim completeness; the API/UI keep the "may be missing" path via runtime-error names (Tasks 2, 6).

---

### Task 1: `envvars` feature skeleton (table, schemes, CRUD)

**Files:**
- Create: `features/envvars/__init__.py`, `features/envvars/models.py`, `features/envvars/scheme.py`, `features/envvars/crud.py`
- Modify: `main.py` (import `features.envvars.models` next to the other model imports so `create_all` sees it)
- Test: `tests/test_envvars_crud.py`

**Interfaces:**
- Produces (scheme.py): constants `ENV_KINDS=('database','cache','external_api','secret','config','unknown')`, `ENV_SECRET_KINDS={'database','cache','external_api','secret'}`, `ENV_SOURCES=('code','compose','example','runtime_error','user')`, `ENV_STATUSES=('detected','set','skipped')`.
- Produces (scheme.py): `Env_Found(name:str, required:bool, has_default:bool, kind:str='unknown', source:str, source_hint:str|None=None)`; `Env_Read(d_e_id:int, d_id:int, name:str, required:bool, has_default:bool, kind:str, source:str, source_hint:str|None, status:str, has_value:bool, needs_redeploy:bool=False)`; `Env_Update(value:str|None=None, kind:str|None=None, skip:bool|None=None)`; `Env_Kind_Pick(kind: Literal[...ENV_KINDS])`.
- Produces (models.py): `Deploy_Env_Var` table `deploy_env_vars` with columns exactly as `03-db-erd.md` (`d_e_id`, `d_id` FK `deploys.d_id` ondelete CASCADE + index, `name`, `required`, `has_default`, `kind`, `source`, `source_hint`, `status` default `'detected'`, `storage` default `'none'` (`none|plain|secret_store`), `plain_value`, `secret_ref`, `created_at`, `updated_at`), `UniqueConstraint('d_id','name')`.
- Produces (crud.py `Env_Crud`): `crud_env_get_by_d_id(db, d_id) -> list[Deploy_Env_Var]` (ordered by name); `crud_env_get(db, d_id, name) -> Deploy_Env_Var|None`; `crud_env_upsert_found(db, d_id, found:Env_Found) -> Deploy_Env_Var`; `crud_env_update(db, d_id, name, update_data:dict) -> Deploy_Env_Var|None`; `crud_env_count_pending(db, d_id) -> int`; `crud_env_count_pending_many(db, d_ids:list[int]) -> dict[int,int]`.

- [ ] **Step 1: Write failing tests** in `tests/test_envvars_crud.py` (fixture: drop/create all tables like `tests/test_deploys_api.py`, insert a `Deploy` row first):
  - `test_env_upsert_inserts_then_updates_not_duplicates`: two `crud_env_upsert_found` calls for the same name → one row.
  - `test_env_upsert_keeps_user_state`: after `crud_env_update(..., {"status":"set","kind":"config","storage":"plain","plain_value":"x"})`, upserting the same name again with `kind='unknown'` leaves status/kind/plain_value unchanged; a rescan may only fill `kind` when the stored kind is `'unknown'`.
  - `test_env_count_pending_counts_required_detected_only`: required+detected counts; skipped, set, and `required=False` do not. `crud_env_count_pending_many([d1,d2,d3])` returns `{d1:n,...}` with 0 for deploys without rows.
- [ ] **Step 2: Run** `pytest tests/test_envvars_crud.py -v` — Expected: FAIL (ImportError).
- [ ] **Step 3: Implement** models, scheme, crud as specified; register the model import in `main.py`. One approach note: `crud_env_upsert_found` does select-then-insert/update inside the caller's session (flush only).
- [ ] **Step 4: Run** the same command — Expected: 3 passed. Also run `pytest tests/test_deploys_api.py -v` — Expected: still passes (new table does not disturb it).
- [ ] **Step 5: Commit** `feat(envvars): deploy_env_vars 표와 CRUD`

---

### Task 2: Env-var scanner (names only)

**Files:**
- Create: `features/envvars/scan.py`
- Test: `tests/test_envvars_scan.py`

**Interfaces:**
- Consumes: `Env_Found` (Task 1); `EXCLUDE_DIRS`, `EXCLUDE_FILES` from `features.repos.services` (import the constants, do not copy).
- Produces (`Env_Scan_Service`): 
  - `services_env_scan_text(file_name:str, text:str) -> list[Env_Found]` — pure; picks Python or Node rules by extension, returns one entry per occurrence with `source='code'` and `source_hint=f"{file_name}:{line}"`.
  - `services_env_scan_compose(text:str) -> list[Env_Found]` (`source='compose'`).
  - `services_env_scan_example(text:str) -> list[Env_Found]` (`source='example'`).
  - `services_env_scan(app_path:Path) -> list[Env_Found]` — walks the app, merges by name, sorted by name.
- Constants in `scan.py`: `IGNORED_NAMES={'PATH','HOME','PWD','USER','HOSTNAME','LANG','TZ','NODE_ENV','PORT','PYTHONPATH','PYTHONDONTWRITEBYTECODE','PYTHONUNBUFFERED'}` (NODE_ENV and PORT are set by `features/dockerfiles/templates/*.Dockerfile`), `SKIP_DIRS=EXCLUDE_DIRS | {'tests','test','__tests__','spec','e2e','docs','examples','example'}`, `MAX_FILES=500`, `MAX_FILE_BYTES=200_000`, example files `('.env.example','.env.sample','.env.template')`.

Rules (values are never stored; only `has_default` is derived):
- Python: `os.environ["X"]`/`['X']` → required; `os.environ.get("X"[, default])` and `os.getenv("X"[, default])` → `has_default` iff a second argument exists; `Field(..., alias="X")` / `Field(<default>, alias="X")` → name from alias, `has_default` iff first arg is not `...`.
- Node: `process.env.X`, `process.env["X"]`, `import.meta.env.X`; `has_default` iff `||` or `??` follows on the same line.
- Names must match `^[A-Za-z_][A-Za-z0-9_]*$`; computed names (`environ[prefix + "_KEY"]`) are not matched.
- `required = not has_default`. Merging by name: code wins over compose over example; for code, `has_default` is true only if every occurrence has a default.
- Example files: `has_default` true iff the value is non-empty and not placeholder-like (contains `your`, `xxx`, `changeme`, `<`, `example`, case-insensitive). Compose `environment:` list and map forms; `${NAME}` without `:-default` → required.

- [ ] **Step 1: Write failing tests** (use `tmp_path` repos; params table-driven):
  - `test_scan_python_patterns`: `os.environ["A"]` → A required; `os.getenv("B")` required; `os.getenv("C","x")` has_default; `os.environ.get("D", None)` has_default; `Field("x", alias="E")` has_default; `Field(..., alias="F")` required.
  - `test_scan_node_patterns`: `process.env.G`, `process.env["H"]`, `import.meta.env.VITE_I`, `process.env.J || "d"` (has_default).
  - `test_scan_arbitrary_names_found`: `os.getenv("MY_THING_URL")` is found (no name table).
  - `test_scan_computed_name_not_found`: `os.environ[prefix + "_KEY"]` yields nothing.
  - `test_scan_ignores_template_set_names`: `PORT`, `NODE_ENV`, `PATH` never returned.
  - `test_scan_skips_test_and_vendor_dirs`: var read only in `tests/x.py` or `node_modules/m/i.js` is absent.
  - `test_scan_example_names_only_and_never_values`: `.env.example` with `API_KEY=sk-live-123456` and `PORT=8000`; `json.dumps([f.model_dump() for f in result])` does not contain `sk-live-123456`; `API_KEY` required, `PORT` ignored.
  - `test_scan_real_dotenv_is_never_read`: a `.env` file containing `SECRET=hunter2` and no code reference → no `SECRET`, and `hunter2` absent from the dumped result.
  - `test_scan_compose_environment`: list and map forms, `X=${X}` required, `Y: literal` has_default.
  - `test_scan_merge_rules`: same name in code (no default) and example (default) → required, source `code`.
  - `test_scan_is_bounded_and_crash_free`: 600 tiny files → at most `MAX_FILES` read; a 300 KB file skipped; a UTF-16 file and a binary blob with `.py` extension do not raise.
- [ ] **Step 2: Run** `pytest tests/test_envvars_scan.py -v` — Expected: FAIL (ImportError).
- [ ] **Step 3: Implement** `Env_Scan_Service` with compiled regexes at module level; read files with `read_bytes()` and decode UTF-8 then UTF-16 fallback with `errors='ignore'`; return at most one `Env_Found` per (name, source) after merge.
- [ ] **Step 4: Run** — Expected: all pass.
- [ ] **Step 5: Commit** `feat(envvars): 소스에서 환경변수 이름만 찾는 스캐너`

---

### Task 3: Kind classification (rules, then one fixed-list LLM pick)

**Files:**
- Create: `features/envvars/services.py` (class `Env_Service`; later tasks add to it)
- Test: `tests/test_envvars_classify.py`

**Interfaces:**
- Consumes: `Env_Found`, `Env_Kind_Pick`, `Env_Scan_Service.services_env_scan` (Task 2); `LLM_Client.llm_parse`, `LLM_Unavailable` (`shared/llm.py`); `mask_text`.
- Produces:
  - `Env_Service.services_env_classify_rule(app_path:Path, found:list[Env_Found]) -> list[Env_Found]` — sets `kind` from the line that reads the variable and, if the value is assigned to a local name, lines in the same file that use that name. Hint table `KIND_HINTS` (regex → kind): `create_engine|create_async_engine|psycopg|pymysql|asyncpg|pymongo|MongoClient|mongoose\.connect|new Pool|PrismaClient` → `database`; `redis|Redis|ioredis|createClient` → `cache`; `stripe|openai|anthropic|sendgrid|twilio|api_key|apiKey|Bearer` → `external_api`; `jwt|SECRET_KEY|signing|cookie.?secret|bcrypt` → `secret`. Name hints apply only if no usage hint matched: `DEBUG|LOG_LEVEL|ENVIRONMENT|APP_NAME|TIMEZONE` → `config`, `DATABASE|POSTGRES|MYSQL|MONGO` → `database`, `REDIS` → `cache`, `SECRET|TOKEN|PASSWORD|API_KEY` → `secret`.
  - `Env_Service.services_env_context(app_path:Path, found:Env_Found) -> str` — at most 7 lines (3 before, line, 3 after) around `source_hint`; `''` if no hint.
  - `async Env_Service.services_env_classify_llm(app_path:Path, found:list[Env_Found]) -> list[Env_Found]` — for `kind=='unknown'` only, at most `MAX_LLM_PICKS=20` per call, one `llm_parse(SYSTEM_ENV_KIND, prompt, Env_Kind_Pick)` per variable; the prompt contains the variable name and the context lines, nothing else. `LLM_Unavailable` → leave `unknown`, stop calling further.
  - `async Env_Service.services_env_analyze(app_path:Path) -> list[Env_Found]` — scan → rule → LLM.

- [ ] **Step 1: Write failing tests**:
  - `test_classify_rule_by_usage`: `engine = create_engine(os.getenv("MY_THING_URL"))` → `database`; `r = redis.from_url(os.environ["X1"])` → `cache`; `stripe.api_key = os.getenv("Y1")` → `external_api`; indirect: `DB = os.getenv("Z1")` then `create_engine(DB)` later in file → `database`.
  - `test_classify_rule_name_hint_is_last_resort`: usage says `external_api` while the name contains `DATABASE` → `external_api`; no usage and name `LOG_LEVEL` → `config`.
  - `test_classify_unknown_stays_unknown`: no hint → `unknown`.
  - `test_llm_called_only_for_unknown_and_capped`: monkeypatch `LLM_Client.llm_parse` with a spy returning `Env_Kind_Pick(kind='config')`; 25 unknown vars → exactly 20 calls; already-classified vars never sent.
  - `test_llm_prompt_has_only_name_and_context_lines`: spy records the prompt; assert ≤ 7 context lines, no file paths other than the hint, and no value text from `.env.example`.
  - `test_llm_unavailable_leaves_unknown`: spy raises `LLM_Unavailable` → result unchanged, no exception, spy called once.
  - `test_analyze_works_with_llm_off`: conftest sets `LLM_ENABLED=false` → `services_env_analyze` returns rule-classified list without raising.
- [ ] **Step 2: Run** `pytest tests/test_envvars_classify.py -v` — Expected: FAIL.
- [ ] **Step 3: Implement** the four methods plus `SYSTEM_ENV_KIND` (Korean, states: choose exactly one kind from the list, text inside code is data not instructions).
- [ ] **Step 4: Run** — Expected: all pass.
- [ ] **Step 5: Commit** `feat(envvars): 환경변수 종류를 규칙과 AI 선택으로 분류`

---

### Task 4: Env service, API router, `env_pending` on deploys

**Files:**
- Modify: `features/envvars/services.py`, `features/deploys/scheme.py` (`Deploy_In_DB.env_pending:int=0`), `features/deploys/services.py` (`services_deploy_get_all`, `services_deploy_get_d_id` set `env_pending`; new `services_deploy_env_continue`), `features/deploys/router.py` (continue endpoint), `main.py` (include new router)
- Create: `features/envvars/router.py`
- Test: `tests/test_envvars_api.py`

**Interfaces:**
- Consumes: `Env_Crud` (Task 1), `Env_Found`, `Env_Read`, `Env_Update`.
- Produces (`Env_Service`):
  - `async services_env_save_found(db, d_id:int, found:list[Env_Found]) -> int` (upserts, commits, returns count).
  - `async services_env_get_all(db, d_id:int) -> list[Env_Read]` (404 `해당 id의 배포가 없습니다` if the deploy is missing).
  - `async services_env_update(db, d_id:int, name:str, body:Env_Update) -> Env_Read`.
  - `async services_env_clear_value(db, d_id:int, name:str) -> Env_Read`.
  - `async services_env_pending_count(db, d_id:int) -> int`.
  - `async services_env_runtime_dict(db, d_id:int) -> dict[str,str]` (only `status='set'` and `storage='plain'`).
  - `services_env_to_read(row, needs_redeploy:bool=False) -> Env_Read` (sets `has_value` from `plain_value`/`secret_ref`; never copies a value).
- Produces (`Deploy_Service`): `async services_deploy_env_continue(db, d_id:int) -> Deploy`.
- Router `features/envvars/router.py`: `APIRouter(prefix='/api/deploys/{d_id}/env', tags=['Env'])`: `GET ''` → `list[Env_Read]`; `PUT '/{name}'` body `Env_Update` → `Env_Read`; `DELETE '/{name}/value'` → `Env_Read`. In `deploys/router.py`: `POST '/{d_id}/env/continue'` → `Deploy_Read`.

Behavior of `services_env_update` (exact messages):
- name must match `^[A-Za-z_][A-Za-z0-9_]{0,99}$` else 400 `환경변수 이름이 올바르지 않습니다`.
- unknown name → create with `source='user'`, `required=True`.
- `skip=True` → status `skipped`.
- `kind` given → must be in `ENV_KINDS` else 400; stored.
- `value` given: if resulting kind is `unknown` → 400 `종류를 먼저 골라 주세요`; if kind in `ENV_SECRET_KINDS` → 501 `시크릿 값 저장은 아직 지원하지 않습니다 (사용자 AWS 보안 저장소 검증 후 지원)`; else (`config`) store `plain_value`, `storage='plain'`, `status='set'`. Value max length 2000 else 400.
- `needs_redeploy=True` in the response iff the deploy has a `service_arn` and a value changed.
- The response and every log line never include the value.

- [ ] **Step 1: Write failing tests** (client fixture copied from `tests/test_deploys_api.py`; create a deploy via POST first):
  - `test_env_list_empty_then_after_save_found`.
  - `test_env_put_config_value_has_value_true_and_no_value_key`: response JSON has `has_value: true` and `"value" not in body` and the literal value string not in `response.text`.
  - `test_env_put_secret_kind_returns_501`; `test_env_put_unknown_kind_with_value_returns_400`; `test_env_put_bad_name_returns_400`; `test_env_put_new_name_source_user`; `test_env_put_skip`; `test_env_delete_value_clears`.
  - `test_env_runtime_dict_only_set_plain`.
  - `test_env_continue_409_when_not_needs_input`; `test_env_continue_409_lists_missing_names` (detail contains the names, not values); `test_env_continue_starts_pipeline_at_deploying` (`client.start_steps == ['deploying']`, status becomes `queued`).
  - `test_deploy_get_includes_env_pending`: after saving 2 required detected vars, `GET /api/deploys/{id}` and the list show `env_pending == 2`.
- [ ] **Step 2: Run** `pytest tests/test_envvars_api.py -v` — Expected: FAIL.
- [ ] **Step 3: Implement** service methods, router, `Deploy_In_DB.env_pending`, `services_deploy_env_continue` (409 `입력이 필요한 상태의 배포만 이어서 배포할 수 있습니다` when status ≠ `needs_input`; 409 `필수 환경변수에 값이 없습니다 :A, B` when pending > 0; otherwise set `queued`, commit, `Deploy_Pipeline.pipeline_start(d_id, 'deploying')`). Set `env_pending` on the ORM objects via `Env_Crud.crud_env_count_pending_many` before returning. Include the router in `main.py`.
- [ ] **Step 4: Run** `pytest tests/test_envvars_api.py tests/test_deploys_api.py -v` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(envvars): 환경변수 목록·입력 API와 이어서 배포`

---

### Task 5: `needs_input` status, pipeline pause/resume, env injection

**Files:**
- Modify: `features/deploys/pipeline.py`, `features/express/services.py` (`services_express_update` gets `environment`), `features/deploys/models.py` (status comment), `features/deploys/ui/constants.js` (label), `CLAUDE.md` (status flow)
- Read first: `features/deploys/services.py::services_deploy_session_end` (leftover cleanup of failed deploys)
- Test: `tests/test_pipeline_env.py`

**Interfaces:**
- Consumes: `Env_Service.services_env_analyze`, `services_env_save_found`, `services_env_pending_count`, `services_env_runtime_dict` (Tasks 3, 4).
- Produces: `Deploy_Pipeline.pipeline_save_envs(d_id:int, found:list[Env_Found]) -> None`; `Express_Service.services_express_update(session, service_arn, image_uri, port, health_check_path="/", environment:dict[str,str]|None=None) -> None` (adds `primaryContainer["environment"]=[{"name":k,"value":v},...]` only when non-empty).
- Status wiring: `deploys.status` gains `needs_input`; `PROGRESS_STATUSES` unchanged; `CLAUDE.md` flow line becomes `... pushing -> (needs_input ->) deploying -> running`; `constants.js` label `needs_input: '입력 필요'`.

Pipeline behavior:
- After `services_repo_detect` (inside `resume_index <= 1`): `found = await Env_Service.services_env_analyze(app_path)`; `pipeline_save_envs`; log `환경변수 {n}개를 찾았습니다 (필수 {m}개)` — names are NOT logged here.
- Before step 6, only when `service_arn` is None (first deploy): if `pending > 0` → `pipeline_update(d_id, status='needs_input')`, log (level `warn`) `환경변수 입력이 필요합니다 :{names}` (names only), then `return` (not a failure; keep the local image; keep `error_*` empty).
- Redeploy with an existing `service_arn` never pauses; if required vars lack values, log a `warn` with names and continue.
- Both create and update pass `environment=await Env_Service.services_env_runtime_dict(db, d_id) or None`.
- `services_deploy_session_end`: treat `needs_input` like a failed deploy for leftover image/repository cleanup (read the function first and extend the same condition).

- [ ] **Step 1: Write failing tests** (mirror stubs in `tests/test_pipeline.py`: stub clone/detect/generate/build/push/express with `monkeypatch`):
  - `test_pipeline_pauses_at_needs_input_before_deploying`: required var without value → deploy ends `needs_input`, `services_express_create` never called, local image not removed, no `error_msg`.
  - `test_pipeline_continue_deploys_with_environment`: set a config value, run from `'deploying'` → `services_express_create` receives `environment={"LOG_LEVEL":"info"}`.
  - `test_pipeline_redeploy_does_not_pause_and_resends_env`: deploy with `service_arn` and a missing var → `services_express_update` called with the stored env, status `running`.
  - `test_express_update_sends_environment_only_when_present`: fake session captures `update_express_gateway_service` kwargs: with env → `primaryContainer["environment"]` present; without → key absent.
  - `test_recover_leaves_needs_input_alone`: after `Deploy_Pipeline.pipeline_recover()` a `needs_input` deploy is unchanged while a `building` one becomes `failed`.
  - `test_pipeline_logs_never_contain_values`: run with a plain value `s3cr3t-value-xyz` set; all `deploy_logs.message` rows lack it.
  - `test_session_end_purges_needs_input_leftovers` (dry-run report lists it).
- [ ] **Step 2: Run** `pytest tests/test_pipeline_env.py -v` — Expected: FAIL.
- [ ] **Step 3: Implement** the pipeline changes, express update signature, status comment/label/CLAUDE.md edits, session-end condition.
- [ ] **Step 4: Run** `pytest tests/test_pipeline_env.py tests/test_pipeline.py tests/test_deploys_api.py -v` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(deploys): needs_input 상태와 환경변수 주입, 입력 대기`

---

### Task 6: Missing-env explanation rule and runtime-error names

**Files:**
- Modify: `features/explains/services.py` (`EXPLAIN_RULES` + helper), `features/envvars/services.py`, `features/deploys/pipeline.py` (`pipeline_fail`)
- Test: `tests/test_explains.py` (add cases), `tests/test_envvars_api.py` (add one)

**Interfaces:**
- Produces: `Env_Service.services_env_names_from_error(text:str) -> list[str]` — extracts names from `KeyError: 'X'`, `Missing required environment variable X`, `X is not defined` / `ReferenceError: X is not defined` only when `X` matches `^[A-Z][A-Z0-9_]{2,}$`; deduped, max 10.
- `EXPLAIN_RULES` gains one entry: pattern for those messages → summary `필요한 환경변수가 설정되지 않았습니다.`, cause explains the app crashed at start because a variable has no value, actions: enter the value in the environment screen, then continue/redeploy.
- `pipeline_fail`: after building the explanation, upsert each extracted name via `Env_Service.services_env_save_found` with `source='runtime_error'`, `required=True`, `kind='unknown'` (does not downgrade existing rows; no values).

- [ ] **Step 1: Write failing tests**: `test_env_names_from_error` parametrized (`KeyError: 'DATABASE_URL'` → `['DATABASE_URL']`; `ReferenceError: API_BASE is not defined` → `['API_BASE']`; lowercase `x is not defined` → `[]`; 12 distinct names → 10); `test_explain_rule_missing_env_matches` (rule hit, `source == 'rule'`, no LLM call); `test_pipeline_fail_records_runtime_error_names` (a failing deploy whose error text has `KeyError: 'FOO_URL'` gets a `deploy_env_vars` row with `source='runtime_error'`).
- [ ] **Step 2: Run** `pytest tests/test_explains.py tests/test_envvars_api.py -v` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the helper, rule, and `pipeline_fail` hook (wrap the hook in try/except so explanation saving can never be blocked, matching the existing "해설 실패가 배포 실패 처리를 막지 않는다" rule).
- [ ] **Step 4: Run** the same command plus `pytest tests/test_pipeline.py -v` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(explains): 환경변수 누락 규칙과 런타임 에러에서 이름 찾기`

---

### Task 7: `advice` feature — analyze before deploy

**Files:**
- Create: `features/advice/__init__.py`, `features/advice/scheme.py`, `features/advice/services.py`, `features/advice/router.py`
- Modify: `main.py` (include router), `features/repos/services.py` (only if no tree-removal helper exists: extract the clone's read-only-safe `rmtree` handler into `Repo_Service.services_repo_remove(path:Path) -> None` and reuse it in clone)
- Test: `tests/test_advice.py`

**Interfaces:**
- Consumes: `Repo_Service.services_repo_check_url/_check_branch/_commit_sha/_clone/_detect`, `Env_Service.services_env_analyze`, `Github_Service.services_github_token_by_g_id`.
- Produces (scheme): `Advice_Request(repo_url:str, branch:str|None=None, aws_account_id:int|None=None, github_installation_id:int|None=None)`; `Advice_Need(kind:str, supported:bool, message:str|None=None, count:int|None=None)` with kinds `database cache worker env_vars disk_write static_site`; `Advice_Cost(monthly_min:float|None=None, monthly_max:float|None=None, currency:str='USD', basis_date:str|None=None, note:str='트래픽에 따라 늘어납니다')`; `Advice_Signals`; `Deploy_Advice(tier, confidence, cpu:str|None=None, memory:str|None=None, cost:Advice_Cost, reasons:list[str], needs:list[Advice_Need], unknowns:list[str], language:str, support_level:str, app_dir:str, commit_sha:str|None)`.
- Produces (`Advice_Service`): `services_advice_signals(app_path:Path, detect:Repo_App, envs:list[Env_Found]) -> Advice_Signals`; `services_advice_tier(signals:Advice_Signals) -> tuple[str, list[str]]`; `services_advice_build(signals, detect, envs, commit_sha) -> Deploy_Advice`; `async services_advice_analyze(db, req:Advice_Request) -> Deploy_Advice`; in-memory cache dict keyed `(repo_url, commit_sha)`.
- Router: `APIRouter(prefix='/api/deploys', tags=['Advice'])`, `POST '/advice'` → `Deploy_Advice` (include it in `main.py` before the deploys router).

Rules (exact):
- Heavy libs → tier `large`: Python `torch tensorflow opencv-python opencv-python-headless pandas numpy scipy scikit-learn transformers`; Node `puppeteer playwright sharp @tensorflow/tfjs-node`. Else DB/cache/worker libs or `dep_count > 40` → `medium`. Else `small`. Static site (Node with a `build` script, no `start` script, and a Vite/CRA/Next-export marker) → `small` with a `static_site` need.
- DB libs: Python `sqlalchemy psycopg2 psycopg2-binary psycopg pymysql mysqlclient pymongo asyncpg`, Node `prisma @prisma/client mongoose pg mysql2 typeorm sequelize`. Cache libs: `redis ioredis aioredis`. Worker libs: `celery rq bull bullmq`.
- Needs: `database`/`cache`/`worker` always `supported=False` with message `마법사가 아직 만들어 주지 못합니다`; `env_vars` `supported=True` with `count`; `disk_write` `supported=False` when code opens files for writing under the app dir (`open(..., "w")`, `fs.writeFile`) with message `디스크에 쓴 파일은 서비스가 다시 시작되면 사라집니다`.
- Confidence: `low` if no dependency file parsed or `len(unknowns) >= 2`; `medium` if one unknown env kind or `support_level == 'experimental'`; else `high`. `unknowns` lists env names with `kind == 'unknown'` as `환경변수 {name}의 종류를 알 수 없습니다`.
- `cpu`, `memory`, and all `cost` numbers stay `None` (D10: Express Mode allowed combinations and pricing unverified). Never invent numbers.
- `services_advice_analyze`: validate URL/branch (`ValueError` → HTTP 400); resolve `commit_sha`; cache hit returns without cloning; otherwise clone into `settings.work_path / f"advice_{uuid4().hex}"` (token via `services_github_token_by_g_id` when `github_installation_id` given), analyze, always remove the temp dir in `finally`. Creates no `Deploy` row and never builds an AWS session.

- [ ] **Step 1: Write failing tests** (`tmp_path` fixture repos; monkeypatch clone/commit_sha for the endpoint):
  - `test_tier_large_for_heavy_libs` (`torch` in requirements); `test_tier_medium_for_db_lib_and_need_database_unsupported`; `test_tier_small_for_plain_flask_high_confidence`; `test_static_site_detected_for_vite_build_only`.
  - `test_confidence_low_without_dependency_file`; `test_confidence_medium_for_experimental_language`; `test_unknown_env_listed_in_unknowns`.
  - `test_cost_and_resources_are_none` (all of `cpu`, `memory`, `cost.monthly_min`, `cost.monthly_max`, `cost.basis_date` are `None`).
  - `test_disk_write_need`.
  - `test_advice_endpoint_creates_no_deploy_and_cleans_temp_dir`: POST returns 200; `GET /api/deploys` is empty; the temp dir no longer exists; AWS session builder never called (stub that fails).
  - `test_advice_endpoint_cache_hit_skips_clone` (second call same commit → clone stub called once).
  - `test_advice_endpoint_bad_url_400`; `test_advice_cleans_temp_dir_when_analysis_raises`.
- [ ] **Step 2: Run** `pytest tests/test_advice.py -v` — Expected: FAIL.
- [ ] **Step 3: Implement** schemes, service, router, the optional `services_repo_remove` extraction (verify `tests/test_repos.py` still passes).
- [ ] **Step 4: Run** `pytest tests/test_advice.py tests/test_repos.py -v` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(advice): 배포 전 분석과 사양 추천 API (숫자는 검증 전이라 비움)`

---

### Task 8: Docs, logs, full test run

**Files:**
- Modify: `docs/api-spec.md` (new endpoints, `env_pending`, status value `needs_input`, `POST /api/deploys/advice`), `docs/architecture.md` (pipeline table: scan at `analyzing`, `needs_input` pause; DB list gains `deploy_env_vars`), `docs/features.md` (rows for `envvars`, `advice`), `docs/milestones.md` (note), `HISTORY.md` (one row), `docs/worklog/2026-11-09.md` (append), `docs/app-web/README.md` (link to this plan, mark Plan A done)

- [ ] **Step 1:** Update the docs listed, copying exact field names and messages from Tasks 4, 5, 7 (secret-kind 501 documented as "pending D8 verification").
- [ ] **Step 2: Run** the full suite once: `pytest -q` — Expected: all tests pass (previous 134 plus the new ones). If anything fails, fix it before committing; report the output.
- [ ] **Step 3: Run** `uvicorn main:app --port=8081` is NOT needed; instead start `python -c "import main"` — Expected: no ImportError (router and model registration load).
- [ ] **Step 4: Commit** `docs: 환경변수·분석 API 명세와 작업 기록`

---

## Self-review

- **Spec coverage:** H-01..H-05 → Tasks 2–4; H-06 partly (plain values only; secret storage deliberately 501 until D8 is verified); H-07 → Task 5; H-08 → Task 6; H-09 → Tasks 2–5 (value never leaves); H-10 → Task 4. I-01..I-07, I-09 → Task 7; I-08 (user picks tier) and `size_tier/cpu/memory/advice` columns on `deploys` are NOT in this plan: they need Express Mode CPU/memory combinations that are unverified (D10) and are deferred to a follow-up once a real deploy has run.
- **Types:** `Env_Found`, `Env_Read`, `Env_Update`, `Env_Kind_Pick`, `Deploy_Advice` names are identical across tasks; `Env_Service` methods used in Tasks 5–7 are defined in Tasks 3–4.
- **Known gaps (intended):** pydantic-settings field names without `alias=` are not detected; real container-log based runtime names need D4 (log access) and arrive only via error text the pipeline already has.
