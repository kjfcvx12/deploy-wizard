import asyncio
import pytest
from datetime import datetime, timedelta

from shared.settings import settings
from shared.database import AsyncSessionLocal

from features.incidents.recovery import Recovery_Service

from recovery_helpers import (_now, db, notified, aws_session, Fakes, make_deploy, make_incident, add_action, fresh_incident,
                              actions_of, CUR_IMAGE, PREV_IMAGE)

pytestmark=pytest.mark.usefixtures("aws_session")


# 조건이 하나라도 안 맞으면 AWS 를 한 번도 부르지 않고, 열려 있는 인시던트는 needs_action 이 된다
@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["auto_recover_off", "deploy_not_running", "no_service_arn", "attempts_exhausted", "daily_limit"])
async def test_recovery_precondition_failure_makes_zero_aws_calls(db, notified, name):
    deploy_kwargs={
        "auto_recover_off": dict(auto_recover=False),
        "deploy_not_running": dict(status='stopped'),
        "no_service_arn": dict(service_arn=None),
    }.get(name, {})
    d_id=await make_deploy(db, **deploy_kwargs)
    i_id=await make_incident(db, d_id, status='open')

    if name == "attempts_exhausted":
        for action in ('restart', 'rollback'):
            await add_action(db, i_id, action, 'failed')

    if name == "daily_limit":
        older=await make_incident(db, d_id, status='resolved')
        for _ in range(settings.recovery_daily_limit):
            await add_action(db, older, 'restart', 'ok', started_at=_now() - timedelta(hours=23))

    fakes=Fakes(healthy_images=(CUR_IMAGE, PREV_IMAGE))
    before=len(await actions_of(i_id))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert fakes.updates == []
    assert fakes.waits == [] and fakes.checked == [] and fakes.sleeps == []
    assert len(await actions_of(i_id)) == before
    assert (await fresh_incident(i_id)).status == 'needs_action'
    assert notified == [(i_id, 'incident_needs_action')]


# 24시간이 지난 시도는 하루 한도에 세지 않는다
@pytest.mark.asyncio
async def test_recovery_daily_limit_ignores_old_actions(db, notified):
    d_id=await make_deploy(db)
    older=await make_incident(db, d_id, status='resolved')
    for _ in range(settings.recovery_daily_limit):
        await add_action(db, older, 'restart', 'ok', started_at=_now() - timedelta(hours=25))
    i_id=await make_incident(db, d_id, status='open')
    fakes=Fakes(healthy_images=(CUR_IMAGE,))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert len(fakes.updates) == 1
    assert (await fresh_incident(i_id)).status == 'resolved'


# 하루 한도에 한 번 남았으면 그 한 번만 하고 멈춘다 (재시작 뒤 되돌리기는 한도에 막힌다)
@pytest.mark.asyncio
async def test_recovery_daily_limit_applies_between_steps(db, notified):
    d_id=await make_deploy(db)
    older=await make_incident(db, d_id, status='resolved')
    for _ in range(settings.recovery_daily_limit - 1):
        await add_action(db, older, 'restart', 'ok', started_at=_now() - timedelta(hours=1))
    i_id=await make_incident(db, d_id, status='open')
    fakes=Fakes(healthy_images=())

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert [update[2] for update in fakes.updates] == [CUR_IMAGE]
    assert await actions_of(i_id) == [('restart', 'failed')]
    assert (await fresh_incident(i_id)).status == 'needs_action'


# 이미 끝난 인시던트는 아무것도 하지 않는다 (상태도 그대로)
@pytest.mark.asyncio
@pytest.mark.parametrize("status", ['resolved', 'needs_action'])
async def test_recovery_ignores_closed_incident(db, notified, status):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, status=status)
    fakes=Fakes(healthy_images=(CUR_IMAGE,))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert fakes.updates == []
    assert (await fresh_incident(i_id)).status == status
    assert notified == []


# 없는 인시던트 번호
@pytest.mark.asyncio
async def test_recovery_unknown_incident_is_noop(db, notified):
    fakes=Fakes()

    await Recovery_Service.services_recovery_start(db, 999, **fakes.kwargs())

    assert fakes.updates == [] and notified == []


# 같은 인시던트에 동시에 시작해도 실행은 한 번 (배포별 잠금)
@pytest.mark.asyncio
async def test_recovery_concurrent_starts_run_once(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, status='open')
    fakes=Fakes(healthy_images=(CUR_IMAGE,))

    async def slow_sleeper(seconds):
        fakes.sleeps.append(seconds)
        await asyncio.sleep(0.01)

    async def call():
        async with AsyncSessionLocal() as session:
            await Recovery_Service.services_recovery_start(session, i_id, updater=fakes.updater, waiter=fakes.waiter,
                                                           sleeper=slow_sleeper, checker=fakes.checker)

    await asyncio.gather(call(), call(), call())

    assert len(fakes.updates) == 1
    assert await actions_of(i_id) == [('restart', 'ok')]
    assert notified == [(i_id, 'incident_recovered')]


# 같은 배포의 서로 다른 인시던트도 동시에 돌지 않는다 - 한쪽이 끝난 뒤에야 다음 쪽이 시작한다
@pytest.mark.asyncio
async def test_recovery_lock_is_per_deploy(db, notified):
    d_id=await make_deploy(db)
    first=await make_incident(db, d_id, status='open')
    # 정상적으로는 배포마다 열린 인시던트가 하나지만, 잠금 자체는 인시던트가 둘이어도 겹치지 않아야 한다
    second=await make_incident(db, d_id, status='open')
    fakes=Fakes(healthy_images=(CUR_IMAGE,))
    running=[]
    overlap=[]

    async def slow_sleeper(seconds):
        running.append(1)
        overlap.append(len(running))
        await asyncio.sleep(0.01)
        running.pop()

    async def call(i_id):
        async with AsyncSessionLocal() as session:
            await Recovery_Service.services_recovery_start(session, i_id, updater=fakes.updater, waiter=fakes.waiter,
                                                           sleeper=slow_sleeper, checker=fakes.checker)

    await asyncio.gather(call(first), call(second))

    assert max(overlap) == 1
    assert len(fakes.updates) == 2
