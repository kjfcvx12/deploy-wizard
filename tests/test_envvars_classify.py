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
