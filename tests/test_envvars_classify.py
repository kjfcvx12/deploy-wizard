import pytest
from pathlib import Path

from features.envvars.scheme import Env_Found, Env_Kind_Pick
from features.envvars.services import Env_Service
from shared.llm import LLM_Client, LLM_Unavailable


# 앱 폴더에 파일을 만든다
def write(root:Path, rel:str, text:str):
    path=root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# 코드에서 찾은 것처럼 Env_Found 를 만든다
def code_found(name:str, hint:str | None, kind:str='unknown') -> Env_Found:
    return Env_Found(name=name, required=True, has_default=False, kind=kind, source='code', source_hint=hint)


# 이름 -> 종류
def kinds(found) -> dict:
    return {f.name: f.kind for f in found}


def test_classify_rule_by_usage(tmp_path):
    write(tmp_path, "app.py", "\n".join([
        'engine = create_engine(os.getenv("MY_THING_URL"))',
        'r = redis.from_url(os.environ["X1"])',
        'stripe.api_key = os.getenv("Y1")',
        'DB = os.getenv("Z1")',
        'x = 1',
        'session = create_async_engine(DB)',
    ]))
    found=[code_found("MY_THING_URL", "app.py:1"), code_found("X1", "app.py:2"),
           code_found("Y1", "app.py:3"), code_found("Z1", "app.py:4")]

    result=Env_Service.services_env_classify_rule(tmp_path, found)

    assert kinds(result) == {"MY_THING_URL": "database", "X1": "cache", "Y1": "external_api", "Z1": "database"}


def test_classify_rule_name_hint_is_last_resort(tmp_path):
    write(tmp_path, "app.py", "\n".join([
        'stripe.api_key = os.getenv("DATABASE_STRIPE")',
        'level = os.getenv("LOG_LEVEL")',
    ]))
    found=[code_found("DATABASE_STRIPE", "app.py:1"), code_found("LOG_LEVEL", "app.py:2"),
           Env_Found(name="MONGO_URL", required=True, has_default=False, source='example', source_hint=".env.example")]

    result=Env_Service.services_env_classify_rule(tmp_path, found)

    assert kinds(result) == {"DATABASE_STRIPE": "external_api", "LOG_LEVEL": "config", "MONGO_URL": "database"}


def test_classify_unknown_stays_unknown(tmp_path):
    write(tmp_path, "app.py", 'thing = os.getenv("WHATEVER")\n')
    found=[code_found("WHATEVER", "app.py:1"), code_found("NO_HINT_FILE", None)]

    result=Env_Service.services_env_classify_rule(tmp_path, found)

    assert kinds(result) == {"WHATEVER": "unknown", "NO_HINT_FILE": "unknown"}


def test_classify_rule_keeps_existing_kind(tmp_path):
    write(tmp_path, "app.py", 'engine = create_engine(os.getenv("K1"))\n')

    result=Env_Service.services_env_classify_rule(tmp_path, [code_found("K1", "app.py:1", kind='config')])

    assert result[0].kind == 'config'


def test_context_is_at_most_seven_lines(tmp_path):
    write(tmp_path, "app.py", "\n".join(f"line{i}" for i in range(1, 21)))

    middle=Env_Service.services_env_context(tmp_path, code_found("A", "app.py:10"))
    head=Env_Service.services_env_context(tmp_path, code_found("A", "app.py:1"))

    assert middle.splitlines() == [f"line{i}" for i in range(7, 14)]
    assert head.splitlines() == [f"line{i}" for i in range(1, 5)]


def test_context_empty_without_line_hint(tmp_path):
    write(tmp_path, ".env.example", "SECRET_VALUE_X=abc123\n")
    example=Env_Found(name="A", required=True, has_default=False, source='example', source_hint=".env.example")

    assert Env_Service.services_env_context(tmp_path, code_found("A", None)) == ''
    assert Env_Service.services_env_context(tmp_path, example) == ''
    assert Env_Service.services_env_context(tmp_path, code_found("A", "missing.py:3")) == ''


@pytest.mark.asyncio
async def test_llm_called_only_for_unknown_and_capped(tmp_path, monkeypatch):
    calls=[]

    async def spy(system, prompt, scheme):
        calls.append(prompt)
        return Env_Kind_Pick(kind='config')

    monkeypatch.setattr(LLM_Client, "llm_parse", spy)
    found=[code_found(f"UNK_{i}", None) for i in range(25)]
    found.append(code_found("ALREADY_DB", None, kind='database'))

    result=await Env_Service.services_env_classify_llm(tmp_path, found)

    assert len(calls) == 20
    assert all("ALREADY_DB" not in p for p in calls)
    got=kinds(result)
    assert sum(1 for i in range(25) if got[f"UNK_{i}"] == 'config') == 20
    assert sum(1 for i in range(25) if got[f"UNK_{i}"] == 'unknown') == 5
    assert got["ALREADY_DB"] == 'database'


@pytest.mark.asyncio
async def test_llm_prompt_has_only_name_and_context_lines(tmp_path, monkeypatch):
    write(tmp_path, ".env.example", "MY_VAR=hunter2value\nOTHER=abc\n")
    write(tmp_path, "src/other.py", 'leaked_other_file_text = 1\n')
    write(tmp_path, "src/app.py", "\n".join(f"code{i}" for i in range(1, 30)) + "\n")
    prompts=[]

    async def spy(system, prompt, scheme):
        prompts.append(prompt)
        return Env_Kind_Pick(kind='unknown')

    monkeypatch.setattr(LLM_Client, "llm_parse", spy)
    found=[code_found("MY_VAR", "src/app.py:15"),
           Env_Found(name="OTHER", required=True, has_default=False, source='example', source_hint=".env.example")]

    await Env_Service.services_env_classify_llm(tmp_path, found)

    assert len(prompts) == 2
    first=prompts[0]
    assert "MY_VAR" in first
    for i in range(12, 19):
        assert f"code{i}" in first
    assert "code11" not in first and "code19" not in first
    assert len([l for l in first.splitlines() if l.startswith("code")]) <= 7
    assert "src/app.py" not in first
    for p in prompts:
        assert "hunter2value" not in p
        assert "leaked_other_file_text" not in p
        assert ".env.example" not in p


@pytest.mark.asyncio
async def test_llm_unavailable_leaves_unknown(tmp_path, monkeypatch):
    calls=[]

    async def spy(system, prompt, scheme):
        calls.append(prompt)
        raise LLM_Unavailable("off")

    monkeypatch.setattr(LLM_Client, "llm_parse", spy)
    found=[code_found("A1", None), code_found("B1", None), code_found("C1", None, kind='cache')]

    result=await Env_Service.services_env_classify_llm(tmp_path, found)

    assert len(calls) == 1
    assert kinds(result) == {"A1": "unknown", "B1": "unknown", "C1": "cache"}


@pytest.mark.asyncio
async def test_analyze_works_with_llm_off(tmp_path):
    write(tmp_path, "app.py", "\n".join([
        'import os',
        'engine = create_engine(os.getenv("APP_DB"))',
        'mystery = os.getenv("MYSTERY")',
    ]))

    result=await Env_Service.services_env_analyze(tmp_path)

    assert kinds(result) == {"APP_DB": "database", "MYSTERY": "unknown"}



# 스캔·규칙 분류는 동기 파일 읽기라 이벤트 루프 스레드가 아닌 곳에서 돌아야 한다
@pytest.mark.asyncio
async def test_analyze_runs_scan_and_rule_off_the_event_loop(tmp_path, monkeypatch):
    import threading
    from features.envvars.scan import Env_Scan_Service

    loop_thread=threading.current_thread()
    seen={}
    real_scan=Env_Scan_Service.services_env_scan
    real_rule=Env_Service.services_env_classify_rule

    def spy_scan(app_path):
        seen["scan"]=threading.current_thread()
        return real_scan(app_path)

    def spy_rule(app_path, found):
        seen["rule"]=threading.current_thread()
        return real_rule(app_path, found)

    monkeypatch.setattr(Env_Scan_Service, "services_env_scan", staticmethod(spy_scan))
    monkeypatch.setattr(Env_Service, "services_env_classify_rule", staticmethod(spy_rule))
    write(tmp_path, "app.py", 'engine = create_engine(os.getenv("APP_DB"))\n')

    result=await Env_Service.services_env_analyze(tmp_path)

    assert seen["scan"] is not loop_thread and seen["rule"] is not loop_thread
    assert kinds(result) == {"APP_DB": "database"}


# 코드에 박힌 기본값 글자(키·URL)는 AI 에 보내는 주변 코드에 남지 않는다
@pytest.mark.asyncio
async def test_llm_prompt_has_no_string_literals_from_code(tmp_path, monkeypatch):
    write(tmp_path, "app.py", "\n".join([
        'import os',
        'a = os.getenv("WEBHOOK_URL", "https://hooks.slack.com/services/T0/B0/xyz")',
        "b = os.getenv('STRIPE_KEY', 'sk_live_abc123SECRET')",
        'c = os.getenv("TOKEN_X", "ghp_abcdefghijklmnopqrstuvwxyz0123456789")',
        'd = f(r"esc \\" quote sk_test_zzz")',
        'e = """sk_open_unclosed_secret',
    ]))
    prompts=[]

    async def spy(system, prompt, scheme):
        prompts.append(prompt)
        return Env_Kind_Pick(kind='unknown')

    monkeypatch.setattr(LLM_Client, "llm_parse", spy)
    found=[code_found("WEBHOOK_URL", "app.py:2")]

    await Env_Service.services_env_classify_llm(tmp_path, found)

    prompt=prompts[0]
    assert "WEBHOOK_URL" in prompt
    for leaked in ("hooks.slack.com", "T0/B0/xyz", "sk_live_abc123SECRET", "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
                   "sk_test_zzz", "sk_open_unclosed_secret"):
        assert leaked not in prompt
    assert "os.getenv(" in prompt


# 따옴표 밖에 있는 토큰 꼴 글자도 mask_text 로 가려진다
def test_context_line_still_masks_tokens_outside_quotes(tmp_path):
    token="ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    write(tmp_path, "app.py", f"# token {token} here\nx = os.getenv(NAME)\n")

    context=Env_Service.services_env_context(tmp_path, code_found("NAME", "app.py:2"))

    assert token not in context
    assert "x = os.getenv(NAME)" in context


# 한 줄이 아주 길어도 일곱 줄·200자 제한은 그대로다 (글자를 가린 뒤에도)
def test_context_literals_masked_but_limits_hold(tmp_path):
    long_line='x = os.getenv("A", "' + "y" * 500 + '")'
    write(tmp_path, "app.py", "\n".join([long_line] * 12))
    write(tmp_path, "wide.py", "\n".join(["z" * 500] * 12))

    context=Env_Service.services_env_context(tmp_path, code_found("A", "app.py:6"))
    wide=Env_Service.services_env_context(tmp_path, code_found("A", "wide.py:6"))

    lines=context.splitlines()
    assert len(lines) == 7
    assert all(len(l) <= 200 for l in lines)
    assert "yyyy" not in context
    assert len(wide.splitlines()) == 7 and all(len(l) == 200 for l in wide.splitlines())


# 줄 번호는 스캔이 센 방식(\n 기준)과 같아야 한다 - 폼 피드·U+2028 이 줄을 밀지 않는다
def test_context_line_numbers_follow_newline_only(tmp_path):
    from features.envvars.scan import Env_Scan_Service

    text="# a\x0c b\n# c  d\n\x85 e\nimport os\nx = os.environ['TARGET_VAR']\nafter1\nafter2\n"
    path=tmp_path / "app.py"
    path.write_bytes(text.encode("utf-8"))
    found=Env_Scan_Service.services_env_scan_text("app.py", text)
    assert found[0].source_hint == "app.py:5"

    context=Env_Service.services_env_context(tmp_path, found[0])

    assert "os.environ" in context.split("\n")[3]
    assert Env_Service.services_env_read_lines(tmp_path, "app.py")[4] == "x = os.environ['TARGET_VAR']"


# 닫히지 않은 따옴표 뒤에 역슬래시가 길게 이어져도 한 줄 처리가 지수 시간으로 늘지 않는다
@pytest.mark.parametrize("line", [
    'x = "' + "\\" * 2000,
    "x = '" + "\\" * 60,
    "# don't " + "\\" * 40,
    'x = "' + "\\" * 59 + '"' + "\\" * 59,
])
def test_context_line_hostile_backslashes_finish_fast(line):
    import time

    started=time.perf_counter()
    result=Env_Service.services_env_context_line(line)
    elapsed=time.perf_counter() - started

    assert elapsed < 1.0
    assert "\\\\\\\\" not in result


# 같은 줄이 파일 안에 있어도 주변 코드 만들기가 1초 안에 끝난다
def test_context_with_hostile_lines_finishes_fast(tmp_path):
    import time

    write(tmp_path, "app.py", "\n".join(['x = "' + "\\" * 2000, "y = '" + "\\" * 60, "# don't " + "\\" * 40, "z = os.getenv(NAME)"]))

    started=time.perf_counter()
    context=Env_Service.services_env_context(tmp_path, code_found("NAME", "app.py:4"))
    elapsed=time.perf_counter() - started

    assert elapsed < 1.0
    assert len(context.splitlines()) == 4


# 이스케이프된 따옴표가 든 보통 글자는 끝까지 한 덩어리로 가려진다
@pytest.mark.asyncio
async def test_llm_prompt_masks_escaped_quote_literal_fully(tmp_path, monkeypatch):
    write(tmp_path, "app.py", 'import os\na = os.getenv("A", "say \\"hi\\" now")\nb = 1\n')
    prompts=[]

    async def spy(system, prompt, scheme):
        prompts.append(prompt)
        return Env_Kind_Pick(kind='unknown')

    monkeypatch.setattr(LLM_Client, "llm_parse", spy)

    await Env_Service.services_env_classify_llm(tmp_path, [code_found("A", "app.py:2")])

    assert 'a = os.getenv("…", "…")' in prompts[0]
    assert "hi" not in prompts[0].split("주변 코드:")[1]
    assert "now" not in prompts[0]
