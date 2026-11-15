import httpx
import pytest

from features.mcp.client import Wizard_Client, Wizard_Error


# 가짜 서버 핸들러를 끼운 클라이언트를 만든다
def make_client(handler, token:str|None=None):
    return Wizard_Client("http://wizard.test", token=token, transport=httpx.MockTransport(handler))


# 요청 하나를 보내고 Wizard_Error 메시지를 돌려준다
async def error_message(handler, method:str="GET", path:str="/api/deploys") -> str:
    client=make_client(handler)
    try:
        with pytest.raises(Wizard_Error) as exc_info:
            await client.client_request(method, path)
    finally:
        await client.aclose()
    assert exc_info.value.message == str(exc_info.value)
    return exc_info.value.message


@pytest.mark.asyncio
async def test_client_request_returns_json():
    def handler(request:httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/api/deploys"
        return httpx.Response(200, json=[{"d_id":1}, {"d_id":2}])

    client=make_client(handler)
    try:
        result=await client.client_request("GET", "/api/deploys")
    finally:
        await client.aclose()
    assert result == [{"d_id":1}, {"d_id":2}]


@pytest.mark.asyncio
async def test_client_sends_bearer_only_with_token():
    seen:list[httpx.Headers]=[]

    def handler(request:httpx.Request) -> httpx.Response:
        seen.append(request.headers)
        return httpx.Response(200, json=[])

    with_token=make_client(handler, token="t1")
    without_token=make_client(handler)
    try:
        await with_token.client_request("GET", "/api/deploys")
        await without_token.client_request("GET", "/api/deploys")
    finally:
        await with_token.aclose()
        await without_token.aclose()
    assert seen[0]["authorization"] == "Bearer t1"
    assert "authorization" not in seen[1]


@pytest.mark.asyncio
async def test_client_error_messages_korean():
    def refused(request:httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    message=await error_message(refused)
    assert "연결할 수 없습니다" in message
    assert "uvicorn main:app --port=8081" in message

    def not_found(request:httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"detail":"해당 id의 배포가 없습니다"})

    assert "해당 id의 배포가 없습니다" in await error_message(not_found)

    def conflict(request:httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"detail":"이미 진행 중인 배포입니다"})

    assert "이미 진행 중인 배포입니다" in await error_message(conflict)

    def unprocessable(request:httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"detail":[{"loc":["body", "repo_url"], "msg":"field required", "type":"missing"}]})

    assert "입력 형식이 맞지 않습니다" in await error_message(unprocessable)

    def slow(request:httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    assert "응답이 늦습니다" in await error_message(slow)


@pytest.mark.asyncio
async def test_client_logs_tail_pages_past_500():
    total=1200
    afters:list[int]=[]

    def make_handler(total_rows:int):
        def handler(request:httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/deploys/1/logs"
            after=int(request.url.params.get("after", "0"))
            afters.append(after)
            rows=[{"d_l_id":i, "message":f"line {i}"} for i in range(after + 1, min(after + 500, total_rows) + 1)]
            return httpx.Response(200, json=rows)
        return handler

    client=make_client(make_handler(total))
    try:
        tail=await client.client_logs_tail(1, 5)
        assert [row["d_l_id"] for row in tail] == [1196, 1197, 1198, 1199, 1200]
        assert afters == [0, 500, 1000, 1200]

        everything=await client.client_logs_tail(1, 5000)
        assert [row["d_l_id"] for row in everything] == list(range(1, total + 1))
    finally:
        await client.aclose()
