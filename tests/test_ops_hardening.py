import asyncio
import os
import threading
import pytest
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import update

from shared.database import AsyncSessionLocal
from shared.keyed_lock import keyed_lock
from shared.settings import settings

from features.deploys.models import Deploy
from features.deploys.pipeline import Deploy_Pipeline, Deploy_Log_Buffer
from features.deploys.services import Deploy_Service
from features.health.crud import Health_Crud
from features.health.services import Health_Service
from features.incidents import services as incident_services_module
from features.incidents.recovery import Recovery_Service, RECOVERY_LOCKS
from features.incidents.services import Incident_Service, INCIDENT_LOCKS
from features.express.scheme import Express_Status

from recovery_helpers import (db, notified, aws_session, Fakes, make_deploy, make_incident, fresh_incident, CUR_IMAGE, TOKEN)

NOW=datetime(2026, 11, 10, 12, 0, 0)


# (5) 서비스 조회가 끝나지 않아도 원인 수집은 멈추지 않는다
@pytest.mark.asyncio
async def test_evidence_describe_timeout_is_recorded_and_continues(db, monkeypatch):
    d_id=await make_deploy(db)
    await Health_Crud.crud_health_create(db, d_id, False, 500, 10, "HTTP 500", checked_at=NOW)
    await db.commit()
    monkeypatch.setattr(incident_services_module, "DESCRIBE_TIMEOUT_SECONDS", 0.2)
    release=threading.Event()

    def hanging(session, arn):
        release.wait(5)
        return Express_Status(service_arn=arn, status_code="ACTIVE")

    try:
        evidence=await Incident_Service.services_incident_collect_evidence(db, d_id, object(), hanging)
    finally:
        release.set()

    assert "서비스 상태를 확인하지 못했습니다 (시간 초과)" in evidence
    assert "최근 헬스체크" in evidence and "HTTP 500" in evidence


# (6) 잠금은 쓰고 나면 사라진다 - 인시던트 열기·자동 복구 모두
@pytest.mark.asyncio
async def test_locks_are_dropped_after_use(db, notified):
    d_id=await make_deploy(db)
    for _ in range(3):
        await Health_Crud.crud_health_create(db, d_id, False, 503, 5, "HTTP 503", checked_at=NOW)
    await db.commit()

    spawned=[]
    results=await asyncio.gather(*[Incident_Service.services_incident_on_result(db, d_id, False, spawner=spawned.append) for _ in range(1)])
    assert results[0] is not None and INCIDENT_LOCKS == {}

    fakes=Fakes(healthy_images=(CUR_IMAGE,))
    await Recovery_Service.services_recovery_start(db, results[0].i_id, **fakes.kwargs())
    assert RECOVERY_LOCKS == {}


# 기다리는 쪽이 있어도 잠금은 하나로 유지되고 다 끝난 뒤에야 지워진다
@pytest.mark.asyncio
async def test_keyed_lock_excludes_and_cleans_up():
    locks={}
    inside=[]
    overlap=[]

    async def worker(key):
        async with keyed_lock(locks, key):
            inside.append(key)
            if inside.count(key) > 1:
                overlap.append(key)
            await asyncio.sleep(0.01)
            inside.remove(key)

    await asyncio.gather(*[worker("a") for _ in range(5)], *[worker("b") for _ in range(2)])

    assert overlap == [] and locks == {}


# (7) health_check_path 가 호스트를 바꾸면 부르지 않고 실패로 기록한다
@pytest.mark.asyncio
async def test_monitor_rejects_url_with_a_different_host(db):
    bad=await make_deploy(db, endpoint="https://abc.example.com")
    good=await make_deploy(db, endpoint="https://good.example.com")
    await db.execute(update(Deploy).where(Deploy.d_id == bad).values(health_check_path="@evil.tld/"))
    await db.commit()
    calls=[]

    async def checker(url):
        calls.append(url)
        return True, 200, 5, None

    checked=await Health_Service.services_health_check_once(db, now=NOW, checker=checker)

    assert sorted(checked) == sorted([bad, good])
    assert calls == ["https://good.example.com/health"]
    row=(await Health_Crud.crud_health_get_recent(db, bad, 1))[0]
    assert (row.ok, row.status_code, row.detail) == (False, None, "주소가 올바르지 않습니다")


def test_health_safe_url_accepts_normal_paths_only():
    assert Health_Service.services_health_safe_url("https://abc.example.com/", "/health") == "https://abc.example.com/health"
    assert Health_Service.services_health_safe_url("https://abc.example.com", None) == "https://abc.example.com/"
    assert Health_Service.services_health_safe_url("https://abc.example.com", "@evil.tld/") is None
    assert Health_Service.services_health_safe_url("https://abc.example.com", ".evil.tld/") is None


# 자동 복구 검증도 같은 규칙 - 이상한 주소는 부르지 않고 실패한다
@pytest.mark.asyncio
async def test_recovery_verify_does_not_fetch_a_different_host(db):
    d_id=await make_deploy(db)
    await db.execute(update(Deploy).where(Deploy.d_id == d_id).values(health_check_path="@evil.tld/"))
    await db.commit()
    fakes=Fakes(ok_sequence=[True] * 10)

    assert await Recovery_Service.services_recovery_verify(db, d_id, fakes.sleeper, fakes.checker) is False
    assert fakes.checked == []


# (8) 새 버전을 배포하면 확인을 기다리던 인시던트는 닫히고, 새 버전이 또 망가지면 새 bad_release 가 열린다
@pytest.mark.asyncio
async def test_new_release_closes_needs_action_incidents_only(db, notified):
    d_id=await make_deploy(db)
    waiting=await make_incident(db, d_id, kind='unhealthy', status='needs_action')
    active=await make_incident(db, d_id, kind='unhealthy', status='open')
    recovering=await make_incident(db, d_id, kind='unhealthy', status='recovering')
    other=await make_deploy(db)
    other_waiting=await make_incident(db, other, kind='unhealthy', status='needs_action')

    async with AsyncSessionLocal() as session:
        await session.execute(update(Deploy).where(Deploy.d_id == d_id).values(commit_sha="e" * 40, image_uri=CUR_IMAGE + "2"))
        await session.commit()
    async with AsyncSessionLocal() as session:
        release=await Deploy_Service.services_deploy_release_record(session, d_id)

    assert release.state == 'current'
    closed=await fresh_incident(waiting)
    assert closed.status == 'resolved' and closed.resolved_at is not None
    assert closed.summary == "문제 (새 버전 배포로 종료)"
    assert (await fresh_incident(active)).status == 'open'
    assert (await fresh_incident(recovering)).status == 'recovering'
    assert (await fresh_incident(other_waiting)).status == 'needs_action'
    assert notified == []

    # 같은 버전이 다시 running 이 되는 것은 새 버전이 아니니 닫지 않는다
    again=await make_incident(db, d_id, kind='unhealthy', status='needs_action')
    async with AsyncSessionLocal() as session:
        await Deploy_Service.services_deploy_release_record(session, d_id)
    assert (await fresh_incident(again)).status == 'needs_action'


@pytest.mark.asyncio
async def test_broken_new_release_can_open_a_fresh_bad_release_incident(db, notified):
    d_id=await make_deploy(db)
    stale=await make_incident(db, d_id, kind='unhealthy', status='needs_action')

    async with AsyncSessionLocal() as session:
        await session.execute(update(Deploy).where(Deploy.d_id == d_id).values(commit_sha="e" * 40, image_uri=CUR_IMAGE + "2"))
        await session.commit()
    async with AsyncSessionLocal() as session:
        await Deploy_Service.services_deploy_release_record(session, d_id)

    assert (await fresh_incident(stale)).status == 'resolved'

    spawned=[]
    created=None
    for minute in range(3):
        await Health_Crud.crud_health_create(db, d_id, False, 503, 5, "HTTP 503", checked_at=NOW + timedelta(minutes=minute))
        await db.commit()
        created=await Incident_Service.services_incident_on_result(db, d_id, False, spawner=spawned.append) or created

    assert created is not None and created.kind == 'bad_release' and created.i_id != stale
    assert spawned == [created.i_id]


# (10) 릴리스 기록을 건너뛸 때 이유를 남긴다 (마스킹)
@pytest.mark.asyncio
async def test_pipeline_release_record_warn_includes_masked_reason(db, monkeypatch):
    async def boom(db, d_id):
        raise HTTPException(status_code=500, detail=f"릴리스 기록 실패 :disk full token={TOKEN}")

    monkeypatch.setattr(Deploy_Service, "services_deploy_release_record", staticmethod(boom))
    buffer=Deploy_Log_Buffer(1)

    await Deploy_Pipeline.pipeline_release_record(1, buffer)

    message=buffer.lines[0]["message"]
    assert buffer.lines[0]["level"] == 'warn'
    assert "HTTPException" in message and "disk full" in message
    assert TOKEN not in message


# (9) 시험 DB 는 프로세스마다 따로다 - 동시에 돌린 pytest 끼리 표를 지우지 않는다
def test_test_database_file_is_per_process():
    assert f"test-{os.getpid()}.db" in settings.db_url
