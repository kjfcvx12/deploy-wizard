import pytest

from shared.settings import settings
from shared.database import AsyncSessionLocal

from features.deploys.services import Deploy_Service
from features.incidents.recovery import Recovery_Service
from features.incidents.services import Incident_Service

from recovery_helpers import (db, notified, aws_session, Fakes, make_deploy, make_incident, fresh_incident, fresh_deploy,
                              actions_of, action_rows, release_states, CUR_SHA, PREV_SHA, CUR_IMAGE, PREV_IMAGE, TOKEN)

pytestmark=pytest.mark.usefixtures("aws_session")


# 재시작 - 같은 이미지로 갱신하고, 대기 뒤 정상이 이어지면 resolved
@pytest.mark.asyncio
async def test_recovery_restart_success(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id)
    fakes=Fakes(healthy_images=(CUR_IMAGE,))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert fakes.updates == [("FAKE_SESSION", "arn:aws:ecs:x:1:service/s", CUR_IMAGE, 8000, "/health", None)]
    assert fakes.sleeps[0] == settings.recovery_wait_seconds
    assert fakes.checked[0] == "https://abc.example.com/health"
    assert (await fresh_incident(i_id)).status == 'resolved'
    assert (await fresh_incident(i_id)).resolved_at is not None
    assert await actions_of(i_id) == [('restart', 'ok')]
    assert notified == [(i_id, 'incident_recovered')]
    assert (await fresh_deploy(d_id)).image_uri == CUR_IMAGE
    assert (await fresh_deploy(d_id)).bad_commit_sha is None


# 재시작이 안 통하면 이전 정상 버전으로 되돌리고, 나쁜 커밋을 기억한다
@pytest.mark.asyncio
async def test_recovery_restart_fails_then_rollback_succeeds(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id)
    fakes=Fakes(healthy_images=(PREV_IMAGE,))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert [update[2] for update in fakes.updates] == [CUR_IMAGE, PREV_IMAGE]
    assert await actions_of(i_id) == [('restart', 'failed'), ('rollback', 'ok')]
    assert (await fresh_incident(i_id)).status == 'resolved'
    assert notified == [(i_id, 'incident_recovered')]

    deploy=await fresh_deploy(d_id)
    assert (deploy.image_uri, deploy.commit_sha, deploy.bad_commit_sha) == (PREV_IMAGE, PREV_SHA, CUR_SHA)
    assert deploy.status == 'running'
    assert await release_states(d_id) == [('a', 'current'), ('c', 'failed')]

    rollback=(await action_rows(i_id))[1]
    assert rollback.d_r_id is not None


# 새 버전 직후 문제(bad_release)는 재시작 없이 바로 되돌린다
@pytest.mark.asyncio
async def test_recovery_bad_release_goes_straight_to_rollback(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='bad_release')
    fakes=Fakes(healthy_images=(PREV_IMAGE,))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert [update[2] for update in fakes.updates] == [PREV_IMAGE]
    assert await actions_of(i_id) == [('rollback', 'ok')]
    assert (await fresh_incident(i_id)).status == 'resolved'


# 되돌릴 정상 버전이 없는 bad_release - AWS 를 부르지 않고 needs_action
@pytest.mark.asyncio
@pytest.mark.parametrize("kwargs", [
    dict(with_previous=False),
    dict(previous_healthy=False),
    dict(previous_image=""),
], ids=["no-previous", "never-healthy", "empty-image"])
async def test_recovery_bad_release_without_target_needs_action(db, notified, kwargs):
    d_id=await make_deploy(db, **kwargs)
    i_id=await make_incident(db, d_id, kind='bad_release')
    fakes=Fakes(healthy_images=(PREV_IMAGE, CUR_IMAGE))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert fakes.updates == []
    assert await actions_of(i_id) == []
    assert (await fresh_incident(i_id)).status == 'needs_action'
    assert notified == [(i_id, 'incident_needs_action')]


# 되돌릴 곳이 없는 일반 문제 - 재시작만 해 보고 안 되면 needs_action (되돌리기 시도는 없다)
@pytest.mark.asyncio
async def test_recovery_restart_fails_without_target_needs_action(db, notified):
    d_id=await make_deploy(db, previous_healthy=False)
    i_id=await make_incident(db, d_id)
    fakes=Fakes(healthy_images=())

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert [update[2] for update in fakes.updates] == [CUR_IMAGE]
    assert await actions_of(i_id) == [('restart', 'failed')]
    assert (await fresh_incident(i_id)).status == 'needs_action'
    assert notified == [(i_id, 'incident_needs_action')]


# 재시작도 되돌리기도 안 되면 needs_action - 시도는 2번까지
@pytest.mark.asyncio
async def test_recovery_both_fail_needs_action(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id)
    fakes=Fakes(healthy_images=())

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert len(fakes.updates) == 2
    assert await actions_of(i_id) == [('restart', 'failed'), ('rollback', 'failed')]
    assert (await fresh_incident(i_id)).status == 'needs_action'
    assert notified == [(i_id, 'incident_needs_action')]
    # 되돌리기가 실패했으니 배포 기록은 그대로다
    assert (await fresh_deploy(d_id)).image_uri == CUR_IMAGE
    assert (await fresh_deploy(d_id)).bad_commit_sha is None


# 정상 판정 - 연속 3번 정상이어야 한다 (사이에 실패가 끼면 처음부터 센다)
@pytest.mark.asyncio
async def test_recovery_verify_needs_three_consecutive_ok(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id)
    fakes=Fakes(ok_sequence=[True, False, True, True, True])

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert (await fresh_incident(i_id)).status == 'resolved'
    assert len(fakes.checked) == 5
    assert fakes.sleeps == [settings.recovery_wait_seconds, 15, 15, 15, 15]


# 정상이 이어지지 않으면 검증 시간(300초)이 끝날 때까지 15초마다 확인하고 실패로 본다
@pytest.mark.asyncio
async def test_recovery_verify_window_is_bounded(db, notified):
    d_id=await make_deploy(db, previous_healthy=False)
    i_id=await make_incident(db, d_id)
    fakes=Fakes(ok_sequence=[True, True])

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert len(fakes.checked) == settings.recovery_verify_seconds // 15 + 1
    assert (await fresh_incident(i_id)).status == 'needs_action'


# AWS 오류 문구는 마스킹해서 detail 에 남는다
@pytest.mark.asyncio
async def test_recovery_aws_error_is_masked(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='bad_release')
    fakes=Fakes(fail_update=RuntimeError(f"AccessDenied token={TOKEN}"))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    rows=await action_rows(i_id)
    assert [(row.action, row.result) for row in rows] == [('rollback', 'failed')]
    assert "AccessDenied" in rows[0].detail
    assert TOKEN not in rows[0].detail
    incident=await fresh_incident(i_id)
    assert incident.status == 'needs_action'
    assert TOKEN not in (incident.evidence or "")
    # 갱신이 실패하면 기다리지도 검증하지도 않는다
    assert fakes.sleeps == []
    assert fakes.checked == []


# 예상 못 한 오류 - recovering 에 멈추지 않고 needs_action
@pytest.mark.asyncio
async def test_recovery_unexpected_error_ends_in_needs_action(db, notified, monkeypatch):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id)

    async def boom(db, d_id):
        raise RuntimeError(f"예상 못 한 오류 {TOKEN}")

    # 재시작이 안 통해 되돌리기 대상을 찾는 단계에서 터진다
    monkeypatch.setattr(Deploy_Service, "services_deploy_release_rollback_target", staticmethod(boom))
    fakes=Fakes(healthy_images=())

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    incident=await fresh_incident(i_id)
    assert incident.status == 'needs_action'
    assert TOKEN not in (incident.evidence or "")
    assert notified == [(i_id, 'incident_needs_action')]


# 되돌리기 대상 - 정상 확인된 적 있고 이미지 주소가 있는 직전 버전만
@pytest.mark.asyncio
@pytest.mark.parametrize("kwargs, found", [
    (dict(), True),
    (dict(previous_healthy=False), False),
    (dict(previous_image=""), False),
    (dict(with_previous=False), False),
], ids=["healthy", "never-healthy", "empty-image", "none"])
async def test_deploy_release_rollback_target(db, kwargs, found):
    d_id=await make_deploy(db, **kwargs)

    target=await Deploy_Service.services_deploy_release_rollback_target(db, d_id)

    assert (target is not None) is found


# 서버를 다시 켤 때 - recovering 은 needs_action, 멈춘 시도는 실패로 정리
@pytest.mark.asyncio
async def test_recovery_resume_turns_recovering_into_needs_action(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, status='recovering')
    from recovery_helpers import add_action
    await add_action(db, i_id, 'restart', 'running')

    await Recovery_Service.services_recovery_resume(db)

    incident=await fresh_incident(i_id)
    assert incident.status == 'needs_action'
    assert "서버가 다시 시작되어 자동 복구가 중단되었습니다" in incident.evidence
    rows=await action_rows(i_id)
    assert [(row.action, row.result) for row in rows] == [('restart', 'failed')]
    assert rows[0].detail == "서버가 다시 시작되어 자동 복구가 중단되었습니다"
    assert rows[0].finished_at is not None
    assert notified == [(i_id, 'incident_needs_action')]


# 처리가 끊긴 open - 배포가 running 이고 자동 복구가 켜져 있으면 처리를 다시 띄우고, 아니면 needs_action
@pytest.mark.asyncio
@pytest.mark.parametrize("deploy_kwargs, respawn", [
    (dict(), True),
    (dict(auto_recover=False), False),
    (dict(status='stopped'), False),
], ids=["respawn", "auto-recover-off", "not-running"])
async def test_recovery_resume_open_incident(db, notified, monkeypatch, deploy_kwargs, respawn):
    d_id=await make_deploy(db, **deploy_kwargs)
    i_id=await make_incident(db, d_id, status='open')
    spawned=[]
    monkeypatch.setattr(Incident_Service, "services_incident_spawn", staticmethod(spawned.append))

    await Recovery_Service.services_recovery_resume(db)

    if respawn:
        assert spawned == [i_id]
        assert (await fresh_incident(i_id)).status == 'open'
        assert notified == []
    else:
        assert spawned == []
        assert (await fresh_incident(i_id)).status == 'needs_action'
        assert notified == [(i_id, 'incident_needs_action')]


# 이미 끝난 인시던트는 건드리지 않는다
@pytest.mark.asyncio
async def test_recovery_resume_ignores_finished(db, notified, monkeypatch):
    d_id=await make_deploy(db)
    done=await make_incident(db, d_id, status='resolved')
    needs=await make_incident(db, d_id, status='needs_action')
    spawned=[]
    monkeypatch.setattr(Incident_Service, "services_incident_spawn", staticmethod(spawned.append))

    await Recovery_Service.services_recovery_resume(db)

    assert (await fresh_incident(done)).status == 'resolved'
    assert (await fresh_incident(needs)).status == 'needs_action'
    assert spawned == [] and notified == []


# 감시 루프는 복구를 직접 돌리지 않는다 - 처리는 띄운 태스크(spawner)로만 넘어간다
@pytest.mark.asyncio
async def test_monitor_hook_does_not_run_recovery_inline(db, monkeypatch):
    from datetime import datetime, timedelta
    from features.health.crud import Health_Crud

    d_id=await make_deploy(db)
    for minute in range(3):
        await Health_Crud.crud_health_create(db, d_id, False, 503, 5, "HTTP 503", checked_at=datetime(2026, 11, 10) + timedelta(minutes=minute))
    await db.commit()

    started=[]

    async def fake_start(*args, **kwargs):
        started.append(args)

    monkeypatch.setattr(Recovery_Service, "services_recovery_start", staticmethod(fake_start))
    spawned=[]

    incident=await Incident_Service.services_incident_on_result(db, d_id, False, spawner=spawned.append)

    assert spawned == [incident.i_id]
    assert started == []
