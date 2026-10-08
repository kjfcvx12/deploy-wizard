# CLAUDE.md — AWS Deploy Wizard

Solo project: take a GitHub URL + temporary AWS permission, deploy to ECS Express Mode, return an HTTPS URL. On failure: stop, explain in Korean, ask.
Spec: `AWS_자동배포마법사_개인프로젝트_기획서.pdf`. Code comments `(기획서 NN장)` cite its chapters.

## Language
- Chat with user, code comments, user-facing strings: **Korean**. Identifiers: English.
- Saved records (`docs/worklog/`, memory): terse English.

## Docs — read the relevant one before working
| Doc | When |
|---|---|
| `docs/conventions.md` | **always before writing code** |
| `docs/architecture.md` | touching folders / dependency direction / pipeline |
| `docs/features.md` | deciding where new code goes |
| `docs/api-spec.md` | changing a router (update in same change) |
| `docs/ui-spec.md` | changing UI |
| `docs/aws-notes.md` | writing/editing any boto3 call |
| `docs/milestones.md` | what to do next |

## Layout — by feature, not back/front
```
features/<feature>/
  models.py    SQLAlchemy tables        (DB features only)
  scheme.py    Pydantic schemas
  crud.py      DB access — flush only
  services.py  logic — commit/rollback, HTTPException
  router.py    endpoints                (API features only)
  ui/          React screens + api.js   (UI features only)
shared/        settings, database, aws_session, llm, masking, proc, ui/
```
Deps: `features/* -> shared/*` ok · `shared/* -> features/*` never · feature-to-feature via **services only**. Assembly happens only in `features/deploys/pipeline.py`.

## Naming
- Classes Pascal_Snake: `Deploy_Service`, `Deploy_Crud`, `Deploy_Create`, `Deploy_Read`, `Deploy_In_DB`
- Functions `<layer>_<domain>_<action>`: `router_deploy_create`, `services_deploy_create`, `crud_deploy_get_by_d_id`
- PK/FK short: `d_id` (deploys), `d_l_id` (deploy_logs)
- Service/Crud = class of `@staticmethod`; first arg `db: AsyncSession` if DB, `session` if AWS
- One-line Korean comment above each function; no docstrings
- Keep existing `=` spacing; never bulk-format to PEP8

## Status values — `deploys.status`
```
queued -> cloning -> analyzing -> generating -> building -> pushing -> deploying -> running
                         (any step) -> failed
running -> stopped -> queued -> deploying -> running      (stop keeps the image; start skips clone/build/push)
running|failed|stopped -> deleting -> deleted
```
Change in three places together: `features/deploys/models.py` comment, `PROGRESS_STATUSES` in `features/deploys/pipeline.py`, `features/deploys/ui/constants.js`.
- `deploy_logs.level`: `info|cmd|warn|error`
- `support_level`: `official` (Node.js, Python) | `experimental` (rest)
- `dockerfile_source`: `template_llm|template_rule|llm_raw|llm_fix|repo`

## Hard rules
1. **Inject the AWS session.** `def f(session, ...): session.client('ecs')`. No global `boto3.client`. M6 swaps in `get_assumed_session`.
2. **Never invent Express Mode API.** New (2025-11) feature; models hallucinate params. Use only signatures in `docs/aws-notes.md`; verify new ones against the botocore service model or AWS docs.
3. **Only automatic action is rollback.** Create/change/delete always needs user confirmation. Never auto-delete resources on failure. Ask with 2–3 buttons, not open questions. One standing confirmation exists: the end-of-session cleanup below.
4. **LLM fills blanks only.** Output fixed by Pydantic schema via `LLM_Client.llm_parse`; validate before it enters a Dockerfile. Official languages must finish with LLM off.
5. **Never send the whole repo to the LLM.** Tree + manifest + 1–2 entry files. Exclude filter (`.env`, key files, `node_modules`, `.git`) lives in `features/repos/services.py`.
6. **No tokens in logs.** Run `mask_text` before DB/LLM/log. Passwords via stdin, never argv.
7. **External commands via `proc_run` with list args.** No `shell=True`. Repo URL/branch are user input -> `services_repo_check_url` / `check_branch`.
8. **Tag our AWS resources `managed-by: deploy-wizard`.** Cleanup touches only tagged resources.
9. **Always build `--platform linux/amd64`.**
10. API change -> `docs/api-spec.md`; status change -> this file, in the same change.

## Run
```bash
uvicorn main:app --port=8081 --reload   # API
npm run dev                             # UI :5173, /api proxied to :8081
pytest                                  # no AWS/LLM/Docker needed
python scripts/check_aws.py             # is the aws login session alive? (12h max)
python scripts/session_end.py --yes     # end of session — stop everything billable, keep records (see below)
python scripts/cleanup.py --yes         # hard cleanup — delete every tagged resource, nothing to resume
```
The API server is usually started without `--reload` in agent sessions: restart it after backend edits.
Other work runs on this PC at the same time (another project's test loops). Stop only what you started: by the port's listener PID or a PID you launched — never by process name or a command-line pattern like "pytest". A slow test run usually means the CPU is shared, not that it hung.

## End of session — when the user says "작업 종료"
Standing instruction from the owner (2026-10-07): stop or delete everything that costs money, and leave things so the next session continues as-is. This is pre-confirmed; do it without asking again, then report.
1. `python scripts/session_end.py` (look only) -> `python scripts/session_end.py --yes`. Running deploys: ECS service deleted, record kept as `stopped`. Their ECR images are deleted too (`--keep-images` only if the owner asks for a faster restart). Uploaded template files in S3 removed. If it says the AWS login expired, ask the owner to `aws login`, then rerun — do not skip.
2. Stop the local servers on :8081 and :5173.
3. Tell the owner what was stopped, what is left, and anything that could not be checked. Save to HISTORY / worklog / Notion.

Kept on purpose (free, needed to resume): CloudFormation stack + IAM roles, GitHub App installation, `data/wizard.db`, `.env`, `data/github-app-private-key.pem`.
Resume next session: `aws login` -> `python scripts/check_aws.py` -> start servers -> `[다시 켜기]` on each stopped deploy (rebuilds from the repo if the image was deleted).
The standing confirmation covers only what `session_end.py` touches. Deleting a block, a stack, a deploy record, or the GitHub App still needs an explicit yes.

## Work log
After each unit of work: add one row to `HISTORY.md` (progress / experiments / language trials / decisions), write details in `docs/worklog/YYYY-MM-DD.md` (terse English), and post the same to the Notion work log. Record blockers with the raw error text.

## Token saving
- Explore narrowly: name the file/dir/range; read only the needed part of large files; don't re-read known facts.
- Batch edits, one combined verify command, short reports.
- New session after a finished unit of work or topic change.
- Disable MCP connectors not needed for the task.
