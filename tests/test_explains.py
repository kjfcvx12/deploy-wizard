import uuid
import pytest

from features.explains.services import Explain_Service
from features.explains.scheme import Explain_Result
from features.explains import services as explains_module
from shared.llm import LLM_Unavailable

# 에러 시그니처 캐싱 (M5) - 규칙엔 안 걸리고 LLM으로 처음 해설한 에러만 캐시한다


def fail(*_a, **_kw):
    raise AssertionError("규칙에 걸렸으면 LLM을 부르면 안 된다")


@pytest.mark.asyncio
async def test_explain_rule_hit_never_calls_llm(monkeypatch):
    monkeypatch.setattr(explains_module.LLM_Client, "llm_parse", staticmethod(fail))

    result=await Explain_Service.services_explain_error("pushing", "Unable to locate credentials")

    assert result.source == "rule"
    assert result.cached is False


@pytest.mark.asyncio
@pytest.mark.parametrize("error_msg", [
    "Traceback (most recent call last):\nKeyError: 'DATABASE_URL'",
    "Error: Missing required environment variable STRIPE_KEY",
    "ReferenceError: API_BASE is not defined",
])
async def test_explain_rule_missing_env_matches(monkeypatch, error_msg):
    monkeypatch.setattr(explains_module.LLM_Client, "llm_parse", staticmethod(fail))

    result=await Explain_Service.services_explain_error("deploying", error_msg)

    assert result.source == "rule"
    assert result.summary == "필요한 환경변수가 설정되지 않았습니다."


# 앱이 변수 때문에 죽어 헬스체크가 같이 실패해도 구체적인 환경변수 규칙이 이긴다
@pytest.mark.asyncio
async def test_explain_rule_missing_env_wins_over_health_check(monkeypatch):
    monkeypatch.setattr(explains_module.LLM_Client, "llm_parse", staticmethod(fail))

    result=await Explain_Service.services_explain_error("deploying", "Target.FailedHealthChecks", "KeyError: 'DATABASE_URL'")

    assert result.summary == "필요한 환경변수가 설정되지 않았습니다."


# 소문자 이름이나 일반 문구는 환경변수 규칙에 걸리지 않는다
@pytest.mark.asyncio
async def test_explain_rule_missing_env_ignores_lowercase(monkeypatch):
    monkeypatch.setattr(explains_module.LLM_Client, "llm_parse", staticmethod(fail))

    result=await Explain_Service.services_explain_error("deploying", "ReferenceError: x is not defined, Target.FailedHealthChecks")

    assert result.summary == "헬스체크에 실패했습니다."


@pytest.mark.asyncio
async def test_explain_llm_result_is_cached(monkeypatch):
    calls=[]
    error_msg=f"unmapped weird build error {uuid.uuid4()}"

    async def fake_parse(system, prompt, scheme):
        calls.append(prompt)
        return Explain_Result(summary="처음 보는 에러입니다.", cause="원인", actions=["조치"])

    monkeypatch.setattr(explains_module.LLM_Client, "llm_parse", staticmethod(fake_parse))

    first=await Explain_Service.services_explain_error("building", error_msg)
    second=await Explain_Service.services_explain_error("building", error_msg)

    assert len(calls) == 1
    assert first.source == "llm" and first.cached is False
    assert second.source == "llm" and second.cached is True
    assert second.summary == "처음 보는 에러입니다."


@pytest.mark.asyncio
async def test_explain_llm_unavailable_is_not_cached(monkeypatch):
    calls=[]
    error_msg=f"unmapped and llm down {uuid.uuid4()}"

    async def fake_parse(system, prompt, scheme):
        calls.append(prompt)
        raise LLM_Unavailable("LLM_ENABLED=false")

    monkeypatch.setattr(explains_module.LLM_Client, "llm_parse", staticmethod(fake_parse))

    first=await Explain_Service.services_explain_error("building", error_msg)
    second=await Explain_Service.services_explain_error("building", error_msg)

    assert len(calls) == 2
    assert first.source == "none" and second.source == "none"
