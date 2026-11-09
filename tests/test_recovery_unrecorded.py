import pytest
from botocore.exceptions import ClientError

from features.incidents.crud import Incident_Crud
from features.incidents.recovery import Recovery_Service, BOOKKEEPING_DETAIL, UNRECORDED_DETAIL, RESUME_DETAIL
from features.accounts.services import Aws_Account_Service

from recovery_helpers import (db, notified, aws_session, Fakes, make_deploy, make_incident, add_action, fresh_incident, fresh_deploy,
                              action_rows, CUR_IMAGE, PREV_IMAGE)

pytestmark=pytest.mark.usefixtures("aws_session")


# 되돌리기가 AWS 에는 갔는데 배포 기록은 그대로인 상태 - 이후 자동 복구는 어떤 AWS 호출도 하면 안 된다
async def assert_later_recovery_is_blocked(db, d_id, kind):
    later=await make_incident(db, d_id, kind=kind)
    again=Fakes(healthy_images=(CUR_IMAGE, PREV_IMAGE))

    await Recovery_Service.services_recovery_start(db, later, **again.kwargs())

    assert again.updates == [] and again.waits == [] and again.checked == []
    assert (await fresh_incident(later)).status == 'needs_action'


# (a) 되돌리기 갱신 뒤 검증이 실패하면 기록에 표식이 남고 이후 재시작도 막힌다
@pytest.mark.asyncio
@pytest.mark.parametrize("later_kind", ['unhealthy', 'bad_release'])
async def test_rollback_verify_failure_blocks_later_automatic_actions(db, notified, later_kind):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='bad_release')
    fakes=Fakes(ok_sequence=[])

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert len(fakes.updates) == 1 and fakes.updates[0][2] == PREV_IMAGE
    rows=await action_rows(i_id)
    assert [(row.action, row.result) for row in rows] == [('rollback', 'failed')]
    assert rows[0].detail.startswith((BOOKKEEPING_DETAIL, UNRECORDED_DETAIL))
    # 기록은 그대로 - 나쁜 이미지가 남아 있다
    assert (await fresh_deploy(d_id)).image_uri == CUR_IMAGE

    await assert_later_recovery_is_blocked(db, d_id, later_kind)


# (b) 갱신 완료 대기가 시간 초과로 예외를 내도 마찬가지다
@pytest.mark.asyncio
async def test_rollback_wait_timeout_blocks_later_automatic_actions(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='bad_release')
    fakes=Fakes(healthy_images=(PREV_IMAGE,))
    kwargs=fakes.kwargs()

    def timing_out_waiter(session, service_arn, on_progress=None):
        raise TimeoutError("배포 대기 시간 초과")

    kwargs["waiter"]=timing_out_waiter

    await Recovery_Service.services_recovery_start(db, i_id, **kwargs)

    assert len(fakes.updates) == 1
    rows=await action_rows(i_id)
    assert [(row.action, row.result) for row in rows] == [('rollback', 'failed')]
    assert rows[0].detail.startswith((BOOKKEEPING_DETAIL, UNRECORDED_DETAIL))
    assert "TimeoutError" in rows[0].detail

    await assert_later_recovery_is_blocked(db, d_id, 'unhealthy')


# 갱신 호출이 거절이 아닌 예외(읽기 시간 초과 등)로 끝나면 AWS 가 받았는지 알 수 없다 - 표식을 남기고 이후 자동 복구를 막는다
@pytest.mark.asyncio
async def test_rollback_update_ambiguous_failure_blocks_later_automatic_actions(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='bad_release')
    fakes=Fakes(fail_update=TimeoutError("Read timeout on endpoint URL"))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert len(fakes.updates) == 1
    rows=await action_rows(i_id)
    assert [(row.action, row.result) for row in rows] == [('rollback', 'failed')]
    assert rows[0].detail.startswith(UNRECORDED_DETAIL) and "TimeoutError" in rows[0].detail

    await assert_later_recovery_is_blocked(db, d_id, 'unhealthy')


# AWS 가 거절 응답(ClientError)을 준 경우는 아무것도 적용되지 않았으니 표식을 남기지 않는다
@pytest.mark.asyncio
async def test_rollback_update_client_error_does_not_block(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='bad_release')
    rejection=ClientError({"Error": {"Code": "AccessDeniedException", "Message": "denied"}}, "UpdateExpressGatewayService")
    fakes=Fakes(fail_update=rejection)

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    rows=await action_rows(i_id)
    assert [(row.action, row.result) for row in rows] == [('rollback', 'failed')]
    assert not rows[0].detail.startswith((BOOKKEEPING_DETAIL, UNRECORDED_DETAIL))

    later=await make_incident(db, d_id, kind='unhealthy')
    again=Fakes(healthy_images=(CUR_IMAGE,))
    await Recovery_Service.services_recovery_start(db, later, **again.kwargs())

    assert len(again.updates) == 1


# 되돌리기 갱신이 나간 뒤 시도를 끝내는 기록(finish/commit)이 실패해도 표식은 남는다
@pytest.mark.asyncio
async def test_rollback_finish_failure_still_marks_the_action(db, notified, monkeypatch):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='bad_release')
    fakes=Fakes(healthy_images=(PREV_IMAGE,))

    async def failing_finish(*args, **kwargs):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(Incident_Crud, "crud_incident_action_finish", staticmethod(failing_finish))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert len(fakes.updates) == 1 and fakes.updates[0][2] == PREV_IMAGE
    rows=await action_rows(i_id)
    assert [(row.action, row.result) for row in rows] == [('rollback', 'failed')]
    assert rows[0].detail.startswith(UNRECORDED_DETAIL) and "database is locked" in rows[0].detail
    assert (await fresh_incident(i_id)).status == 'needs_action'

    monkeypatch.undo()
    await assert_later_recovery_is_blocked(db, d_id, 'unhealthy')


# (c) 서버가 되돌리기 도중 꺼졌다 켜지면 running 인 되돌리기 시도에 표식이 남는다 (재시작 시도는 그대로)
@pytest.mark.asyncio
async def test_resume_marks_running_rollback_and_blocks_later_actions(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='bad_release', status='recovering')
    await add_action(db, i_id, 'restart', 'running')
    await add_action(db, i_id, 'rollback', 'running')

    await Recovery_Service.services_recovery_resume(db)

    rows=await action_rows(i_id)
    assert [(row.action, row.result) for row in rows] == [('restart', 'failed'), ('rollback', 'failed')]
    assert rows[0].detail == RESUME_DETAIL
    assert rows[1].detail.startswith((BOOKKEEPING_DETAIL, UNRECORDED_DETAIL))
    assert (await fresh_incident(i_id)).status == 'needs_action'

    await assert_later_recovery_is_blocked(db, d_id, 'unhealthy')


# 재시작만 멈춰 있었다면 서버를 다시 켠 뒤에도 자동 복구는 막히지 않는다
@pytest.mark.asyncio
async def test_resume_of_a_restart_does_not_block(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='unhealthy', status='recovering')
    await add_action(db, i_id, 'restart', 'running')

    await Recovery_Service.services_recovery_resume(db)

    later=await make_incident(db, d_id, kind='unhealthy')
    again=Fakes(healthy_images=(CUR_IMAGE,))
    await Recovery_Service.services_recovery_start(db, later, **again.kwargs())

    assert len(again.updates) == 1
