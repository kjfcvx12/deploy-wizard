import pytest
import pytest_asyncio
from datetime import datetime, timedelta, timezone

from httpx import AsyncClient, ASGITransport

from shared.database import Base, async_engine, AsyncSessionLocal

from features.deploys.models import Deploy
from features.health.models import Health_Check
from features.deploys.pipeline import Deploy_Pipeline


@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    monkeypatch.setattr(Deploy_Pipeline, "pipeline_start", staticmethod(lambda *a, **kw: True))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def create_deploy(client) -> int:
    return (await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]


@pytest.mark.asyncio
async def test_settings_patch_changes_only_sent_fields(client):
    d_id=await create_deploy(client)

    response=await client.patch(f"/api/deploys/{d_id}/settings", json={"auto_recover": False})
    assert response.status_code == 200
    body=response.json()
    assert body["auto_recover"] is False
    assert body["auto_redeploy"] is True

    response=await client.patch(f"/api/deploys/{d_id}/settings", json={"auto_redeploy": False})
    body=response.json()
    assert body["auto_redeploy"] is False
    assert body["auto_recover"] is False

    got=(await client.get(f"/api/deploys/{d_id}")).json()
    assert got["auto_redeploy"] is False and got["auto_recover"] is False

    body=(await client.patch(f"/api/deploys/{d_id}/settings", json={"auto_redeploy": True, "auto_recover": True})).json()
    assert body["auto_redeploy"] is True and body["auto_recover"] is True


@pytest.mark.asyncio
async def test_settings_patch_rejects_unknown_fields(client):
    d_id=await create_deploy(client)

    response=await client.patch(f"/api/deploys/{d_id}/settings", json={"auto_recover": False, "status": "running"})
    assert response.status_code == 422

    assert (await client.get(f"/api/deploys/{d_id}")).json()["auto_recover"] is True


@pytest.mark.asyncio
async def test_settings_patch_empty_body_is_400_korean(client):
    d_id=await create_deploy(client)

    for payload in ({}, {"auto_recover": None}):
        response=await client.patch(f"/api/deploys/{d_id}/settings", json=payload)
        assert response.status_code == 400
        assert "변경할 설정" in response.json()["detail"]


@pytest.mark.asyncio
async def test_settings_patch_unknown_or_deleted_deploy_is_404(client):
    assert (await client.patch("/api/deploys/9999/settings", json={"auto_recover": False})).status_code == 404

    d_id=await create_deploy(client)
    async with AsyncSessionLocal() as db:
        (await db.get(Deploy, d_id)).status='deleted'
        await db.commit()

    response=await client.patch(f"/api/deploys/{d_id}/settings", json={"auto_recover": False})
    assert response.status_code == 404
    assert "배포" in response.json()["detail"]


@pytest.mark.asyncio
async def test_health_history_api_order_and_bounds(client):
    d_id=await create_deploy(client)
    now=datetime.now(timezone.utc).replace(tzinfo=None)

    async with AsyncSessionLocal() as db:
        db.add_all([
            Health_Check(d_id=d_id, ok=False, status_code=503, detail="HTTP 503", checked_at=now - timedelta(minutes=20)),
            Health_Check(d_id=d_id, ok=True, status_code=200, checked_at=now - timedelta(minutes=10)),
            Health_Check(d_id=d_id, ok=True, status_code=200, checked_at=now - timedelta(hours=30)),
        ])
        await db.commit()

    response=await client.get(f"/api/deploys/{d_id}/health-history")
    assert response.status_code == 200
    rows=response.json()
    assert [r["ok"] for r in rows] == [False, True]
    assert rows[0]["checked_at"] < rows[1]["checked_at"]
    assert set(rows[0]) == {"h_c_id", "d_id", "ok", "status_code", "latency_ms", "detail", "checked_at"}

    assert len((await client.get(f"/api/deploys/{d_id}/health-history?hours=168")).json()) == 3
    assert len((await client.get(f"/api/deploys/{d_id}/health-history?hours=1")).json()) == 2

    assert (await client.get(f"/api/deploys/{d_id}/health-history?hours=0")).status_code == 422
    assert (await client.get(f"/api/deploys/{d_id}/health-history?hours=200")).status_code == 422


@pytest.mark.asyncio
async def test_health_history_api_unknown_deploy_is_404(client):
    response=await client.get("/api/deploys/9999/health-history")
    assert response.status_code == 404
    assert "배포" in response.json()["detail"]
