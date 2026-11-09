import pytest
from datetime import timedelta

from sqlalchemy import update

from shared.database import AsyncSessionLocal

from features.deploys.models import Deploy, Deploy_Release
from features.deploys.services import Deploy_Service, DEPLOY_CHANGED_DETAIL
from features.incidents.recovery import Recovery_Service, BOOKKEEPING_DETAIL
from features.accounts.services import Aws_Account_Service

from recovery_helpers import (_now, db, notified, aws_session, Fakes, make_deploy, make_incident, fresh_incident, fresh_deploy,
                              actions_of, action_rows, release_states, CUR_SHA, PREV_SHA, CUR_IMAGE, PREV_IMAGE)

pytestmark=pytest.mark.usefixtures("aws_session")


# 배포 행을 다른 세션에서 바꾼다 (복구 도중 사용자가 만지는 것을 흉내)
async def change_deploy(d_id, **values):
    async with AsyncSessionLocal() as session:
        await session.execute(update(Deploy).where(Deploy.d_id == d_id).values(**values))
        await session.commit()


# apply_rollback 을 처음 n 번은 실패시킨다
def fail_apply(monkeypatch, times):
    real=Deploy_Service.services_deploy_apply_rollback
    calls=[]

    async def flaky(db, d_id, release, expected_image_uri=None):
        calls.append(1)
        if len(calls) <= times:
            raise RuntimeError(f"DB 오류 {len(calls)}")
        return await real(db, d_id, release, expected_image_uri)

    monkeypatch.setattr(Deploy_Service, "services_deploy_apply_rollback", staticmethod(flaky))
    return calls


# 되돌리기 기록 반영이 한 번 실패해도 다시 시도해서 모두 기록한다
@pytest.mark.asyncio
async def test_rollback_bookkeeping_retries_then_succeeds(db, notified, monkeypatch):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='bad_release')
    calls=fail_apply(monkeypatch, 1)
    fakes=Fakes(healthy_images=(PREV_IMAGE,))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert len(calls) == 2
    assert len(fakes.updates) == 1
    assert (await fresh_incident(i_id)).status == 'resolved'
    assert await actions_of(i_id) == [('rollback', 'ok')]
    deploy=await fresh_deploy(d_id)
    assert (deploy.image_uri, deploy.commit_sha, deploy.bad_commit_sha) == (PREV_IMAGE, PREV_SHA, CUR_SHA)
    assert await release_states(d_id) == [('a', 'current'), ('c', 'failed')]
    assert notified == [(i_id, 'incident_recovered')]


# 3번 모두 실패하면 needs_action + 정확한 detail, 이후 자동 복구는 AWS 를 부르지 않는다
@pytest.mark.asyncio
async def test_rollback_bookkeeping_fails_three_times_blocks_later_recovery(db, notified, monkeypatch):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='bad_release')
    calls=fail_apply(monkeypatch, 3)
    fakes=Fakes(healthy_images=(PREV_IMAGE,))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert len(calls) == 3
    assert fakes.sleeps.count(1) == 2
    assert len(fakes.updates) == 1
    rows=await action_rows(i_id)
    assert [(row.action, row.result) for row in rows] == [('rollback', 'failed')]
    assert rows[0].detail.startswith(BOOKKEEPING_DETAIL)
    assert (await fresh_incident(i_id)).status == 'needs_action'
    assert notified == [(i_id, 'incident_needs_action')]
    # 기록은 그대로 (거짓이지만 건드리지 않았다)
    assert (await fresh_deploy(d_id)).image_uri == CUR_IMAGE

    # 다음 인시던트 - 재시작이든 되돌리기든 AWS 를 부르지 않는다
    monkeypatch.undo()
    later=await make_incident(db, d_id, kind='unhealthy')
    again=Fakes(healthy_images=(CUR_IMAGE, PREV_IMAGE))

    await Recovery_Service.services_recovery_start(db, later, **again.kwargs())

    assert again.updates == []
    assert (await fresh_incident(later)).status == 'needs_action'

    # 사용자가 새 버전을 배포해 새 릴리스가 생기면 다시 자동 복구를 한다
    async with AsyncSessionLocal() as session:
        session.add(Deploy_Release(d_id=d_id, commit_sha="e" * 40, image_uri=CUR_IMAGE + "2", state='current',
                                   created_at=_now() + timedelta(hours=1)))
        await session.commit()
    third=await make_incident(db, d_id, kind='unhealthy')
    healthy=Fakes(healthy_images=(CUR_IMAGE,))

    await Recovery_Service.services_recovery_start(db, third, **healthy.kwargs())

    assert len(healthy.updates) == 1


# 검증하는 사이 배포가 진행 상태로 바뀌었거나 이미지가 바뀌었으면 기록을 덮어쓰지 않는다
@pytest.mark.asyncio
@pytest.mark.parametrize("change", [dict(status='building'), dict(image_uri="999999999999.dkr.ecr.x/new:fffffff"),
                                    dict(image_uri=PREV_IMAGE)], ids=["status", "image", "image-equals-previous"])
async def test_rollback_skips_bookkeeping_when_deploy_changed(db, notified, change):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='bad_release')
    fakes=Fakes(healthy_images=(PREV_IMAGE,))
    original=fakes.checker
    changed=[]

    async def changing_checker(url):
        if not changed:
            changed.append(1)
            await change_deploy(d_id, **change)
        return await original(url)

    kwargs=fakes.kwargs()
    kwargs["checker"]=changing_checker

    await Recovery_Service.services_recovery_start(db, i_id, **kwargs)

    assert len(fakes.updates) == 1
    rows=await action_rows(i_id)
    assert [(row.action, row.result, row.detail) for row in rows] == [('rollback', 'failed', DEPLOY_CHANGED_DETAIL)]
    assert (await fresh_incident(i_id)).status == 'needs_action'
    assert notified == [(i_id, 'incident_needs_action')]

    deploy=await fresh_deploy(d_id)
    assert deploy.commit_sha == CUR_SHA
    assert deploy.bad_commit_sha is None
    assert deploy.image_uri == change.get("image_uri", CUR_IMAGE)
    assert deploy.status == change.get("status", 'running')
    assert await release_states(d_id) == [('a', 'previous'), ('c', 'current')]


# 정상 경로는 그대로 (expected 이미지를 넘겨도 반영된다)
@pytest.mark.asyncio
async def test_apply_rollback_with_expected_image_normal_path(db):
    d_id=await make_deploy(db)
    target=await Deploy_Service.services_deploy_release_rollback_target(db, d_id)

    await Deploy_Service.services_deploy_apply_rollback(db, d_id, target, CUR_IMAGE)

    assert (await fresh_deploy(d_id)).image_uri == PREV_IMAGE


# AWS 를 부르기 직전에 배포가 멈췄거나 자동 복구가 꺼졌으면 갱신을 부르지 않는다
@pytest.mark.asyncio
@pytest.mark.parametrize("change", [dict(status='stopped'), dict(auto_recover=False)], ids=["stopped", "auto-recover-off"])
@pytest.mark.parametrize("kind", ['unhealthy', 'bad_release'])
async def test_recovery_final_check_before_update(db, notified, monkeypatch, change, kind):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind=kind)

    async def flipping_build(db, aws_account_id):
        await change_deploy(d_id, **change)
        return "FAKE_SESSION"

    monkeypatch.setattr(Aws_Account_Service, "services_aws_account_build_session", staticmethod(flipping_build))
    fakes=Fakes(healthy_images=(CUR_IMAGE, PREV_IMAGE))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert fakes.updates == []
    assert fakes.waits == [] and fakes.checked == []
    assert (await fresh_incident(i_id)).status == 'needs_action'
    assert notified == [(i_id, 'incident_needs_action')]
    rows=await action_rows(i_id)
    assert [row.result for row in rows] == ['failed']


# 지금 이미지와 같은 이미지의 이전 버전은 되돌리기 대상이 아니다
@pytest.mark.asyncio
async def test_rollback_target_ignores_release_with_current_image(db, notified):
    d_id=await make_deploy(db, previous_image=CUR_IMAGE)
    i_id=await make_incident(db, d_id, kind='bad_release')
    fakes=Fakes(healthy_images=(CUR_IMAGE,))

    assert await Deploy_Service.services_deploy_release_rollback_target(db, d_id) is None

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert fakes.updates == []
    assert (await fresh_incident(i_id)).status == 'needs_action'
