import asyncio
import hashlib
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text

from shared.database import Base, async_engine
from shared.secrets import blind_index
from shared.settings import settings

from features.auth import google as google_module
from features.auth.google import Google_Auth_Error, Google_Identity
from features.auth.crud import Auth_Crud


ORIGIN_OK="http://localhost:5173"
MESSAGE_EXPIRED="로그인이 만료되었습니다. 다시 로그인해 주세요"
MESSAGE_NOT_ALLOWED="로그인이 허용된 계정이 아닙니다"
MESSAGE_ORIGIN="허용되지 않은 출처입니다"

IDENTITIES={
    "good-token": Google_Identity(sub="google-sub-1", email="me@example.com", name="나", picture_url="https://example.com/me.png"),
    "good-token-renamed": Google_Identity(sub="google-sub-1", email="Me@Example.com", name="새 이름", picture_url=None),
    "other-token": Google_Identity(sub="google-sub-2", email="other@example.com", name="남", picture_url=None),
}


# 가짜 Google 검증기 - 받은 aud 모음을 기록하고, 정해진 사용자 정보를 돌려준다
class Fake_Verifier:

    def __init__(self):
        self.calls=[]

    async def verifier_google_verify(self, id_token:str, client_ids:set[str]) -> Google_Identity:
        self.calls.append(set(client_ids))
        if id_token not in IDENTITIES:
            raise Google_Auth_Error("Google 로그인 정보를 확인할 수 없습니다. 다시 로그인해 주세요", 401)
        return IDENTITIES[id_token]


@pytest.fixture
def fake_verifier(monkeypatch):
    fake=Fake_Verifier()
    monkeypatch.setattr(google_module, "GOOGLE_VERIFIER", fake)
    return fake


@pytest_asyncio.fixture
async def client(fake_verifier, monkeypatch):
    from main import app

    monkeypatch.setattr(settings, "auth_allowed_emails", "me@example.com")
    monkeypatch.setattr(settings, "google_client_id_web", "web-client-id")
    monkeypatch.setattr(settings, "google_client_id_android", "android-client-id")
    monkeypatch.setattr(settings, "auth_cookie_secure", False)
    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "cors_origins", "http://localhost:5173,http://127.0.0.1:5173")

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# 앱으로 로그인하고 응답 본문을 돌려준다
async def login_app(client, id_token:str="good-token") -> dict:
    response=await client.post("/api/auth/google", json={"id_token": id_token, "platform": "android"})
    assert response.status_code == 200, response.text
    return response.json()


# raw SQL 한 줄 실행
async def sql(query:str, **params):
    async with async_engine.begin() as conn:
        result=await conn.execute(text(query), params)
        return result.fetchall() if result.returns_rows else None


# 앱 로그인 - 사용자와 토큰이 생기고, 다시 로그인하면 같은 사용자
@pytest.mark.asyncio
async def test_auth_google_creates_user_and_tokens(client, fake_verifier):
    body=await login_app(client)

    assert body["refresh_token"].startswith("dwr_")
    assert body["expires_in"] == 900
    assert body["access_token"]
    assert body["user"]["email"] == "me@example.com"
    assert body["user"]["name"] == "나"
    # 안드로이드 로그인은 안드로이드 클라이언트 ID 만 aud 로 받는다
    assert fake_verifier.calls[-1] == {"android-client-id"}

    again=await login_app(client, "good-token-renamed")
    assert again["user"]["u_id"] == body["user"]["u_id"]
    # 있는 사용자는 이름·사진을 갱신한다
    assert again["user"]["name"] == "새 이름"
    assert again["user"]["picture_url"] is None

    assert (await sql("SELECT COUNT(*) FROM users"))[0][0] == 1
    rows=await sql("SELECT token_hash, platform, family_id FROM refresh_tokens ORDER BY r_t_id")
    assert len(rows) == 2
    assert rows[0][0] == hashlib.sha256(body["refresh_token"].encode()).hexdigest()
    for token_hash, platform, family_id in rows:
        assert len(token_hash) == 64
        assert token_hash not in (body["refresh_token"], again["refresh_token"])
        assert platform == "android"
    # 로그인마다 새 계열
    assert rows[0][2] != rows[1][2]


# 웹 로그인 - 리프레시는 httpOnly 쿠키로만
@pytest.mark.asyncio
async def test_auth_google_web_sets_cookie(client, fake_verifier):
    response=await client.post("/api/auth/google", json={"id_token": "good-token", "platform": "web"})
    assert response.status_code == 200

    assert response.json()["refresh_token"] is None
    cookie=response.headers["set-cookie"]
    assert "dw_refresh=dwr_" in cookie
    assert "HttpOnly" in cookie
    assert "SameSite=strict" in cookie
    assert "Path=/api/auth" in cookie
    assert f"Max-Age={settings.auth_refresh_days * 86400}" in cookie
    assert "Secure" not in cookie
    assert fake_verifier.calls[-1] == {"web-client-id"}


# 웹 쿠키 - AUTH_COOKIE_SECURE 이면 Secure 가 붙는다
@pytest.mark.asyncio
async def test_auth_google_web_cookie_secure(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_cookie_secure", True)
    response=await client.post("/api/auth/google", json={"id_token": "good-token", "platform": "web"})
    assert response.status_code == 200
    assert "Secure" in response.headers["set-cookie"]


# 허용 목록 밖의 이메일 - 403, 사용자를 만들지 않는다
@pytest.mark.asyncio
async def test_auth_google_not_allowed_403(client):
    response=await client.post("/api/auth/google", json={"id_token": "other-token", "platform": "android"})
    assert response.status_code == 403
    assert response.json()["detail"] == MESSAGE_NOT_ALLOWED
    assert (await sql("SELECT COUNT(*) FROM users"))[0][0] == 0
    assert (await sql("SELECT COUNT(*) FROM refresh_tokens"))[0][0] == 0


# Google 검증 실패 - 401, 메시지에 토큰을 싣지 않는다
@pytest.mark.asyncio
async def test_auth_google_bad_token_401(client):
    response=await client.post("/api/auth/google", json={"id_token": "garbage-id-token-value", "platform": "android"})
    assert response.status_code == 401
    assert "garbage-id-token-value" not in response.text


# 플랫폼은 정해진 것만 - iOS 는 아직 없다
@pytest.mark.asyncio
async def test_auth_google_unknown_platform_422(client, fake_verifier):
    for platform in ("ios", "desktop", ""):
        response=await client.post("/api/auth/google", json={"id_token": "good-token", "platform": platform})
        assert response.status_code == 422
    assert fake_verifier.calls == []


# 리프레시 회전 - 새 토큰 발급, 옛 것을 다시 쓰면 401 이고 계열 전체가 폐기된다
@pytest.mark.asyncio
async def test_auth_refresh_rotates(client):
    first=(await login_app(client))["refresh_token"]

    response=await client.post("/api/auth/refresh", json={"refresh_token": first})
    assert response.status_code == 200
    second=response.json()["refresh_token"]
    assert second.startswith("dwr_") and second != first
    assert response.json()["access_token"]

    rows=await sql("SELECT r_t_id, family_id, revoked_at, replaced_by FROM refresh_tokens ORDER BY r_t_id")
    assert rows[0][1] == rows[1][1]
    assert rows[0][2] is not None
    assert rows[0][3] == rows[1][0]

    reused=await client.post("/api/auth/refresh", json={"refresh_token": first})
    assert reused.status_code == 401
    assert reused.json()["detail"] == MESSAGE_EXPIRED

    after=await client.post("/api/auth/refresh", json={"refresh_token": second})
    assert after.status_code == 401


# 동시 리프레시 - 둘 다 "아직 폐기 전"을 읽은 뒤 갱신해도 하나만 성공한다
@pytest.mark.asyncio
async def test_auth_refresh_concurrent_only_one_wins(client, monkeypatch):
    token=(await login_app(client))["refresh_token"]

    # 두 요청이 모두 조회를 마칠 때까지 기다리게 해서, 폐기 갱신(UPDATE ... WHERE revoked_at IS NULL)만 승패를 가르게 한다
    barrier=asyncio.Barrier(2)
    original=Auth_Crud.crud_refresh_token_get_by_hash

    async def get_then_wait(db, token_hash):
        row=await original(db, token_hash)
        await asyncio.wait_for(barrier.wait(), 10)
        return row

    monkeypatch.setattr(Auth_Crud, "crud_refresh_token_get_by_hash", staticmethod(get_then_wait))

    first, second=await asyncio.gather(
        client.post("/api/auth/refresh", json={"refresh_token": token}),
        client.post("/api/auth/refresh", json={"refresh_token": token}),
    )
    codes=sorted([first.status_code, second.status_code])
    assert codes == [200, 401]

    monkeypatch.setattr(Auth_Crud, "crud_refresh_token_get_by_hash", staticmethod(original))
    winner=first if first.status_code == 200 else second
    # 경합에서 진 쪽은 재사용이 아니므로 이긴 쪽의 새 토큰은 살아 있다
    assert (await sql("SELECT COUNT(*) FROM refresh_tokens"))[0][0] == 2
    follow=await client.post("/api/auth/refresh", json={"refresh_token": winner.json()["refresh_token"]})
    assert follow.status_code == 200


# 만료된 리프레시 - 401
@pytest.mark.asyncio
async def test_auth_refresh_expired_401(client):
    token=(await login_app(client))["refresh_token"]
    past=(datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=1)).isoformat(sep=" ")
    await sql("UPDATE refresh_tokens SET expires_at=:past", past=past)

    response=await client.post("/api/auth/refresh", json={"refresh_token": token})
    assert response.status_code == 401
    assert response.json()["detail"] == MESSAGE_EXPIRED


# 모르는 토큰·빈 요청 - 401
@pytest.mark.asyncio
async def test_auth_refresh_unknown_401(client):
    assert (await client.post("/api/auth/refresh", json={"refresh_token": "dwr_unknown_token_value_xxxxxxxx"})).status_code == 401
    assert (await client.post("/api/auth/refresh", json={})).status_code == 401


# 탈퇴한 사용자 - 리프레시 401
@pytest.mark.asyncio
async def test_auth_refresh_inactive_user_401(client):
    token=(await login_app(client))["refresh_token"]
    await sql("UPDATE users SET status='deleted'")

    response=await client.post("/api/auth/refresh", json={"refresh_token": token})
    assert response.status_code == 401


# 허용 목록에서 빠진 이메일 - 리프레시 401 이고 계열 전체가 폐기된다
@pytest.mark.asyncio
async def test_auth_refresh_email_removed_from_allowlist_401(client, monkeypatch):
    first=(await login_app(client))["refresh_token"]
    second=(await client.post("/api/auth/refresh", json={"refresh_token": first})).json()["refresh_token"]

    monkeypatch.setattr(settings, "auth_allowed_emails", "someone-else@example.com")
    response=await client.post("/api/auth/refresh", json={"refresh_token": second})
    assert response.status_code == 401
    assert response.json()["detail"] == MESSAGE_EXPIRED

    rows=await sql("SELECT revoked_at FROM refresh_tokens")
    assert rows and all(row[0] is not None for row in rows)

    # 다시 허용해도 끊긴 계열은 살아나지 않는다
    monkeypatch.setattr(settings, "auth_allowed_emails", "me@example.com")
    assert (await client.post("/api/auth/refresh", json={"refresh_token": second})).status_code == 401


# 빈 허용 목록 - 아무도 리프레시할 수 없다 (로그인과 같다)
@pytest.mark.asyncio
async def test_auth_refresh_empty_allowlist_401(client, monkeypatch):
    token=(await login_app(client))["refresh_token"]
    monkeypatch.setattr(settings, "auth_allowed_emails", "")
    assert (await client.post("/api/auth/refresh", json={"refresh_token": token})).status_code == 401


# 허용 목록에 그대로 있으면 리프레시가 계속 된다 (대소문자 무관)
@pytest.mark.asyncio
async def test_auth_refresh_still_allowed_200(client, monkeypatch):
    token=(await login_app(client))["refresh_token"]
    monkeypatch.setattr(settings, "auth_allowed_emails", "other@example.com, ME@example.com")
    for _ in range(2):
        response=await client.post("/api/auth/refresh", json={"refresh_token": token})
        assert response.status_code == 200
        token=response.json()["refresh_token"]


# 로그아웃 - 그 계열 폐기, 모르는 토큰·빈 요청도 200
@pytest.mark.asyncio
async def test_auth_logout_revokes_family(client):
    first=(await login_app(client))["refresh_token"]
    second=(await client.post("/api/auth/refresh", json={"refresh_token": first})).json()["refresh_token"]
    other=(await login_app(client))["refresh_token"]

    response=await client.post("/api/auth/logout", json={"refresh_token": second})
    assert response.status_code == 200

    assert (await client.post("/api/auth/refresh", json={"refresh_token": second})).status_code == 401
    # 다른 계열(다른 기기 로그인)은 그대로
    assert (await client.post("/api/auth/refresh", json={"refresh_token": other})).status_code == 200

    assert (await client.post("/api/auth/logout", json={"refresh_token": "dwr_unknown_token_value_xxxxxxxx"})).status_code == 200
    assert (await client.post("/api/auth/logout", json={})).status_code == 200


# 쿠키로 온 리프레시·로그아웃 - Origin 이 허용 목록에 있어야 한다
@pytest.mark.asyncio
async def test_auth_cookie_refresh_origin_check(client):
    response=await client.post("/api/auth/google", json={"id_token": "good-token", "platform": "web"})
    assert response.status_code == 200
    assert client.cookies.get("dw_refresh", "").startswith("dwr_")

    no_origin=await client.post("/api/auth/refresh")
    assert no_origin.status_code == 403
    assert no_origin.json()["detail"] == MESSAGE_ORIGIN

    evil=await client.post("/api/auth/refresh", headers={"Origin": "http://evil.example"})
    assert evil.status_code == 403
    assert evil.json()["detail"] == MESSAGE_ORIGIN

    # 거절된 요청은 토큰을 쓰지 않았다
    ok=await client.post("/api/auth/refresh", headers={"Origin": ORIGIN_OK})
    assert ok.status_code == 200
    assert ok.json()["refresh_token"] is None
    assert "dw_refresh=dwr_" in ok.headers["set-cookie"]

    assert (await client.post("/api/auth/logout")).status_code == 403
    assert (await client.post("/api/auth/logout", headers={"Origin": "http://evil.example"})).status_code == 403

    current=client.cookies.get("dw_refresh")
    out=await client.post("/api/auth/logout", headers={"Origin": ORIGIN_OK})
    assert out.status_code == 200
    cleared=out.headers["set-cookie"]
    assert "dw_refresh=" in cleared and "Max-Age=0" in cleared and "Path=/api/auth" in cleared

    # 쿠키를 지운 뒤에도 그 토큰은 서버에서 폐기됐다
    assert (await client.post("/api/auth/refresh", json={"refresh_token": current})).status_code == 401


# 내 정보 - 액세스 토큰이 있어야 한다 (AUTH_ENABLED 와 무관)
@pytest.mark.asyncio
async def test_auth_me(client):
    body=await login_app(client)

    response=await client.get("/api/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert response.status_code == 200
    assert response.json() == {"u_id": body["user"]["u_id"], "email": "me@example.com", "name": "나",
                               "picture_url": "https://example.com/me.png"}

    missing=await client.get("/api/me")
    assert missing.status_code == 401
    assert missing.headers.get("www-authenticate") == "Bearer"

    assert (await client.get("/api/me", headers={"Authorization": "Bearer garbage"})).status_code == 401
    # 리프레시 토큰은 액세스 토큰이 아니다
    assert (await client.get("/api/me", headers={"Authorization": f"Bearer {body['refresh_token']}"})).status_code == 401


# 액세스 토큰 - 만료·다른 키·다른 용도는 401
@pytest.mark.asyncio
async def test_auth_access_token_rules(client):
    import jwt
    from fastapi import HTTPException
    from features.auth.services import Auth_Service

    token=Auth_Service.services_auth_access_issue(7)
    assert Auth_Service.services_auth_access_decode(token) == 7

    claims=jwt.decode(token, settings.auth_jwt_key, algorithms=["HS256"], audience="deploy-wizard-api")
    assert claims["sub"] == "7" and claims["typ"] == "access" and claims["iss"] == "deploy-wizard"
    assert claims["exp"] - claims["iat"] == 900

    old=Auth_Service.services_auth_access_issue(7, now=datetime.now(timezone.utc) - timedelta(hours=1))
    other_key=jwt.encode({**claims}, "another-key-another-key-another-key", algorithm="HS256")
    wrong_typ=jwt.encode({**claims, "typ": "refresh"}, settings.auth_jwt_key, algorithm="HS256")
    for bad in (old, other_key, wrong_typ, "garbage"):
        with pytest.raises(HTTPException) as error:
            Auth_Service.services_auth_access_decode(bad)
        assert error.value.status_code == 401


# 사용자 정보는 DB 에 암호문으로만 - 찾기는 블라인드 인덱스로
@pytest.mark.asyncio
async def test_auth_user_pii_encrypted_at_rest(client):
    await login_app(client)

    rows=await sql("SELECT email, google_sub, name, picture_url, email_bidx, google_sub_bidx FROM users")
    email, google_sub, name, picture_url, email_bidx, google_sub_bidx=rows[0]
    for value, plain in ((email, "me@example.com"), (google_sub, "google-sub-1"), (name, "나"), (picture_url, "https://example.com/me.png")):
        assert value.startswith("gAAAAA")
        assert plain not in value
    assert email_bidx == blind_index("email", "me@example.com")
    assert google_sub_bidx == blind_index("google_sub", "google-sub-1")
