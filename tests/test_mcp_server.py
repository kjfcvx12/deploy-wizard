import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from mcp import Client
from mcp_types import ElicitResult

from features.deploys.crud import Deploy_Crud
from features.deploys.pipeline import Deploy_Pipeline
from features.mcp.client import Wizard_Client
from features.mcp.guard import Confirm_Store
from features.mcp.server import build_server
from features.mcp.services import Mcp_Service
from features.pricing.scheme import Price_Table
from features.pricing.services import Pricing_Service
from shared.database import AsyncSessionLocal, Base, async_engine

TOOL_NAMES={
    "analyze_repo", "list_deploys", "get_deploy", "wait_for_deploy", "get_logs", "get_issues", "check_health",
    "list_connections", "deploy", "redeploy", "stop_deploy", "start_deploy", "delete_deploy",
}
ACTION_NAMES={"deploy", "redeploy", "stop_deploy", "start_deploy", "delete_deploy"}
REPO="https://github.com/o/r"


# 테이블을 새로 만들고 파이프라인을 가짜로 바꾼 뒤 (REST 앱 직접 호출용 클라이언트, MCP 서버) 를 돌려준다
@pytest_asyncio.fixture
async def env(monkeypatch):
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    started=[]

    def fake_start(d_id, start_step=None):
        started.append(d_id)
        return True

    monkeypatch.setattr(Deploy_Pipeline, "pipeline_start", staticmethod(fake_start))

    async def fake_analyze(client, repo_url, branch=None, github_installation_id=None):
        return {"tier": "small", "cpu": "256", "memory": "512", "language": "python", "unknowns": []}

    monkeypatch.setattr(Mcp_Service, "services_mcp_analyze", staticmethod(fake_analyze))

    # 가격 표는 기본으로 비운다 (네트워크 없음) - 비용을 봐야 하는 시험이 따로 갈아끼운다
    async def no_table(region=None, fetch=None, now=None):
        return None

    monkeypatch.setattr(Pricing_Service, "services_pricing_table", staticmethod(no_table))

    transport=ASGITransport(app=app)
    wizard=Wizard_Client("http://test", transport=transport)
    srv=build_server(wizard, Confirm_Store(300), max_live=3)
    async with AsyncClient(transport=transport, base_url="http://test") as api:
        api.srv=srv
        api.transport=transport
        api.started=started
        yield api
    await wizard.aclose()


# 사용자가 항상 승인하는 elicitation 콜백
async def accept_callback(context, params):
    return ElicitResult(action="accept", content={"ok": True})


# 사용자가 항상 거절하는 elicitation 콜백
async def decline_callback(context, params):
    return ElicitResult(action="decline")


@pytest.mark.asyncio
async def test_server_lists_thirteen_tools_with_annotations(env):
    async with Client(env.srv, mode="legacy") as c:
        tools={t.name: t for t in (await c.list_tools()).tools}

    assert set(tools) == TOOL_NAMES
    for name, tool in tools.items():
        hints=tool.annotations
        assert hints is not None
        if name in ACTION_NAMES:
            assert hints.read_only_hint is not True
            assert "미리보기 후 사용자 승인 필요" in tool.description
            assert "요금이 발생한다" in tool.description or "되돌릴 수 없다" in tool.description
        else:
            assert hints.read_only_hint is True
    assert tools["delete_deploy"].annotations.destructive_hint is True
    assert "되돌릴 수 없다" in tools["delete_deploy"].description
    assert tools["stop_deploy"].annotations.destructive_hint is True
    for name in ("deploy", "redeploy", "start_deploy"):
        assert tools[name].annotations.destructive_hint is False
        assert "요금이 발생한다" in tools[name].description


def test_server_confirm_schema_has_korean_title():
    from features.mcp.server import Confirm_Schema

    field=Confirm_Schema.model_json_schema()["properties"]["ok"]
    assert field["title"] == "진행"
    assert "승인하면 실행" in field["description"]


@pytest.mark.asyncio
async def test_server_action_descriptions_explain_both_confirmation_paths(env):
    async with Client(env.srv, mode="legacy") as c:
        tools={t.name: t for t in (await c.list_tools()).tools}

    for name in ACTION_NAMES:
        text=tools[name].description
        assert "확인 창" in text and "confirm_token" in text
        assert "미리보기만 돌려준다" not in text

    from features.mcp.server import SERVER_INSTRUCTIONS

    assert "확인 창" in SERVER_INSTRUCTIONS and "confirm_token" in SERVER_INSTRUCTIONS


@pytest.mark.asyncio
async def test_server_max_live_and_ttl_are_not_tool_parameters(env):
    async with Client(env.srv, mode="legacy") as c:
        tools={t.name: t for t in (await c.list_tools()).tools}

    for tool in tools.values():
        props=set(tool.input_schema.get("properties", {}))
        assert "max_live" not in props
        assert "ttl_seconds" not in props


@pytest.mark.asyncio
async def test_server_read_flow_against_real_app(env):
    async with Client(env.srv, mode="legacy") as c:
        empty=await c.call_tool("list_deploys", {})
        assert empty.is_error is False
        assert empty.structured_content == {"items": []}

        created=await env.post("/api/deploys", json={"repo_url": REPO})
        assert created.status_code == 201
        d_id=created.json()["d_id"]

        got=await c.call_tool("get_deploy", {"d_id": d_id})
        assert got.is_error is False
        assert got.structured_content["d_id"] == d_id
        assert got.structured_content["status"] == "queued"
        assert "dockerfile" not in got.structured_content

        listed=await c.call_tool("list_deploys", {})
        assert [row["d_id"] for row in listed.structured_content["items"]] == [d_id]


@pytest.mark.asyncio
async def test_server_deploy_confirmation_flow(env):
    async with Client(env.srv, mode="legacy") as c:
        first=await c.call_tool("deploy", {"repo_url": REPO})
        assert first.structured_content["status"] == "confirmation_required"
        token=first.structured_content["confirm_token"]
        assert (await env.get("/api/deploys")).json() == []

        second=await c.call_tool("deploy", {"repo_url": REPO, "confirm_token": token})
        assert second.is_error is False
        assert second.structured_content["status"] == "done"
        assert len((await env.get("/api/deploys")).json()) == 1

        # 한 번 쓴 토큰은 다시 쓸 수 없다
        again=await c.call_tool("deploy", {"repo_url": REPO, "confirm_token": token})
        assert again.is_error is True
        assert len((await env.get("/api/deploys")).json()) == 1


@pytest.mark.asyncio
async def test_server_error_is_tool_error_in_korean(env):
    async with Client(env.srv, mode="legacy") as c:
        result=await c.call_tool("get_deploy", {"d_id": 999})

    assert result.is_error is True
    text=result.content[0].text
    assert "해당 id의 배포가 없습니다" in text
    assert "Traceback" not in text
    assert "File \"" not in text


@pytest.mark.asyncio
async def test_server_elicitation_accept_runs_without_token(env):
    async with Client(env.srv, mode="legacy", elicitation_callback=accept_callback) as c:
        result=await c.call_tool("deploy", {"repo_url": REPO})

    assert result.is_error is False
    assert result.structured_content["status"] == "done"
    assert len((await env.get("/api/deploys")).json()) == 1
    assert len(env.started) == 1


@pytest.mark.asyncio
async def test_server_elicitation_decline_creates_nothing(env):
    async with Client(env.srv, mode="legacy", elicitation_callback=decline_callback) as c:
        result=await c.call_tool("deploy", {"repo_url": REPO})

    assert result.is_error is False
    assert result.structured_content["status"] == "cancelled"
    assert "승인하지 않았습니다" in result.structured_content["message"]
    assert "다시 묻지 마세요" in result.structured_content["message"]
    assert (await env.get("/api/deploys")).json() == []
    assert env.started == []


@pytest.mark.asyncio
async def test_server_elicitation_decline_discards_token(env):
    wizard=Wizard_Client("http://test", transport=env.transport)
    store=Confirm_Store(300)
    srv=build_server(wizard, store, max_live=3)
    async with Client(srv, mode="legacy", elicitation_callback=decline_callback) as c:
        result=await c.call_tool("deploy", {"repo_url": REPO})
    await wizard.aclose()

    assert result.structured_content["status"] == "cancelled"
    assert store.tokens == {}


@pytest.mark.asyncio
async def test_server_elicitation_accept_without_ok_is_cancelled(env):
    async def unticked_callback(context, params):
        return ElicitResult(action="accept", content={"ok": False})

    async with Client(env.srv, mode="legacy", elicitation_callback=unticked_callback) as c:
        result=await c.call_tool("deploy", {"repo_url": REPO})

    assert result.is_error is False
    assert result.structured_content["status"] == "cancelled"
    assert (await env.get("/api/deploys")).json() == []
    assert env.started == []


@pytest.mark.asyncio
async def test_server_elicitation_accept_blocked_when_limit_reached_meanwhile(env):
    wizard=Wizard_Client("http://test", transport=env.transport)
    srv=build_server(wizard, Confirm_Store(300), max_live=1)

    async def race_callback(context, params):
        # 사용자가 승인하기 전에 다른 배포가 생겨 한도에 닿는다
        await env.post("/api/deploys", json={"repo_url": "https://github.com/o/other"})
        return ElicitResult(action="accept", content={"ok": True})

    async with Client(srv, mode="legacy", elicitation_callback=race_callback) as c:
        result=await c.call_tool("deploy", {"repo_url": REPO})
    await wizard.aclose()

    assert result.is_error is True
    assert "한도" in result.content[0].text
    rows=(await env.get("/api/deploys")).json()
    assert [row["repo_url"] for row in rows] == ["https://github.com/o/other"]
    assert len(env.started) == 1


@pytest.mark.asyncio
async def test_server_elicitation_message_shows_preview(env):
    seen=[]

    async def spy_callback(context, params):
        seen.append(params.message)
        return ElicitResult(action="decline")

    async with Client(env.srv, mode="legacy", elicitation_callback=spy_callback) as c:
        await c.call_tool("deploy", {"repo_url": REPO})

    assert len(seen) == 1
    assert REPO in seen[0]
    assert "요금" in seen[0]


@pytest.mark.asyncio
async def test_server_no_elicitation_falls_back_to_token_preview(env):
    async with Client(env.srv, mode="legacy") as c:
        result=await c.call_tool("deploy", {"repo_url": REPO})

    assert result.is_error is False
    assert result.structured_content["status"] == "confirmation_required"
    assert result.structured_content["confirm_token"]
    assert (await env.get("/api/deploys")).json() == []


@pytest.mark.asyncio
async def test_server_given_token_skips_elicitation(env):
    async with Client(env.srv, mode="legacy") as plain:
        token=(await plain.call_tool("deploy", {"repo_url": REPO})).structured_content["confirm_token"]

    async def refuse_callback(context, params):
        raise AssertionError("토큰이 있으면 elicitation 을 부르면 안 된다")

    async with Client(env.srv, mode="legacy", elicitation_callback=refuse_callback) as c:
        result=await c.call_tool("deploy", {"repo_url": REPO, "confirm_token": token})

    assert result.structured_content["status"] == "done"
    assert len((await env.get("/api/deploys")).json()) == 1


@pytest.mark.asyncio
async def test_server_delete_elicitation_accept_and_decline(env):
    d_id=(await env.post("/api/deploys", json={"repo_url": REPO})).json()["d_id"]
    # 진행 중인 배포는 지울 수 없으므로 실패 상태로 바꿔 둔다 (AWS 리소스 없음)
    async with AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "failed"})
        await db.commit()

    async with Client(env.srv, mode="legacy", elicitation_callback=decline_callback) as c:
        declined=await c.call_tool("delete_deploy", {"d_id": d_id})
        assert declined.structured_content["status"] == "cancelled"
        assert "승인하지 않았습니다" in declined.structured_content["message"]
        assert "다시 묻지 마세요" in declined.structured_content["message"]
    assert (await env.get(f"/api/deploys/{d_id}")).status_code == 200

    async with Client(env.srv, mode="legacy", elicitation_callback=accept_callback) as c:
        done=await c.call_tool("delete_deploy", {"d_id": d_id})
        assert done.is_error is False
        assert done.structured_content["status"] == "done"
    assert (await env.get(f"/api/deploys/{d_id}")).status_code == 404


@pytest.mark.asyncio
async def test_server_max_live_blocks_deploy_preview(env):
    wizard=Wizard_Client("http://test", transport=env.transport)
    srv=build_server(wizard, Confirm_Store(300), max_live=1)
    await env.post("/api/deploys", json={"repo_url": REPO})
    async with Client(srv, mode="legacy") as c:
        result=await c.call_tool("deploy", {"repo_url": REPO})
    await wizard.aclose()

    assert result.is_error is True
    assert "한도" in result.content[0].text


@pytest.mark.asyncio
async def test_server_writes_nothing_to_stdout(env, capsys):
    async with Client(env.srv, mode="legacy") as c:
        await c.list_tools()
        await c.call_tool("list_deploys", {})
        await c.call_tool("get_deploy", {"d_id": 999})
        await c.call_tool("deploy", {"repo_url": REPO})
    async with Client(env.srv, mode="legacy", elicitation_callback=accept_callback) as c:
        await c.call_tool("deploy", {"repo_url": REPO})

    assert capsys.readouterr().out == ""


def test_server_import_has_no_side_effects(capsys):
    import importlib

    import features.mcp.server as server_module

    importlib.reload(server_module)
    assert capsys.readouterr().out == ""
    assert callable(server_module.main)
    assert callable(server_module.build_server)


@pytest.mark.asyncio
async def test_server_deploy_tool_accepts_spec_options(env):
    async with Client(env.srv, mode="legacy") as c:
        tools={t.name: t for t in (await c.list_tools()).tools}

    deploy=tools["deploy"]
    props=set(deploy.input_schema["properties"])
    assert {"cpu", "memory", "planned_hours", "min_tasks", "max_tasks", "scale_metric", "scale_target"} <= props
    assert "max_live" not in props
    required=set(deploy.input_schema.get("required", []))
    assert required == {"repo_url"}
    assert "예정 사용 시간" in deploy.description
    assert "자동으로 끄지 않는다" in deploy.description
    for preset in ("256/512", "512/1024", "1024/2048", "2048/4096"):
        assert preset in deploy.description
    assert "max_tasks" in deploy.description


# 시험용 가짜 가격 표로 갈아끼운다
def patch_price_table(monkeypatch):
    async def fake_table(region=None, fetch=None, now=None):
        return Price_Table(region="ap-northeast-2", basis_date="2026-11-11",
                           fargate_vcpu_hour=0.04656, fargate_gb_hour=0.00511,
                           fargate_arm_vcpu_hour=0.03725, fargate_arm_gb_hour=0.00403,
                           alb_hour=0.0225, lcu_hour=0.008)

    monkeypatch.setattr(Pricing_Service, "services_pricing_table", staticmethod(fake_table))


@pytest.mark.asyncio
async def test_server_elicitation_accept_creates_one_deploy_with_options(env, monkeypatch):
    patch_price_table(monkeypatch)
    seen=[]

    async def spy_accept(context, params):
        seen.append(params.message)
        return ElicitResult(action="accept", content={"ok": True})

    args={"repo_url": REPO, "cpu": "512", "memory": "1024", "planned_hours": 3}
    async with Client(env.srv, mode="legacy", elicitation_callback=spy_accept) as c:
        result=await c.call_tool("deploy", args)

    assert result.is_error is False
    assert result.structured_content["status"] == "done"
    assert len(seen) == 1
    assert "ALB" in seen[0] and "시간당" in seen[0] and "한 달" in seen[0] and "3시간 동안" in seen[0]
    rows=(await env.get("/api/deploys")).json()
    assert len(rows) == 1
    assert (rows[0]["cpu"], rows[0]["memory"], rows[0]["planned_hours"]) == ("512", "1024", 3)
    assert len(env.started) == 1


@pytest.mark.asyncio
async def test_server_deploy_bad_spec_is_rejected_at_preview(env, monkeypatch):
    patch_price_table(monkeypatch)
    async with Client(env.srv, mode="legacy") as c:
        result=await c.call_tool("deploy", {"repo_url": REPO, "cpu": "300", "memory": "512"})

    assert result.is_error is True
    assert (await env.get("/api/deploys")).json() == []


@pytest.mark.asyncio
async def test_server_deploy_token_flow_with_options(env, monkeypatch):
    patch_price_table(monkeypatch)
    args={"repo_url": REPO, "cpu": "256", "memory": "512", "min_tasks": 1, "max_tasks": 2, "scale_metric": "AVERAGE_CPU", "scale_target": 60}
    async with Client(env.srv, mode="legacy") as c:
        first=await c.call_tool("deploy", args)
        assert first.structured_content["status"] == "confirmation_required"
        assert "자동 증설로 최대 2개까지" in first.structured_content["summary"]
        token=first.structured_content["confirm_token"]
        wrong=await c.call_tool("deploy", {**args, "max_tasks": 3, "confirm_token": token})
        assert wrong.is_error is True
        done=await c.call_tool("deploy", {**args, "confirm_token": token})
    assert done.structured_content["status"] == "done"
    rows=(await env.get("/api/deploys")).json()
    assert len(rows) == 1
    assert (rows[0]["min_tasks"], rows[0]["max_tasks"], rows[0]["scale_metric"], rows[0]["scale_target"]) == (1, 2, "AVERAGE_CPU", 60)
