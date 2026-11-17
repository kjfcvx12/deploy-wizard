import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

from shared.settings import settings


CONFIG_KEYS={"auth_required", "login_available", "platforms", "google_client_id_web", "pat_default_days", "pat_max_days"}
WEB_ID="web-client-id.apps.googleusercontent.com"
ANDROID_ID="android-client-id.apps.googleusercontent.com"
JWT_KEY="real-looking-jwt-key-9f8e7d6c5b4a39281706"
SECRET_KEY_VALUE="real-looking-fernet-secret-Zm9vYmFyYmF6cXV4"
BLIND_KEY_VALUE="real-looking-blind-index-key-qwertyuiop12"
ALLOWED_EMAIL="owner-secret@example.com"


# 앱 + 설정 기본값 (로그인 꺼짐, 클라이언트 ID 없음) - 시험마다 필요한 것만 바꾼다
@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app

    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "google_client_id_web", None)
    monkeypatch.setattr(settings, "google_client_id_android", None)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# 꺼진 모드 - 로그인이 필요 없고 키 집합은 정확히 6개
@pytest.mark.asyncio
async def test_auth_config_off_mode(client):
    response=await client.get("/api/auth/config")

    assert response.status_code == 200
    body=response.json()
    assert set(body) == CONFIG_KEYS
    assert body["auth_required"] is False
    assert body["pat_default_days"] == settings.auth_pat_default_days
    assert body["pat_max_days"] == settings.auth_pat_max_days


# 켜진 모드 + 웹·안드로이드 ID - 플랫폼은 정렬해서, 웹 클라이언트 ID 는 설정값 그대로
@pytest.mark.asyncio
async def test_auth_config_on_mode_with_ids(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "auth_jwt_key", "k")
    monkeypatch.setattr(settings, "google_client_id_web", "  " + WEB_ID + " ")
    monkeypatch.setattr(settings, "google_client_id_android", ANDROID_ID)

    body=(await client.get("/api/auth/config")).json()

    assert body["auth_required"] is True
    assert body["login_available"] is True
    assert body["platforms"] == ["android", "web"]
    assert body["google_client_id_web"] == WEB_ID


# 로그인 불가 - ID 가 없으면 플랫폼이 비고, ID 가 있어도 JWT 키가 없으면 로그인 불가
@pytest.mark.asyncio
@pytest.mark.parametrize("web_id,android_id,jwt_key,platforms,available,web_out", [
    (None, None, "k", [], False, None),
    ("   ", "", "k", [], False, None),
    (WEB_ID, ANDROID_ID, None, ["android", "web"], False, WEB_ID),
    (None, ANDROID_ID, "k", ["android"], True, None),
])
async def test_auth_config_login_unavailable(client, monkeypatch, web_id, android_id, jwt_key, platforms, available, web_out):
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "auth_jwt_key", jwt_key)
    monkeypatch.setattr(settings, "google_client_id_web", web_id)
    monkeypatch.setattr(settings, "google_client_id_android", android_id)

    body=(await client.get("/api/auth/config")).json()

    assert body["platforms"] == platforms
    assert body["login_available"] is available
    assert body["google_client_id_web"] == web_out


# 비밀은 응답에 없다 - 진짜처럼 보이는 값을 설정해 두고 본문 전체를 훑는다
@pytest.mark.asyncio
async def test_auth_config_no_secrets(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "auth_jwt_key", JWT_KEY)
    monkeypatch.setattr(settings, "secret_key", SECRET_KEY_VALUE)
    monkeypatch.setattr(settings, "blind_index_key", BLIND_KEY_VALUE)
    monkeypatch.setattr(settings, "auth_allowed_emails", ALLOWED_EMAIL)
    monkeypatch.setattr(settings, "google_client_id_web", WEB_ID)
    monkeypatch.setattr(settings, "google_client_id_android", ANDROID_ID)

    response=await client.get("/api/auth/config")

    assert response.status_code == 200
    for secret in (JWT_KEY, SECRET_KEY_VALUE, BLIND_KEY_VALUE, ALLOWED_EMAIL, "owner-secret"):
        assert secret not in response.text
    for name in ("auth_jwt_key", "secret_key", "blind_index_key", "allowed"):
        assert name not in response.text


# 켜진 모드에서도 Authorization 없이 열린다
@pytest.mark.asyncio
async def test_auth_config_public_on_mode(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "auth_jwt_key", "k")

    response=await client.get("/api/auth/config")

    assert response.status_code == 200
    assert response.json()["auth_required"] is True
