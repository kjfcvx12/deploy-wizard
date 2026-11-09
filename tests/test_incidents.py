import asyncio
import pytest
import pytest_asyncio
from datetime import datetime, timedelta

from sqlalchemy import select, func

from shared.database import Base, async_engine, AsyncSessionLocal
from shared.settings import settings

from features.deploys.models import Deploy, Deploy_Release
from features.health.crud import Health_Crud
from features.incidents.models import Incident, Recovery_Action
from features.incidents.scheme import Incident_Explain
from features.incidents.services import Incident_Service, INCIDENT_TASKS, SUMMARY_ERROR
from features.incidents.recovery import Recovery_Service
from features.notifications.services import Notification_Service
from features.express.scheme import Express_Status
from features.express.services import Express_Service

NOW=datetime(2026, 11, 10, 12, 0, 0)
TOKEN="ghp_abcdefghijklmnopqrstuvwxyz0123456789"


@pytest_asyncio.fixture
async def db():
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as session:
        yield session


@pytest.fixture
def notified(monkeypatch):
    sent=[]

    async def fake_send(db, incident, kind):
        sent.append((incident.i_id, kind))

    monkeypatch.setattr(Notification_Service, "services_notification_send_incident", staticmethod(fake_send))
    return sent


@pytest.fixture
def recovered(monkeypatch):
    started=[]

    async def fake_start(db, i_id):
        started.append(i_id)

    monkeypatch.setattr(Recovery_Service, "services_recovery_start", staticmethod(fake_start))
    return started


async def make_deploy(db, status='running', auto_recover=True, service_arn=None, aws_account_id=None) -> int:
    deploy=Deploy(repo_url="https://github.com/o/r", status=status, endpoint="https://abc.example.com", health_check_path='/health',
                  auto_recover=auto_recover, service_arn=service_arn, aws_account_id=aws_account_id)
    db.add(deploy)
    await db.commit()
    return deploy.d_id


# 헬스체크 한 건을 남기고 훅을 부른다 - 시각은 호출마다 1분씩 늘어난다
async def record(db, d_id, ok, detail=None, status_code=None, spawner=None, step=[0]):
    step[0]+=1
    await Health_Crud.crud_health_create(db, d_id, ok, status_code, 10, detail, checked_at=NOW + timedelta(minutes=step[0]))
    await db.commit()
    return await Incident_Service.services_incident_on_result(db, d_id, ok, now=NOW + timedelta(minutes=step[0]), spawner=spawner)


async def incident_count(db, d_id) -> int:
    return (await db.execute(select(func.count(Incident.i_id)).where(Incident.d_id == d_id))).scalar()


@pytest.mark.asyncio
async def test_incident_threshold_is_exactly_three_consecutive_failures(db):
    d_id=await make_deploy(db)
    spawned=[]
    spawner=spawned.append

    assert await record(db, d_id, False, "HTTP 503", spawner=spawner) is None
    assert await record(db, d_id, False, "HTTP 503", spawner=spawner) is None
    assert await record(db, d_id, True, spawner=spawner) is None
    assert await record(db, d_id, False, "HTTP 503", spawner=spawner) is None
    assert await record(db, d_id, False, "HTTP 503", spawner=spawner) is None
    assert await incident_count(db, d_id) == 0

    incident=await record(db, d_id, False, "HTTP 503", spawner=spawner)

    assert incident is not None
    assert (incident.status, incident.d_id) == ('open', d_id)
    assert settings.health_failure_threshold == 3
    assert spawned == [incident.i_id]


@pytest.mark.asyncio
async def test_incident_only_one_open_per_deploy_on_repeated_calls(db):
    d_id=await make_deploy(db)
    spawned=[]

    for _ in range(3):
        await record(db, d_id, False, "HTTP 500", spawner=spawned.append)
    for _ in range(4):
        assert await record(db, d_id, False, "HTTP 500", spawner=spawned.append) is None

    assert await incident_count(db, d_id) == 1
    assert len(spawned) == 1


@pytest.mark.asyncio
async def test_incident_only_one_open_under_concurrent_calls(db):
    d_id=await make_deploy(db)
    for minute in range(3):
        await Health_Crud.crud_health_create(db, d_id, False, 500, 10, "HTTP 500", checked_at=NOW + timedelta(minutes=minute))
    await db.commit()

    spawned=[]

    async def call():
        async with AsyncSessionLocal() as session:
            return await Incident_Service.services_incident_on_result(session, d_id, False, now=NOW, spawner=spawned.append)

    results=await asyncio.gather(call(), call(), call())

    assert len([r for r in results if r is not None]) == 1
    assert await incident_count(db, d_id) == 1
    assert len(spawned) == 1


@pytest.mark.asyncio
async def test_incident_needs_action_blocks_a_second_incident_while_still_failing(db):
    d_id=await make_deploy(db, auto_recover=False)

    for _ in range(3):
        incident=await record(db, d_id, False, "HTTP 500", spawner=lambda i_id: None)
    await Incident_Service.services_incident_needs_action(db, incident.i_id)

    for _ in range(3):
        assert await record(db, d_id, False, "HTTP 500", spawner=lambda i_id: None) is None

    assert await incident_count(db, d_id) == 1


@pytest.mark.asyncio
async def test_incident_not_opened_for_a_deploy_that_is_not_running(db):
    d_id=await make_deploy(db, status='stopped')

    for _ in range(4):
        assert await record(db, d_id, False, "HTTP 500", spawner=lambda i_id: None) is None

    assert await incident_count(db, d_id) == 0


@pytest.mark.asyncio
async def test_incident_on_result_does_no_aws_call(db, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("on_result 안에서 AWS 를 부르면 안 된다")

    monkeypatch.setattr(Express_Service, "services_express_describe", staticmethod(forbidden))
    d_id=await make_deploy(db, service_arn="arn:aws:ecs:ap-northeast-2:1:service/x")

    for _ in range(3):
        incident=await record(db, d_id, False, "HTTP 500", spawner=lambda i_id: None)

    assert incident is not None and incident.summary


@pytest.mark.asyncio
async def test_incident_default_spawn_runs_a_tracked_background_task(db, monkeypatch):
    calls=[]

    async def fake_process(i_id, session=None, describer=None):
        calls.append(i_id)

    monkeypatch.setattr(Incident_Service, "services_incident_process", staticmethod(fake_process))
    d_id=await make_deploy(db)

    for _ in range(3):
        incident=await record(db, d_id, False, "HTTP 500")

    assert len(INCIDENT_TASKS) == 1
    await Incident_Service.services_incident_tasks_wait()
    assert calls == [incident.i_id]
    assert len(INCIDENT_TASKS) == 0


@pytest.mark.asyncio
async def test_incident_tasks_cancel_stops_running_tasks(db, monkeypatch):
    async def slow_process(i_id, session=None, describer=None):
        await asyncio.sleep(30)

    monkeypatch.setattr(Incident_Service, "services_incident_process", staticmethod(slow_process))
    d_id=await make_deploy(db)

    for _ in range(3):
        await record(db, d_id, False, "HTTP 500")

    assert len(INCIDENT_TASKS) == 1
    await Incident_Service.services_incident_tasks_cancel()
    await asyncio.sleep(0)
    assert len(INCIDENT_TASKS) == 0


@pytest.mark.asyncio
async def test_incident_spawn_failure_leaves_needs_action_not_open(db):
    d_id=await make_deploy(db)

    def broken_spawner(i_id):
        raise RuntimeError(f"cannot start {TOKEN}")

    for _ in range(3):
        incident=await record(db, d_id, False, "HTTP 500", spawner=broken_spawner)

    await db.refresh(incident)
    assert incident.status == 'needs_action'
    assert TOKEN not in (incident.evidence or "")


@pytest.mark.asyncio
async def test_incident_kind_bad_release_inside_window_with_previous_release(db):
    d_id=await make_deploy(db)
    db.add(Deploy_Release(d_id=d_id, image_uri="img:1", state='previous', created_at=NOW - timedelta(days=1)))
    db.add(Deploy_Release(d_id=d_id, image_uri="img:2", state='current', created_at=NOW - timedelta(seconds=settings.new_release_window_seconds - 60)))
    await db.commit()

    assert await Incident_Service.services_incident_pick_kind(db, d_id, ["HTTP 500"], NOW) == 'bad_release'


@pytest.mark.asyncio
async def test_incident_kind_not_bad_release_without_previous_or_outside_window(db):
    no_previous=await make_deploy(db)
    db.add(Deploy_Release(d_id=no_previous, image_uri="img:2", state='current', created_at=NOW - timedelta(seconds=60)))

    old_release=await make_deploy(db)
    db.add(Deploy_Release(d_id=old_release, image_uri="img:1", state='previous', created_at=NOW - timedelta(days=2)))
    db.add(Deploy_Release(d_id=old_release, image_uri="img:2", state='current', created_at=NOW - timedelta(seconds=settings.new_release_window_seconds + 60)))
    await db.commit()

    assert await Incident_Service.services_incident_pick_kind(db, no_previous, ["HTTP 500"], NOW) == 'unhealthy'
    assert await Incident_Service.services_incident_pick_kind(db, old_release, ["HTTP 500"], NOW) == 'unhealthy'


@pytest.mark.asyncio
async def test_incident_kind_crash_loop_when_all_recent_failures_are_connection_refused(db):
    d_id=await make_deploy(db)

    assert await Incident_Service.services_incident_pick_kind(db, d_id, ["연결 실패", "연결 실패", "연결 실패"], NOW) == 'crash_loop'
    assert await Incident_Service.services_incident_pick_kind(db, d_id, ["연결 실패", "시간 초과", "연결 실패"], NOW) == 'unhealthy'
    assert await Incident_Service.services_incident_pick_kind(db, d_id, ["HTTP 503"], NOW) == 'unhealthy'


@pytest.mark.asyncio
async def test_incident_kind_is_saved_on_the_new_incident(db):
    d_id=await make_deploy(db)

    for _ in range(3):
        incident=await record(db, d_id, False, "연결 실패", spawner=lambda i_id: None)

    assert incident.kind == 'crash_loop'


EXPLAIN_CASES=[
    ("연결 실패", "앱이 요청을 받지 못하고 있습니다."),
    ("Connection refused", "앱이 요청을 받지 못하고 있습니다."),
    ("시간 초과", "앱이 시간 안에 응답하지 못합니다."),
    ("HTTP 503", "앱이 오류로 응답하고 있습니다."),
    ("HTTP 404", "헬스체크 경로에서 페이지를 찾지 못합니다."),
]


@pytest.mark.parametrize("detail,summary", EXPLAIN_CASES)
def test_incident_explain_rules_by_failure_detail(detail, summary):
    explain=Incident_Service.services_incident_explain('unhealthy', "최근 헬스체크:\n- 실패", [detail, detail, detail])

    assert explain.source == 'rule'
    assert explain.summary == summary
    assert explain.cause and explain.fix_where and explain.actions


def test_incident_explain_404_points_at_health_check_path():
    explain=Incident_Service.services_incident_explain('unhealthy', "", ["HTTP 404"])

    assert "health_check_path" in explain.fix_where


def test_incident_explain_connection_refused_points_at_port():
    explain=Incident_Service.services_incident_explain('crash_loop', "", ["연결 실패"])

    assert "포트" in explain.fix_where


def test_incident_explain_service_not_running_from_describe():
    for evidence in ("서비스 상태: INACTIVE (x)\n최근 헬스체크:", "서비스 상태: DRAINING (-)\n최근 헬스체크:", "서비스 상태: ACTIVE (-)\n배포 상태: ROLLBACK_SUCCESSFUL / 단계 - / 사유 x"):
        explain=Incident_Service.services_incident_explain('unhealthy', evidence, ["HTTP 404"])

        assert explain.source == 'rule'
        assert explain.summary in ("서비스가 실행 중이 아닙니다.", "최근 배포가 실패했거나 되돌려졌습니다.")


def test_incident_explain_unknown_gets_generic_guidance_with_source_none():
    explain=Incident_Service.services_incident_explain('unhealthy', "서비스 상태: ACTIVE (-)", ["이상한 오류"])

    assert explain.source == 'none'
    assert explain.fix_where and explain.actions


def test_incident_explain_bad_release_mentions_new_version():
    explain=Incident_Service.services_incident_explain('bad_release', "", ["HTTP 500"])

    assert "새 버전" in explain.cause


def test_incident_explain_uses_the_latest_failure_first():
    explain=Incident_Service.services_incident_explain('unhealthy', "", ["HTTP 404", "연결 실패"])

    assert explain.summary == "헬스체크 경로에서 페이지를 찾지 못합니다."


def test_incident_explain_never_repeats_a_token():
    explain=Incident_Service.services_incident_explain('unhealthy', f"로그 {TOKEN}", [f"HTTP 500 {TOKEN}"])

    assert TOKEN not in explain.model_dump_json()


@pytest.mark.asyncio
async def test_incident_evidence_is_masked_and_capped(db):
    d_id=await make_deploy(db)
    await Health_Crud.crud_health_create(db, d_id, False, 500, 10, f"HTTP 500 {TOKEN}", checked_at=NOW)
    await db.commit()

    evidence=await Incident_Service.services_incident_collect_evidence(db, d_id)

    assert TOKEN not in evidence
    assert "최근 헬스체크" in evidence
    assert len(evidence) <= 4000


@pytest.mark.asyncio
async def test_incident_evidence_keeps_only_last_five_health_lines(db):
    d_id=await make_deploy(db)
    for minute in range(8):
        await Health_Crud.crud_health_create(db, d_id, False, 500, 10, f"HTTP 50{minute}", checked_at=NOW + timedelta(minutes=minute))
    await db.commit()

    evidence=await Incident_Service.services_incident_collect_evidence(db, d_id)

    assert len([line for line in evidence.splitlines() if line.startswith("- ")]) == 5
    assert "HTTP 507" in evidence and "HTTP 502" not in evidence


@pytest.mark.asyncio
async def test_incident_evidence_uses_injected_describe_and_masks_it(db):
    d_id=await make_deploy(db, service_arn="arn:aws:ecs:ap-northeast-2:1:service/x")
    await Health_Crud.crud_health_create(db, d_id, False, 500, 10, "HTTP 500", checked_at=NOW)
    await db.commit()
    seen=[]

    def describer(session, arn):
        seen.append((session, arn))
        return Express_Status(service_arn=arn, status_code="ACTIVE", status_reason=f"token={TOKEN}", deployment_status="IN_PROGRESS")

    session=object()
    evidence=await Incident_Service.services_incident_collect_evidence(db, d_id, session, describer)

    assert seen == [(session, "arn:aws:ecs:ap-northeast-2:1:service/x")]
    assert "서비스 상태: ACTIVE" in evidence and "IN_PROGRESS" in evidence
    assert TOKEN not in evidence


@pytest.mark.asyncio
async def test_incident_evidence_tolerates_describe_failure(db):
    d_id=await make_deploy(db, service_arn="arn:aws:ecs:ap-northeast-2:1:service/x")

    def describer(session, arn):
        raise RuntimeError("AccessDenied")

    evidence=await Incident_Service.services_incident_collect_evidence(db, d_id, object(), describer)

    assert "확인하지 못함" in evidence and "RuntimeError" in evidence


@pytest.mark.asyncio
async def test_incident_evidence_skips_describe_without_service_or_account(db):
    def describer(session, arn):
        raise AssertionError("조회하면 안 된다")

    no_arn=await make_deploy(db)
    no_account=await make_deploy(db, service_arn="arn:aws:ecs:ap-northeast-2:1:service/x")

    assert "서비스 상태" not in await Incident_Service.services_incident_collect_evidence(db, no_arn, None, describer)
    assert "서비스 상태" not in await Incident_Service.services_incident_collect_evidence(db, no_account, None, describer)


async def open_incident_via_hook(db, d_id, detail="HTTP 500"):
    process=[]

    async def spawner(i_id):
        process.append(i_id)

    created=None
    for _ in range(3):
        created=await record(db, d_id, False, detail, spawner=spawner) or created
    return created


@pytest.mark.asyncio
async def test_incident_process_saves_explain_notifies_and_starts_recovery(db, notified, recovered):
    d_id=await make_deploy(db, auto_recover=True)
    incident=await open_incident_via_hook(db, d_id, f"HTTP 500 {TOKEN}")

    await Incident_Service.services_incident_process(incident.i_id)

    await db.refresh(incident)
    explain=Incident_Explain.model_validate_json(incident.explain)
    assert explain.source == 'rule' and explain.summary == incident.summary
    assert TOKEN not in incident.explain and TOKEN not in incident.evidence and TOKEN not in incident.summary
    assert incident.status == 'open'
    assert notified == [(incident.i_id, 'incident_opened')]
    assert recovered == [incident.i_id]


@pytest.mark.asyncio
async def test_incident_process_auto_recover_off_sets_needs_action_without_recovery(db, notified, recovered):
    d_id=await make_deploy(db, auto_recover=False)
    incident=await open_incident_via_hook(db, d_id)

    await Incident_Service.services_incident_process(incident.i_id)

    await db.refresh(incident)
    assert incident.status == 'needs_action'
    assert recovered == []
    assert notified == [(incident.i_id, 'incident_opened'), (incident.i_id, 'incident_needs_action')]


@pytest.mark.asyncio
async def test_incident_process_uses_describe_through_injected_session(db, notified, recovered):
    d_id=await make_deploy(db, service_arn="arn:aws:ecs:ap-northeast-2:1:service/x")
    incident=await open_incident_via_hook(db, d_id, "HTTP 404")

    def describer(session, arn):
        return Express_Status(service_arn=arn, status_code="INACTIVE")

    await Incident_Service.services_incident_process(incident.i_id, session=object(), describer=describer)

    await db.refresh(incident)
    assert "서비스 상태: INACTIVE" in incident.evidence
    assert Incident_Explain.model_validate_json(incident.explain).summary == "서비스가 실행 중이 아닙니다."


@pytest.mark.asyncio
async def test_incident_process_error_marks_needs_action_with_masked_detail(db, notified, recovered, monkeypatch):
    def boom(kind, evidence, last_details):
        raise RuntimeError(f"explain failed token={TOKEN}")

    monkeypatch.setattr(Incident_Service, "services_incident_explain", staticmethod(boom))
    d_id=await make_deploy(db)
    incident=await open_incident_via_hook(db, d_id)

    await Incident_Service.services_incident_process(incident.i_id)

    await db.refresh(incident)
    assert incident.status == 'needs_action'
    assert incident.summary == SUMMARY_ERROR
    assert "RuntimeError" in incident.evidence and TOKEN not in incident.evidence
    assert recovered == []
    assert (incident.i_id, 'incident_needs_action') in notified


@pytest.mark.asyncio
async def test_incident_process_recovery_start_error_does_not_leave_it_open(db, notified, monkeypatch):
    async def boom(db, i_id):
        raise RuntimeError("recovery exploded")

    monkeypatch.setattr(Recovery_Service, "services_recovery_start", staticmethod(boom))
    d_id=await make_deploy(db, auto_recover=True)
    incident=await open_incident_via_hook(db, d_id)

    await Incident_Service.services_incident_process(incident.i_id)

    await db.refresh(incident)
    assert incident.status == 'needs_action'


@pytest.mark.asyncio
async def test_incident_process_notification_failure_does_not_stop_recovery(db, recovered, monkeypatch):
    async def broken(db, incident, kind):
        raise RuntimeError("smtp down")

    monkeypatch.setattr(Notification_Service, "services_notification_send_incident", staticmethod(broken))
    d_id=await make_deploy(db, auto_recover=True)
    incident=await open_incident_via_hook(db, d_id)

    await Incident_Service.services_incident_process(incident.i_id)

    assert recovered == [incident.i_id]


@pytest.mark.asyncio
async def test_incident_process_skips_an_already_resolved_incident(db, notified, recovered):
    d_id=await make_deploy(db)
    incident=await open_incident_via_hook(db, d_id)
    await record(db, d_id, True)

    await Incident_Service.services_incident_process(incident.i_id)

    assert notified == [] and recovered == []


@pytest.mark.asyncio
async def test_incident_healthy_again_resolves_open_and_needs_action(db, notified):
    d_id=await make_deploy(db, auto_recover=False)
    incident=await open_incident_via_hook(db, d_id)

    resolved=await record(db, d_id, True)

    await db.refresh(incident)
    assert resolved.i_id == incident.i_id
    assert incident.status == 'resolved' and incident.resolved_at is not None
    assert notified == []

    other=await make_deploy(db, auto_recover=False)
    second=await open_incident_via_hook(db, other)
    await Incident_Service.services_incident_needs_action(db, second.i_id)
    notified.clear()

    await record(db, other, True)

    await db.refresh(second)
    assert second.status == 'resolved'
    assert notified == []


@pytest.mark.asyncio
async def test_incident_resolve_notifies_recovered_only_when_recovery_was_tried(db, notified):
    d_id=await make_deploy(db)
    incident=await open_incident_via_hook(db, d_id)
    await Incident_Service.services_incident_needs_action(db, incident.i_id)
    db.add(Recovery_Action(i_id=incident.i_id, action='restart', result='failed'))
    await db.commit()
    notified.clear()

    await record(db, d_id, True)
    # 모니터 경로의 해제 알림은 백그라운드 태스크로 나간다
    await Incident_Service.services_incident_tasks_wait()

    assert notified == [(incident.i_id, 'incident_recovered')]


@pytest.mark.asyncio
async def test_incident_monitor_does_not_close_a_recovering_incident(db, notified):
    d_id=await make_deploy(db)
    incident=await open_incident_via_hook(db, d_id)
    incident.status='recovering'
    await db.commit()

    assert await record(db, d_id, True) is None

    await db.refresh(incident)
    assert incident.status == 'recovering'
    assert notified == []


@pytest.mark.asyncio
async def test_incident_new_incident_after_the_old_one_resolved(db):
    d_id=await make_deploy(db)
    first=await open_incident_via_hook(db, d_id)
    await record(db, d_id, True)

    second=await open_incident_via_hook(db, d_id)

    assert second.i_id != first.i_id
    assert await incident_count(db, d_id) == 2
