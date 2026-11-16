from datetime import datetime, timedelta, timezone

import jwt
import pytest
import pytest_asyncio
from fastapi.routing import APIRoute, iter_route_contexts
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text

from shared.database import Base, async_engine
from shared.secrets import token_hash
from shared.settings import settings


# 로그인 계획 Task 4 - 현재 사용자 의존성·AUTH_ENABLED·개인 토큰(PAT)·모든 라우트 인증 구조 시험


@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app

    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "auth_allowed_emails", "me@example.com,other@example.com")

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# raw SQL 한 줄 실행
async def sql(query:str, **params):
    async with async_engine.begin() as conn:
        result=await conn.execute(text(query), params)
        return result.fetchall() if result.returns_rows else None


# 사용자 하나를 바로 만든다 (Google 로그인 없이) - 반환: u_id
async def user_make(email:str="me@example.com", status:str="active") -> int:
    from shared.database import AsyncSessionLocal
    from auth_helpers import make_user

    async with AsyncSessionLocal() as db:
        return await make_user(db, email, status)


# 액세스 토큰 헤더
def bearer(token:str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# 꺼진 모드 - 토큰 없이도 지금처럼 동작한다
@pytest.mark.asyncio
async def test_current_user_off_mode(client):
    response=await client.get("/api/deploys")
    assert response.status_code == 200
    assert response.json() == []


# 켜진 모드 - Bearer 가 없거나 틀리면 401 + WWW-Authenticate, 맞으면 200
@pytest.mark.asyncio
async def test_current_user_on_mode_requires_bearer(client, monkeypatch):
    from features.auth.services import Auth_Service

    u_id=await user_make()
    monkeypatch.setattr(settings, "auth_enabled", True)

    good=Auth_Service.services_auth_access_issue(u_id)
    claims=jwt.decode(good, settings.auth_jwt_key, algorithms=["HS256"], audience="deploy-wizard-api")
    expired=Auth_Service.services_auth_access_issue(u_id, now=datetime.now(timezone.utc) - timedelta(hours=1))
    wrong_typ=jwt.encode({**claims, "typ": "refresh"}, settings.auth_jwt_key, algorithm="HS256")
    other_key=jwt.encode(claims, "another-key-another-key-another-key", algorithm="HS256")

    for headers in ({}, bearer("garbage"), bearer(expired), bearer(wrong_typ), bearer(other_key), {"Authorization": "Basic abc"}):
        response=await client.get("/api/deploys", headers=headers)
        assert response.status_code == 401, headers
        assert response.headers.get("www-authenticate") == "Bearer"
        assert response.json()["detail"] == "로그인이 필요합니다"

    assert (await client.get("/api/deploys", headers=bearer(good))).status_code == 200
    # 공개 경로는 켜진 모드에서도 토큰 없이
    assert (await client.get("/api/health")).status_code == 200


# 탈퇴한 사용자의 유효한 액세스 토큰은 401
@pytest.mark.asyncio
async def test_current_user_deleted_user_401(client, monkeypatch):
    from features.auth.services import Auth_Service

    u_id=await user_make(status="deleted")
    monkeypatch.setattr(settings, "auth_enabled", True)

    response=await client.get("/api/deploys", headers=bearer(Auth_Service.services_auth_access_issue(u_id)))
    assert response.status_code == 401
    assert response.headers.get("www-authenticate") == "Bearer"
    # 없는 사용자도 마찬가지
    assert (await client.get("/api/deploys", headers=bearer(Auth_Service.services_auth_access_issue(9999)))).status_code == 401


# 개인 토큰 - 발급(원문은 한 번)·목록(끝 4자리만)·사용·폐기·기간 상한·남의 것 404
@pytest.mark.asyncio
async def test_pat_lifecycle(client, monkeypatch):
    from features.auth.services import Auth_Service

    u_id=await user_make()
    other_id=await user_make("other@example.com")
    access=bearer(Auth_Service.services_auth_access_issue(u_id))
    other_access=bearer(Auth_Service.services_auth_access_issue(other_id))
    monkeypatch.setattr(settings, "auth_enabled", True)

    created=await client.post("/api/auth/tokens", json={"name": "mcp"}, headers=access)
    assert created.status_code == 201, created.text
    body=created.json()
    raw=body["token"]
    assert raw.startswith("dwp_")
    assert body["last4"] == raw[-4:]
    assert body["name"] == "mcp"
    # 기본 30일
    expires_at=datetime.fromisoformat(body["expires_at"])
    assert timedelta(days=29, hours=23) < expires_at - datetime.now(timezone.utc).replace(tzinfo=None) <= timedelta(days=30)

    # DB 에는 해시만
    rows=await sql("SELECT token_hash, last4, u_id FROM api_tokens")
    assert rows == [(token_hash(raw), raw[-4:], u_id)]

    listed=await client.get("/api/auth/tokens", headers=access)
    assert listed.status_code == 200
    assert len(listed.json()) == 1
    assert "token" not in listed.json()[0]
    assert raw not in listed.text
    assert listed.json()[0]["last4"] == raw[-4:]
    # 남의 목록에는 없다
    assert (await client.get("/api/auth/tokens", headers=other_access)).json() == []

    # 그 토큰으로 API 사용 - 마지막 사용 시각이 남는다
    assert (await client.get("/api/deploys", headers=bearer(raw))).status_code == 200
    first_used=(await sql("SELECT last_used_at FROM api_tokens"))[0][0]
    assert first_used is not None
    # 1분 안에 다시 쓰면 갱신하지 않는다
    assert (await client.get("/api/deploys", headers=bearer(raw))).status_code == 200
    assert (await sql("SELECT last_used_at FROM api_tokens"))[0][0] == first_used

    # 개인 토큰으로 개인 토큰을 관리할 수 없다 (새어 나간 토큰이 스스로 늘어나지 않게)
    assert (await client.post("/api/auth/tokens", json={"name": "x"}, headers=bearer(raw))).status_code == 403

    # 기간 상한·이름 길이
    assert (await client.post("/api/auth/tokens", json={"name": "mcp", "expires_in_days": 91}, headers=access)).status_code == 400
    assert (await client.post("/api/auth/tokens", json={"name": "mcp", "expires_in_days": 90}, headers=access)).status_code == 201
    assert (await client.post("/api/auth/tokens", json={"name": ""}, headers=access)).status_code == 422
    assert (await client.post("/api/auth/tokens", json={"name": "a" * 51}, headers=access)).status_code == 422

    # 남의 것 폐기는 404
    a_t_id=body["a_t_id"]
    assert (await client.delete(f"/api/auth/tokens/{a_t_id}", headers=other_access)).status_code == 404
    assert (await client.get("/api/deploys", headers=bearer(raw))).status_code == 200

    # 폐기 후 401
    assert (await client.delete(f"/api/auth/tokens/{a_t_id}", headers=access)).status_code == 200
    revoked=await client.get("/api/deploys", headers=bearer(raw))
    assert revoked.status_code == 401
    assert revoked.headers.get("www-authenticate") == "Bearer"
    assert (await client.delete(f"/api/auth/tokens/{a_t_id}", headers=access)).status_code == 404
    assert all(item["a_t_id"] != a_t_id for item in (await client.get("/api/auth/tokens", headers=access)).json())

    # 만료된 토큰도 401
    expired=await client.post("/api/auth/tokens", json={"name": "old"}, headers=access)
    expired_raw=expired.json()["token"]
    await sql("UPDATE api_tokens SET expires_at=:past WHERE a_t_id=:a_t_id", past=datetime(2020, 1, 1), a_t_id=expired.json()["a_t_id"])
    assert (await client.get("/api/deploys", headers=bearer(expired_raw))).status_code == 401

    # 모르는 dwp_ 토큰도 401
    assert (await client.get("/api/deploys", headers=bearer("dwp_unknown"))).status_code == 401


# 인증 의존성이 끝난 뒤 세션이 쓰기 잠금을 붙들지 않는다 - 세션을 연 채로 다른 연결의 쓰기가 바로 성공해야 한다
# (개인 토큰 갱신 경로·1분 안이라 건너뛰는 경로·액세스 토큰 경로 모두)
@pytest.mark.asyncio
async def test_current_user_leaves_no_write_lock(client, monkeypatch):
    from starlette.requests import Request
    from sqlalchemy.ext.asyncio import create_async_engine
    from shared.database import AsyncSessionLocal
    from features.auth.services import Auth_Service

    u_id=await user_make()
    access=Auth_Service.services_auth_access_issue(u_id)
    monkeypatch.setattr(settings, "auth_enabled", True)
    raw=(await client.post("/api/auth/tokens", json={"name": "mcp"}, headers=bearer(access))).json()["token"]

    # 잠금을 기다리지 않는 두 번째 엔진 - 잠겨 있으면 바로 "database is locked"
    other_engine=create_async_engine(settings.db_url.split("?", 1)[0], connect_args={"timeout": 0.2})

    # 요청 하나를 흉내 낸 Request
    def request_with(token:str) -> Request:
        return Request({"type": "http", "method": "GET", "path": "/api/deploys", "headers": [(b"authorization", f"Bearer {token}".encode())]})

    used={}
    try:
        # 처음 쓰기(갱신) -> 1분 안 다시 쓰기(건너뜀) -> 액세스 토큰
        for label, token in (("update", raw), ("skip", raw), ("access", access)):
            async with AsyncSessionLocal() as db:
                user=await Auth_Service.services_auth_current_user(request_with(token), db)
                assert user.u_id == u_id, label

                # 세션이 아직 열려 있는 동안 다른 연결이 쓴다
                async with other_engine.begin() as conn:
                    await conn.execute(text("UPDATE api_tokens SET name=:name"), {"name": "mcp-" + label})

            used[label]=(await sql("SELECT last_used_at FROM api_tokens"))[0][0]

        # 갱신 반복은 시각을 남기고, 건너뛰는 반복은 그 값을 건드리지 않는다
        assert used["update"] is not None
        assert used["skip"] == used["update"]
        assert used["access"] == used["update"]
        assert (await sql("SELECT name, last_used_at IS NOT NULL FROM api_tokens"))[0] == ("mcp-access", 1)
    finally:
        await other_engine.dispose()


# 꺼진 모드에서도 개인 토큰 관리·내 정보는 로그인 사용자가 있어야 한다
@pytest.mark.asyncio
async def test_pat_requires_user_in_off_mode(client):
    from features.auth.services import Auth_Service

    u_id=await user_make()

    missing=await client.get("/api/auth/tokens")
    assert missing.status_code == 401
    assert missing.headers.get("www-authenticate") == "Bearer"

    access=bearer(Auth_Service.services_auth_access_issue(u_id))
    assert (await client.post("/api/auth/tokens", json={"name": "mcp"}, headers=access)).status_code == 201
    assert len((await client.get("/api/auth/tokens", headers=access)).json()) == 1


# /api 아래 라우트가 보호받는지 훑는다 - APIRoute 는 현재 사용자 의존성이 있어야 하고, 웹소켓 같은 다른 종류는 allowed_other 에 적힌 경로만 통과한다
# 반환: (APIRoute 경로 모음, 문제가 있는 라우트 설명 목록)
def routes_unprotected(routes, public_paths:set, allowed_other:set=frozenset()) -> tuple[set, list]:
    from features.auth.services import Auth_Service

    # 의존성 트리를 재귀로 훑는다
    def has_current_user(dependant) -> bool:
        for sub in dependant.dependencies:
            if sub.call is Auth_Service.services_auth_current_user or has_current_user(sub):
                return True
        return False

    api_paths=set()
    missing=[]
    for context in iter_route_contexts(routes):
        # 라우터에 담겨 붙은 웹소켓은 context.path 가 빈 문자열로 나온다 - 실제 경로는 starlette_route 에 있다
        path=context.path or getattr(getattr(context, "starlette_route", None), "path", None) or getattr(context.original_route, "path", None) or ""
        if not (path == "/api" or path.startswith("/api/")):
            continue

        if not isinstance(context.original_route, APIRoute):
            if path not in allowed_other:
                missing.append(f"{type(context.original_route).__name__} {path}")
            continue

        api_paths.add(context.path)
        if context.path not in public_paths and not has_current_user(context.dependant):
            missing.append(f"{sorted(context.methods)} {context.path}")

    return api_paths, missing


# 모든 /api 라우트는 현재 사용자 의존성을 거친다 - 아니면 PUBLIC_PATHS 에 있어야 한다
def test_auth_every_route_requires_user():
    from main import app
    from features.auth.services import PUBLIC_PATHS

    api_paths, missing=routes_unprotected(app.routes, PUBLIC_PATHS)

    # 라우터를 못 읽었으면 시험이 의미 없다
    assert "/api/deploys" in api_paths and len(api_paths) > 30
    assert missing == [], "인증이 빠진 경로: " + ", ".join(missing)
    # 공개 목록에 없는 경로가 남아 있지 않다
    assert PUBLIC_PATHS <= api_paths, sorted(PUBLIC_PATHS - api_paths)


# 서버 시작 검사 - SECRET_KEY·BLIND_INDEX_KEY 는 어느 모드에서나, AUTH_JWT_KEY 는 켜진 모드에서만. 빠지면 한국어 오류
def test_auth_startup_check(monkeypatch):
    from features.auth.services import Auth_Service

    # 꺼진 모드 + 두 키 있음 - JWT 키 없이도 통과
    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "auth_jwt_key", None)
    Auth_Service.services_auth_startup_check()

    # 꺼진 모드에서도 BLIND_INDEX_KEY 가 없으면 멈춘다 (생성 명령을 알려 준다)
    monkeypatch.setattr(settings, "blind_index_key", None)
    with pytest.raises(RuntimeError) as error:
        Auth_Service.services_auth_startup_check()
    assert "서버를 시작하려면 .env 에" in str(error.value) and "BLIND_INDEX_KEY" in str(error.value)
    assert "secrets.token_urlsafe(48)" in str(error.value)

    # 꺼진 모드에서도 SECRET_KEY 가 없으면 멈춘다
    monkeypatch.setattr(settings, "blind_index_key", "test-blind-index-key-not-a-real-key")
    secret_key=settings.secret_key
    monkeypatch.setattr(settings, "secret_key", None)
    with pytest.raises(RuntimeError) as error:
        Auth_Service.services_auth_startup_check()
    assert "SECRET_KEY" in str(error.value) and "Fernet.generate_key()" in str(error.value)
    monkeypatch.setattr(settings, "secret_key", secret_key)

    # 켜진 모드 - AUTH_JWT_KEY 가 없으면 멈춘다
    monkeypatch.setattr(settings, "auth_enabled", True)
    with pytest.raises(RuntimeError) as error:
        Auth_Service.services_auth_startup_check()
    assert "로그인을 켜려면 .env 에" in str(error.value)
    assert "AUTH_JWT_KEY" in str(error.value)

    # 켜진 모드 - BLIND_INDEX_KEY 가 없어도 멈춘다
    monkeypatch.setattr(settings, "auth_jwt_key", "test-auth-jwt-key-not-a-real-key-0123456789")
    monkeypatch.setattr(settings, "blind_index_key", None)
    with pytest.raises(RuntimeError) as error:
        Auth_Service.services_auth_startup_check()
    assert "BLIND_INDEX_KEY" in str(error.value)

    monkeypatch.setattr(settings, "blind_index_key", "test-blind-index-key-not-a-real-key")
    Auth_Service.services_auth_startup_check()


# 스크립트로 MCP 토큰 발급 - 테스트 DB 에서 받은 토큰이 API 에서 통한다
@pytest.mark.asyncio
async def test_auth_token_script_create(client, monkeypatch):
    from scripts.auth_token import script_token_create, script_token_list, script_token_revoke

    await user_make()
    raw=await script_token_create("Me@Example.com", "mcp", 7)
    assert raw.startswith("dwp_")

    monkeypatch.setattr(settings, "auth_enabled", True)
    assert (await client.get("/api/deploys", headers=bearer(raw))).status_code == 200

    items=await script_token_list("me@example.com")
    assert [item.name for item in items] == ["mcp"]
    await script_token_revoke(items[0].a_t_id)
    assert (await client.get("/api/deploys", headers=bearer(raw))).status_code == 401

    # 없는 사용자·상한 초과는 한국어 오류
    with pytest.raises(RuntimeError):
        await script_token_create("nobody@example.com", "mcp", 7)
    with pytest.raises(RuntimeError):
        await script_token_create("me@example.com", "mcp", 91)


# 구조 시험이 웹소켓·일반 Starlette 라우트도 잡는다 - 보호 없이 /api 아래에 둔 것은 실패, 보호된 APIRoute 는 통과
def test_auth_route_check_catches_websocket_and_plain_routes():
    from fastapi import APIRouter, Depends, FastAPI, WebSocket
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route
    from features.auth.services import Auth_Service, PUBLIC_PATHS

    app=FastAPI()
    router=APIRouter()

    @router.get("/api/guarded-demo")
    async def guarded_demo(user=Depends(Auth_Service.services_auth_current_user)):
        return {}

    @router.get("/api/open-demo")
    async def open_demo():
        return {}

    @router.websocket("/api/ws-demo")
    async def ws_demo(websocket:WebSocket):
        await websocket.close()

    async def plain_demo(request):
        return PlainTextResponse("x")

    app.include_router(router)
    app.router.routes.append(Route("/api/plain-demo", plain_demo))

    api_paths, missing=routes_unprotected(app.routes, PUBLIC_PATHS)
    assert {"/api/guarded-demo", "/api/open-demo"} <= api_paths
    assert any("/api/open-demo" in item for item in missing)
    assert any("WebSocketRoute" in item and "/api/ws-demo" in item for item in missing), missing
    assert any("Route" in item and "/api/plain-demo" in item for item in missing), missing
    assert not any("/api/guarded-demo" in item for item in missing)

    # 허용 목록에 적은 경로만 통과한다
    _, allowed=routes_unprotected(app.routes, PUBLIC_PATHS | {"/api/open-demo"}, {"/api/ws-demo", "/api/plain-demo"})
    assert allowed == []


# 개인 토큰 마지막 사용 시각 - 1분이 지나면 다시 갱신한다 (시계를 앞으로 돌려 확인)
@pytest.mark.asyncio
async def test_pat_last_used_refreshes_after_a_minute(client, monkeypatch):
    from features.auth.services import Auth_Service, PAT_TOUCH_SECONDS

    u_id=await user_make()
    raw=(await client.post("/api/auth/tokens", json={"name": "mcp"}, headers=bearer(Auth_Service.services_auth_access_issue(u_id)))).json()["token"]
    monkeypatch.setattr(settings, "auth_enabled", True)

    start=datetime.now(timezone.utc).replace(tzinfo=None)
    clock=[start]
    monkeypatch.setattr(Auth_Service, "services_auth_now", staticmethod(lambda: clock[0]))

    async def used() -> datetime:
        return (await sql("SELECT last_used_at FROM api_tokens"))[0][0]

    assert (await client.get("/api/deploys", headers=bearer(raw))).status_code == 200
    first=await used()
    assert first is not None

    # 1분 안 - 그대로
    clock[0]=start + timedelta(seconds=PAT_TOUCH_SECONDS - 1)
    assert (await client.get("/api/deploys", headers=bearer(raw))).status_code == 200
    assert await used() == first

    # 1분 넘게 지난 뒤 - 새 시각으로 갱신
    clock[0]=start + timedelta(seconds=PAT_TOUCH_SECONDS + 1)
    assert (await client.get("/api/deploys", headers=bearer(raw))).status_code == 200
    second=await used()
    assert second != first
    assert datetime.fromisoformat(str(second)) == clock[0]


# 스크립트가 보여 주는 DB 위치 - 비밀번호·사용자 이름 없이 파일 경로나 호스트만
def test_auth_token_script_db_label_hides_credentials():
    from scripts.auth_token import script_db_label

    assert script_db_label("sqlite+aiosqlite:///./data/wizard.db?timeout=10") == "sqlite ./data/wizard.db"
    label=script_db_label("postgresql+asyncpg://admin:S3cretPass@db.example.com:5432/wizard?sslmode=require")
    assert "S3cretPass" not in label and "admin" not in label and "sslmode" not in label
    assert "db.example.com" in label and "5432" in label and "wizard" in label
    assert "S3cretPass" not in script_db_label("postgresql://admin:S3cretPass@db.example.com/wizard")
    # 읽을 수 없는 값은 아무것도 싣지 않는다
    assert "S3cretPass" not in script_db_label("not a url S3cretPass@@")


# create 가 안내문에 DB 주소를 쓸 때 자격 증명이 새지 않는다
@pytest.mark.asyncio
async def test_auth_token_script_main_create_does_not_print_credentials(client, monkeypatch, capsys):
    from argparse import Namespace
    from scripts.auth_token import script_main

    await user_make()
    monkeypatch.setattr(settings, "db_url", "postgresql+asyncpg://admin:S3cretPass@db.example.com:5432/wizard")
    await script_main(Namespace(command="create", email="me@example.com", name="mcp", days=7))

    captured=capsys.readouterr()
    assert captured.out.strip().startswith("dwp_")
    assert "S3cretPass" not in captured.err and "S3cretPass" not in captured.out
    assert "admin:" not in captured.err
    assert "db.example.com" in captured.err
