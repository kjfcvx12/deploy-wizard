import json
import pytest
import pytest_asyncio
from datetime import datetime
from httpx import AsyncClient, ASGITransport

from shared.database import Base, async_engine, AsyncSessionLocal
from shared.settings import settings

# 모델을 import 해야 create_all 이 테이블을 안다
from features.accounts import models as account_models
from features.deploys.models import Deploy, Deploy_Release
from features.health.models import Health_Check
from features.incidents.models import Incident, Recovery_Action
from features.notifications.models import Notification, Push_Device, Notification_Setting
from features.incidents.services import Incident_Service
from features.deploys.pipeline import Deploy_Pipeline
from features.health.services import Health_Service
from features.health.crud import Health_Crud
from features.notifications.crud import Notification_Crud


@pytest_asyncio.fixture
async def db():
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as session:
        yield session


@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    monkeypatch.setattr(Deploy_Pipeline, "pipeline_start", staticmethod(lambda *a, **kw: True))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# 테스트용 배포 한 건
async def make_deploy(db) -> int:
    deploy=Deploy(repo_url="https://github.com/o/r", status='running')
    db.add(deploy)
    await db.flush()
    return deploy.d_id


@pytest.mark.asyncio
async def test_ops_deploy_new_columns_have_defaults(db):
    d_id=await make_deploy(db)
    await db.commit()

    deploy=await db.get(Deploy, d_id)
    assert deploy.auto_recover is True
    assert deploy.health_state == 'unknown'
    assert deploy.last_health_at is None
    assert deploy.bad_commit_sha is None


@pytest.mark.asyncio
async def test_ops_all_tables_round_trip(db):
    d_id=await make_deploy(db)

    release=Deploy_Release(d_id=d_id, commit_sha="a" * 40, image_uri="x/y:abc1234", state='current')
    health=Health_Check(d_id=d_id, ok=False, status_code=503, latency_ms=120, detail="서비스 응답 없음", checked_at=datetime(2026, 11, 10, 1, 0, 0))
    incident=Incident(d_id=d_id, kind='unhealthy', status='open', summary="요약", explain="{}", evidence="증거", detected_at=datetime(2026, 11, 10, 1, 0, 0))
    db.add_all([release, health, incident])
    await db.flush()

    action=Recovery_Action(i_id=incident.i_id, action='rollback', d_r_id=release.d_r_id, result='running', started_at=datetime(2026, 11, 10, 1, 1, 0))
    note=Notification(u_id=None, d_id=d_id, i_id=incident.i_id, kind='incident_opened', channel='inapp', title="제목", body="본문", status='queued')
    device=Push_Device(expo_token="ExponentPushToken[abcdef123456]", platform='ios')
    setting=Notification_Setting(id=1)
    db.add_all([action, note, device, setting])
    await db.commit()

    assert release.d_r_id and release.healthy_since is None and release.created_at is not None
    assert health.h_c_id and (await db.get(Health_Check, health.h_c_id)).ok is False
    assert incident.i_id and incident.resolved_at is None and incident.created_at is not None
    assert action.r_a_id and action.finished_at is None and action.d_r_id == release.d_r_id
    assert note.n_id and note.read_at is None and note.created_at is not None
    assert device.p_d_id and device.last_seen_at is not None and device.created_at is not None

    loaded=await db.get(Notification_Setting, 1)
    assert loaded.notify_email is True and loaded.notify_push is True
    assert set(json.loads(loaded.kinds)) == {'incident_opened', 'incident_recovered', 'incident_needs_action',
                                             'deploy_succeeded', 'deploy_failed', 'new_commit'}


@pytest.mark.asyncio
async def test_ops_push_device_token_is_unique(db):
    from sqlalchemy.exc import IntegrityError

    db.add(Push_Device(expo_token="ExponentPushToken[same]", platform='android'))
    await db.commit()

    db.add(Push_Device(expo_token="ExponentPushToken[same]", platform='android'))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


@pytest.mark.asyncio
async def test_ops_incident_open_ids_picks_newest_open_or_recovering(db):
    first=await make_deploy(db)
    second=await make_deploy(db)
    third=await make_deploy(db)

    db.add_all([
        Incident(d_id=first, kind='unhealthy', status='resolved', detected_at=datetime(2026, 11, 10, 1, 0, 0)),
        Incident(d_id=first, kind='unhealthy', status='recovering', detected_at=datetime(2026, 11, 10, 2, 0, 0)),
        Incident(d_id=second, kind='unknown', status='needs_action', detected_at=datetime(2026, 11, 10, 2, 0, 0)),
    ])
    await db.commit()

    result=await Incident_Service.services_incident_open_ids(db, [first, second, third])

    assert result[first] is not None
    assert result[second] is None
    assert result[third] is None
    assert await Incident_Service.services_incident_open_ids(db, []) == {}


@pytest.mark.asyncio
async def test_ops_deploy_read_exposes_four_new_fields(client):
    created=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()

    for body in ((await client.get(f"/api/deploys/{created['d_id']}")).json(), (await client.get("/api/deploys")).json()[0], created):
        assert body["health_state"] == 'unknown'
        assert body["auto_recover"] is True
        assert body["last_health_at"] is None
        assert body["open_incident_id"] is None


@pytest.mark.asyncio
async def test_ops_deploy_read_shows_open_incident_id(client):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    async with AsyncSessionLocal() as db:
        incident=Incident(d_id=d_id, kind='unhealthy', status='open', detected_at=datetime(2026, 11, 10, 1, 0, 0))
        db.add(incident)
        await db.commit()
        i_id=incident.i_id

    assert (await client.get(f"/api/deploys/{d_id}")).json()["open_incident_id"] == i_id
    assert (await client.get("/api/deploys")).json()[0]["open_incident_id"] == i_id


def test_ops_settings_defaults():
    assert settings.health_monitor_enabled is True
    assert settings.health_interval_seconds == 60
    assert settings.health_failure_threshold == 3
    assert settings.health_timeout_seconds == 10
    assert settings.health_retention_days == 7
    assert settings.recovery_max_attempts_per_incident == 2
    assert settings.recovery_daily_limit == 6
    assert settings.recovery_wait_seconds == 120
    assert settings.recovery_verify_seconds == 300
    assert settings.new_release_window_seconds == 900
    assert settings.mail_port == 587
    assert settings.mail_host is None and settings.mail_to is None
    assert settings.expo_push_url == "https://exp.host/--/api/v2/push/send"
    assert settings.app_link_base == "deploywizard://"


@pytest.mark.asyncio
async def test_ops_health_recent_is_newest_first_and_capped(db):
    d_id=await make_deploy(db)
    for ok in (True, False, False):
        await Health_Crud.crud_health_create(db, d_id, ok, 200 if ok else 503, 30, None if ok else "오류")
    await db.commit()

    recent=await Health_Service.services_health_get_recent(db, d_id, 2)

    assert [c.ok for c in recent] == [False, False]
    assert recent[0].h_c_id > recent[1].h_c_id


@pytest.mark.asyncio
async def test_ops_notification_setting_get_creates_single_default_row(db):
    first=await Notification_Crud.crud_notification_setting_get(db)
    await db.commit()
    second=await Notification_Crud.crud_notification_setting_get(db)

    assert first.id == second.id == 1
    assert first.notify_email is True and first.notify_push is True

    note=await Notification_Crud.crud_notification_create(db, dict(kind='deploy_failed', channel='inapp', title="제목", body="본문"))
    assert note.n_id and note.status == 'queued'
