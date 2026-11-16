import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from shared.database import Base, async_engine, AsyncSessionLocal

from features.notifications.models import Notification, Push_Device

TOKEN="ExponentPushToken[abcdefghijklmnopqrstuvwxyz]"


@pytest_asyncio.fixture
async def client():
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def seed(channel='inapp', read=False, kind='deploy_failed', title="제목") -> int:
    async with AsyncSessionLocal() as db:
        from datetime import datetime
        note=Notification(kind=kind, channel=channel, title=title, body="본문", status='sent', read_at=datetime(2026, 11, 10) if read else None)
        db.add(note)
        await db.commit()
        return note.n_id


@pytest.mark.asyncio
async def test_notification_api_list_inapp_only_newest_first(client):
    first=await seed()
    await seed(channel='email')
    await seed(channel='push')
    third=await seed(read=True)

    body=(await client.get("/api/notifications")).json()

    assert [row["n_id"] for row in body] == [third, first]
    assert set(body[0]) >= {"n_id", "kind", "title", "body", "d_id", "i_id", "read_at", "created_at"}


@pytest.mark.asyncio
async def test_notification_api_list_unread_filter_after_and_limit(client):
    ids=[await seed(read=(n % 2 == 0)) for n in range(105)]

    unread=(await client.get("/api/notifications?unread=true")).json()
    assert all(row["read_at"] is None for row in unread) and len(unread) == 52

    page1=(await client.get("/api/notifications")).json()
    assert len(page1) == 100 and page1[0]["n_id"] == ids[-1]

    page2=(await client.get(f"/api/notifications?after={page1[-1]['n_id']}")).json()
    assert [row["n_id"] for row in page2] == ids[:5][::-1]

    assert (await client.get("/api/notifications?after=0")).status_code == 422


@pytest.mark.asyncio
async def test_notification_api_unread_count_read_and_read_all(client):
    a=await seed()
    b=await seed()
    await seed(channel='email')
    await seed(read=True)

    assert (await client.get("/api/notifications/unread-count")).json() == {"count": 2}

    response=await client.post(f"/api/notifications/{a}/read")
    assert response.status_code == 200 and response.json()["read_at"] is not None
    assert (await client.get("/api/notifications/unread-count")).json() == {"count": 1}

    again=await client.post(f"/api/notifications/{a}/read")
    assert again.status_code == 200

    assert (await client.post("/api/notifications/read-all")).json() == {"updated": 1}
    assert (await client.get("/api/notifications/unread-count")).json() == {"count": 0}
    assert (await client.post("/api/notifications/read-all")).json() == {"updated": 0}
    assert b


@pytest.mark.asyncio
async def test_notification_api_read_unknown_or_non_inapp_is_404(client):
    email=await seed(channel='email')

    for n_id in (9999, email):
        response=await client.post(f"/api/notifications/{n_id}/read")
        assert response.status_code == 404 and "알림" in response.json()["detail"]


@pytest.mark.asyncio
async def test_device_api_register_masks_token_and_upserts(client):
    created=await client.post("/api/devices", json={"expo_token": TOKEN, "platform": "android"})

    assert created.status_code == 201
    body=created.json()
    assert body["platform"] == "android" and body["token_tail"] == TOKEN[-6:]
    assert TOKEN not in created.text and "expo_token" not in body

    again=await client.post("/api/devices", json={"expo_token": TOKEN, "platform": "android"})
    assert again.status_code == 201 and again.json()["p_d_id"] == body["p_d_id"] and again.json()["platform"] == "android"

    async with AsyncSessionLocal() as db:
        assert len((await db.execute(select(Push_Device))).scalars().all()) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [
    {"expo_token": "not-a-token", "platform": "android"},
    {"expo_token": "ExponentPushToken[]", "platform": "android"},
    {"expo_token": "FcmToken[abc]", "platform": "android"},
    {"expo_token": TOKEN, "platform": "windows"},
    {"expo_token": TOKEN, "platform": "ios"},
    {"platform": "android"},
])
async def test_device_api_rejects_invalid_payload(client, payload):
    response=await client.post("/api/devices", json=payload)

    assert response.status_code == 422
    assert "abcdefghijklmnopqrstuvwxyz" not in response.text


@pytest.mark.asyncio
async def test_device_api_accepts_expo_prefix_variant(client):
    response=await client.post("/api/devices", json={"expo_token": "ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]", "platform": "android"})

    assert response.status_code == 201


@pytest.mark.asyncio
async def test_device_api_delete(client):
    p_d_id=(await client.post("/api/devices", json={"expo_token": TOKEN, "platform": "android"})).json()["p_d_id"]

    assert (await client.delete(f"/api/devices/{p_d_id}")).status_code == 200
    missing=await client.delete(f"/api/devices/{p_d_id}")
    assert missing.status_code == 404 and "기기" in missing.json()["detail"]


@pytest.mark.asyncio
async def test_notification_settings_api_get_defaults_and_patch(client):
    body=(await client.get("/api/notifications/settings")).json()
    assert body["notify_email"] is True and body["notify_push"] is True
    assert set(body["kinds"]) == {"incident_opened", "incident_recovered", "incident_needs_action", "deploy_succeeded", "deploy_failed", "new_commit", "plan_exceeded"}

    patched=await client.patch("/api/notifications/settings", json={"notify_push": False, "kinds": ["deploy_failed", "incident_opened"]})
    assert patched.status_code == 200
    assert patched.json() == {"notify_email": True, "notify_push": False, "kinds": ["deploy_failed", "incident_opened"]}
    assert (await client.get("/api/notifications/settings")).json() == patched.json()

    partial=await client.patch("/api/notifications/settings", json={"notify_email": False})
    assert partial.json() == {"notify_email": False, "notify_push": False, "kinds": ["deploy_failed", "incident_opened"]}


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [
    {"kinds": ["deploy_failed", "nope"]},
    {"unknown_field": 1},
    {"notify_email": "maybe"},
])
async def test_notification_settings_api_rejects_bad_patch(client, payload):
    assert (await client.patch("/api/notifications/settings", json=payload)).status_code == 422


@pytest.mark.asyncio
async def test_device_api_validation_error_does_not_echo_the_token(client):
    response=await client.post("/api/devices", json={"expo_token": TOKEN})

    assert response.status_code == 422
    assert TOKEN not in response.text and "abcdefghijklmnopqrstuvwxyz" not in response.text
    item=response.json()["detail"][0]
    assert "input" not in item and item["loc"] and item["msg"] and item["type"]


@pytest.mark.asyncio
async def test_other_routes_keep_the_default_validation_body(client):
    response=await client.get("/api/notifications?after=0")

    assert response.status_code == 422 and "input" in response.json()["detail"][0]
