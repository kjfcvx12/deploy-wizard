import pytest
import pytest_asyncio
from datetime import datetime, timedelta

from httpx import AsyncClient, ASGITransport

from shared.database import Base, async_engine, AsyncSessionLocal

from features.deploys.models import Deploy
from features.incidents.models import Incident, Recovery_Action
from features.incidents.scheme import Incident_Explain

T0=datetime(2026, 11, 10, 3, 0, 0)


@pytest_asyncio.fixture
async def client():
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def seed_deploy() -> int:
    async with AsyncSessionLocal() as db:
        deploy=Deploy(repo_url="https://github.com/o/r", status='running')
        db.add(deploy)
        await db.commit()
        return deploy.d_id


async def seed_incident(d_id, status='open', kind='unhealthy', minutes=0, explain=True) -> int:
    async with AsyncSessionLocal() as db:
        body=Incident_Explain(summary="요약", cause="원인", fix_where="app/config.py", actions=["다시 배포"], source="rule").model_dump_json() if explain else None
        incident=Incident(d_id=d_id, kind=kind, status=status, summary="요약", explain=body, evidence="증거", detected_at=T0 + timedelta(minutes=minutes))
        db.add(incident)
        await db.commit()
        return incident.i_id


@pytest.mark.asyncio
async def test_incident_api_list_newest_first_and_filters(client):
    first_deploy=await seed_deploy()
    second_deploy=await seed_deploy()
    a=await seed_incident(first_deploy, 'resolved')
    b=await seed_incident(second_deploy, 'open')
    c=await seed_incident(first_deploy, 'needs_action')

    body=(await client.get("/api/incidents")).json()
    assert [row["i_id"] for row in body] == [c, b, a]

    assert [row["i_id"] for row in (await client.get("/api/incidents?status=open")).json()] == [b]
    assert [row["i_id"] for row in (await client.get(f"/api/incidents?d_id={first_deploy}")).json()] == [c, a]
    assert [row["i_id"] for row in (await client.get(f"/api/incidents?d_id={first_deploy}&status=resolved")).json()] == [a]


@pytest.mark.asyncio
async def test_incident_api_list_after_cursor_and_limit(client):
    d_id=await seed_deploy()
    ids=[await seed_incident(d_id, 'resolved', minutes=n) for n in range(105)]

    page1=(await client.get("/api/incidents")).json()
    assert len(page1) == 100
    assert page1[0]["i_id"] == ids[-1]

    page2=(await client.get(f"/api/incidents?after={page1[-1]['i_id']}")).json()
    assert [row["i_id"] for row in page2] == list(reversed(ids[:5]))


@pytest.mark.asyncio
async def test_incident_api_list_rejects_bad_status_and_after(client):
    assert (await client.get("/api/incidents?status=bogus")).status_code == 400
    assert (await client.get("/api/incidents?after=0")).status_code == 422


@pytest.mark.asyncio
async def test_incident_api_detail_has_parsed_explain_and_actions_in_time_order(client):
    d_id=await seed_deploy()
    i_id=await seed_incident(d_id, 'resolved')

    async with AsyncSessionLocal() as db:
        db.add(Recovery_Action(i_id=i_id, action='rollback', result='ok', started_at=T0 + timedelta(minutes=5)))
        db.add(Recovery_Action(i_id=i_id, action='restart', result='failed', detail="재시작 후에도 응답 없음", started_at=T0 + timedelta(minutes=1)))
        await db.commit()

    response=await client.get(f"/api/incidents/{i_id}")

    assert response.status_code == 200
    body=response.json()
    assert body["explain"] == {"summary": "요약", "cause": "원인", "fix_where": "app/config.py", "actions": ["다시 배포"], "source": "rule"}
    assert [a["action"] for a in body["actions"]] == ['restart', 'rollback']
    assert body["actions"][0]["detail"] == "재시작 후에도 응답 없음"


@pytest.mark.asyncio
async def test_incident_api_detail_without_explain_is_null(client):
    d_id=await seed_deploy()
    i_id=await seed_incident(d_id, explain=False)

    body=(await client.get(f"/api/incidents/{i_id}")).json()

    assert body["explain"] is None
    assert body["actions"] == []


@pytest.mark.asyncio
async def test_incident_api_unknown_ids_are_404_in_korean(client):
    response=await client.get("/api/incidents/999")
    assert (response.status_code, response.json()["detail"]) == (404, '해당 id의 인시던트가 없습니다')

    response=await client.get("/api/deploys/999/incidents")
    assert (response.status_code, response.json()["detail"]) == (404, '해당 id의 배포가 없습니다')


@pytest.mark.asyncio
async def test_incident_api_by_deploy_lists_only_that_deploy(client):
    mine=await seed_deploy()
    other=await seed_deploy()
    a=await seed_incident(mine, 'resolved')
    await seed_incident(other, 'open')
    b=await seed_incident(mine, 'open')

    body=(await client.get(f"/api/deploys/{mine}/incidents")).json()

    assert [row["i_id"] for row in body] == [b, a]


@pytest.mark.asyncio
async def test_incident_api_open_incident_id_in_deploy_read(client):
    d_id=await seed_deploy()
    assert (await client.get(f"/api/deploys/{d_id}")).json()["open_incident_id"] is None

    await seed_incident(d_id, 'resolved')
    assert (await client.get(f"/api/deploys/{d_id}")).json()["open_incident_id"] is None

    i_id=await seed_incident(d_id, 'open')
    assert (await client.get(f"/api/deploys/{d_id}")).json()["open_incident_id"] == i_id
    listed=(await client.get("/api/deploys")).json()
    assert [row["open_incident_id"] for row in listed if row["d_id"] == d_id] == [i_id]


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ['open', 'recovering', 'needs_action'])
async def test_incident_api_open_incident_status_follows_unresolved_incident(client, state):
    d_id=await seed_deploy()
    other=await seed_deploy()
    i_id=await seed_incident(d_id, state)

    one=(await client.get(f"/api/deploys/{d_id}")).json()
    listed={row["d_id"]: row for row in (await client.get("/api/deploys")).json()}

    assert (one["open_incident_id"], one["open_incident_status"]) == (i_id, state)
    assert (listed[d_id]["open_incident_id"], listed[d_id]["open_incident_status"]) == (i_id, state)
    assert (listed[other]["open_incident_id"], listed[other]["open_incident_status"]) == (None, None)


@pytest.mark.asyncio
async def test_incident_api_open_incident_status_is_null_when_resolved(client):
    d_id=await seed_deploy()
    await seed_incident(d_id, 'resolved')

    one=(await client.get(f"/api/deploys/{d_id}")).json()
    listed=[row for row in (await client.get("/api/deploys")).json() if row["d_id"] == d_id]

    assert (one["open_incident_id"], one["open_incident_status"]) == (None, None)
    assert (listed[0]["open_incident_id"], listed[0]["open_incident_status"]) == (None, None)
