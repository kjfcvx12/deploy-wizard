import types
import pytest

from shared.database import AsyncSessionLocal

from features.deploys.crud import Deploy_Crud
from features.deploys.services import Deploy_Service
from features.watches.services import Watch_Service
from features.watches import services as watches_module

from recovery_helpers import db, make_deploy, fresh_deploy, CUR_SHA, PREV_SHA

NEW_SHA="d" * 40


# 되돌린 뒤 - 배포는 이전 커밋이고, 나쁜 커밋은 기억해 둔다
@pytest.mark.asyncio
async def test_apply_rollback_sets_bad_commit_and_release_states(db):
    d_id=await make_deploy(db)
    target=await Deploy_Service.services_deploy_release_rollback_target(db, d_id)

    await Deploy_Service.services_deploy_apply_rollback(db, d_id, target)

    deploy=await fresh_deploy(d_id)
    assert (deploy.commit_sha, deploy.bad_commit_sha) == (PREV_SHA, CUR_SHA)


async def run_poll(monkeypatch, d_id, remote_sha):
    monkeypatch.setattr(watches_module.Repo_Service, "services_repo_commit_sha", staticmethod(lambda url, branch, token: remote_sha))

    redeployed=[]
    marked=[]

    async def fake_redeploy(db, d_id):
        redeployed.append(d_id)

    async def fake_mark(db, d_id, commit_sha):
        marked.append((d_id, commit_sha))

    monkeypatch.setattr(watches_module.Deploy_Service, "services_deploy_redeploy", staticmethod(fake_redeploy))
    monkeypatch.setattr(watches_module.Deploy_Service, "services_deploy_mark_new_commit", staticmethod(fake_mark))

    async with AsyncSessionLocal() as session:
        deploy=await Deploy_Crud.crud_deploy_get_by_d_id(session, d_id)

    await Watch_Service.services_watch_poll_deploy(deploy)
    return redeployed, marked


# 폴링 - 원격 최신 커밋이 나쁜 커밋이면 다시 배포하지 않는다
@pytest.mark.asyncio
async def test_watch_poll_skips_bad_commit(db, monkeypatch):
    d_id=await make_deploy(db)
    target=await Deploy_Service.services_deploy_release_rollback_target(db, d_id)
    await Deploy_Service.services_deploy_apply_rollback(db, d_id, target)

    redeployed, marked=await run_poll(monkeypatch, d_id, CUR_SHA)

    assert redeployed == []
    assert marked == [(d_id, CUR_SHA)]
    assert (await fresh_deploy(d_id)).bad_commit_sha == CUR_SHA


# 폴링 - 더 새로운 커밋이 오면 막힘을 풀고 다시 배포한다
@pytest.mark.asyncio
async def test_watch_poll_redeploys_newer_commit_and_clears_block(db, monkeypatch):
    d_id=await make_deploy(db)
    target=await Deploy_Service.services_deploy_release_rollback_target(db, d_id)
    await Deploy_Service.services_deploy_apply_rollback(db, d_id, target)

    redeployed, marked=await run_poll(monkeypatch, d_id, NEW_SHA)

    assert redeployed == [d_id]
    assert marked == []
    assert (await fresh_deploy(d_id)).bad_commit_sha is None


# 막힘이 없는 배포는 평소대로
@pytest.mark.asyncio
async def test_watch_poll_without_block_redeploys(db, monkeypatch):
    d_id=await make_deploy(db)

    redeployed, marked=await run_poll(monkeypatch, d_id, NEW_SHA)

    assert redeployed == [d_id]


# 웹훅 - 나쁜 커밋 푸시는 디바운스 재배포를 예약하지 않는다
@pytest.mark.asyncio
async def test_watch_webhook_skips_bad_commit(db, monkeypatch):
    d_id=await make_deploy(db)
    target=await Deploy_Service.services_deploy_release_rollback_target(db, d_id)
    await Deploy_Service.services_deploy_apply_rollback(db, d_id, target)

    scheduled=[]
    monkeypatch.setattr(Watch_Service, "services_watch_debounce_schedule", staticmethod(scheduled.append))

    ack=await Watch_Service.services_watch_handle_push(db, "https://github.com/o/r", "main", CUR_SHA, "main")
    assert scheduled == [] and ack.debounced == 0
    assert (await fresh_deploy(d_id)).watch_commit_sha == CUR_SHA

    ack=await Watch_Service.services_watch_handle_push(db, "https://github.com/o/r", "main", NEW_SHA, "main")
    assert scheduled == [d_id] and ack.debounced == 1
    assert (await fresh_deploy(d_id)).bad_commit_sha is None
