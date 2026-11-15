import pytest
from pydantic import BaseModel

# 설치된 mcp SDK(2.3.0)의 이름·동작을 고정한다. SDK를 올릴 때 여기서 먼저 깨진다 (설계서 9절)

class Ask_Model(BaseModel):
    ok:bool


class Out_Model(BaseModel):
    a:int
    b:str


# 항목 1 - 서버 클래스, 도구 등록, stdio 실행
def test_mcp_sdk_exposes_server_class():
    from mcp.server.mcpserver import MCPServer, Context
    assert hasattr(MCPServer, "tool")
    assert hasattr(MCPServer, "add_tool")
    assert hasattr(MCPServer, "run")
    assert hasattr(MCPServer, "run_stdio_async")
    assert hasattr(MCPServer, "call_tool")
    assert hasattr(MCPServer, "list_tools")
    assert Context is not None


# v1 의 FastMCP 는 2.x 에서 사라졌다 (import 하면 ModuleNotFoundError)
def test_mcp_sdk_fastmcp_is_removed():
    with pytest.raises(ModuleNotFoundError):
        import mcp.server.fastmcp  # noqa: F401


# 항목 2 - 도구 주석 이름
def test_mcp_sdk_exposes_tool_annotations():
    from mcp_types import ToolAnnotations
    fields=set(ToolAnnotations.model_fields)
    assert {"title", "read_only_hint", "destructive_hint", "idempotent_hint", "open_world_hint"} <= fields
    wire=ToolAnnotations(read_only_hint=True).model_dump(by_alias=True, exclude_none=True)
    assert wire == {"readOnlyHint": True}


# 항목 3 - 구조화 출력: dict[str, T]·모델은 그대로, 문자열 등은 {"result": ...} 로 감싼다
def test_mcp_sdk_exposes_structured_output():
    from mcp.server.mcpserver import MCPServer
    srv=MCPServer("t")

    @srv.tool()
    def t_model() -> Out_Model:
        return Out_Model(a=1, b="z")

    @srv.tool()
    def t_dict() -> dict[str, int]:
        return {"x": 1}

    @srv.tool()
    def t_str() -> str:
        return "hi"

    @srv.tool()
    def t_bare_dict() -> dict:
        return {"x": 1}

    import asyncio
    async def run():
        tools={t.name: t for t in await srv.list_tools()}
        assert tools["t_model"].output_schema["properties"].keys() == {"a", "b"}
        assert tools["t_dict"].output_schema["type"] == "object"
        assert tools["t_str"].output_schema["properties"].keys() == {"result"}
        # 값 타입 없는 dict 는 구조화 출력이 없다 (텍스트만)
        assert tools["t_bare_dict"].output_schema is None
        r=await srv.call_tool("t_model", {})
        assert r.structured_content == {"a": 1, "b": "z"}
        r=await srv.call_tool("t_str", {})
        assert r.structured_content == {"result": "hi"}
        r=await srv.call_tool("t_bare_dict", {})
        assert r.structured_content is None
    asyncio.run(run())


# 항목 4 - elicitation: 호출 이름과 예외 클래스
def test_mcp_sdk_exposes_elicitation():
    from mcp.server.mcpserver import Context, AcceptedElicitation, DeclinedElicitation, CancelledElicitation
    from mcp.shared.exceptions import MCPError, NoBackChannelError
    assert hasattr(Context, "elicit")
    assert hasattr(Context, "elicit_url")
    assert issubclass(NoBackChannelError, MCPError)
    assert AcceptedElicitation.model_fields["action"].default == "accept"
    assert DeclinedElicitation.model_fields["action"].default == "decline"
    assert CancelledElicitation.model_fields["action"].default == "cancel"


# 항목 5 - 인메모리 클라이언트-서버 연결 (mode="legacy" = stdio 호스트와 같은 initialize 방식)
def test_mcp_sdk_exposes_in_memory_client():
    from mcp import Client
    from mcp.client._memory import InMemoryTransport
    assert hasattr(Client, "call_tool")
    assert hasattr(Client, "list_tools")
    assert "elicitation_callback" in Client.__dataclass_fields__
    assert "mode" in Client.__dataclass_fields__
    assert InMemoryTransport is not None


# 항목 4+5 - 클라이언트가 elicitation 을 지원하면 응답을 받는다 / 안 하면 MCPError("Elicitation not supported")
@pytest.mark.asyncio
async def test_mcp_sdk_elicitation_supported_and_unsupported():
    from mcp import Client
    from mcp.server.mcpserver import MCPServer, Context
    from mcp.shared.exceptions import MCPError
    from mcp_types import ElicitResult

    srv=MCPServer("t")

    @srv.tool()
    async def t_ask(ctx: Context) -> str:
        try:
            r=await ctx.elicit("진행할까요?", Ask_Model)
        except MCPError as e:
            return f"unsupported:{e}"
        return f"{r.action}:{getattr(r, 'data', None)}"

    async def on_elicit(context, params):
        return ElicitResult(action="accept", content={"ok": True})

    async with Client(srv, mode="legacy", elicitation_callback=on_elicit) as c:
        r=await c.call_tool("t_ask", {})
        assert r.structured_content == {"result": "accept:ok=True"}

    async with Client(srv, mode="legacy") as c:
        r=await c.call_tool("t_ask", {})
        assert r.structured_content == {"result": "unsupported:Elicitation not supported"}


# 도구에서 처리 안 된 예외는 클라이언트에 is_error 와 일반 문구만 간다 (내용 노출 없음)
@pytest.mark.asyncio
async def test_mcp_sdk_hides_unexpected_exception_text():
    from mcp import Client
    from mcp.server.mcpserver import MCPServer
    srv=MCPServer("t")

    @srv.tool()
    def t_boom() -> str:
        raise RuntimeError("secret detail")

    async with Client(srv, mode="legacy") as c:
        r=await c.call_tool("t_boom", {})
        assert r.is_error is True
        assert "secret detail" not in r.content[0].text
