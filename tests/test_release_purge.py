import pytest
from datetime import datetime
from sqlalchemy import update, select

from shared.database import AsyncSessionLocal

from features.deploys import services as deploys_services_module
from features.deploys.models import Deploy, Deploy_Release
from features.deploys.services import Deploy_Service
from features.incidents.recovery import Recovery_Service

from recovery_helpers import db, notified, aws_session, Fakes, make_deploy, make_incident, fresh_incident, release_states, PREV_IMAGE, CUR_IMAGE

pytestmark=pytest.mark.usefixtures("aws_session")


# 저장소 삭제를 흉내낸다 (실제 AWS 는 부르지 않는다)
@pytest.fixture
def aws_deletes(monkeypatch):
    calls={"services": [], "repos": []}
    monkeypatch.setattr(deploys_services_module.Express_Service, "services_express_delete",
                        staticmethod(lambda session, service_arn: calls["services"].append(service_arn)))
    monkeypatch.setattr(deploys_services_module.Express_Service, "services_express_delete_repository",
                        staticmethod(lambda session, repository_name: calls["repos"].append(repository_name)))
    return calls


async def set_repository(d_id, **values):
    async with AsyncSessionLocal() as session:
        await session.execute(update(Deploy).where(Deploy.d_id == d_id).values(repository_name="deploy-wizard/r-1", **values))
        await session.commit()


# 작업 종료로 이미지를 지우면 직전 버전은 되돌리기 대상이 아니다 - 다시 켠 뒤 인시던트가 나도 되돌리기 호출은 없다
@pytest.mark.asyncio
async def test_session_end_purge_removes_rollback_target(db, notified, aws_deletes):
    d_id=await make_deploy(db)
    await set_repository(d_id)
    assert await Deploy_Service.services_deploy_release_rollback_target(db, d_id) is not None

    report=await Deploy_Service.services_deploy_session_end(db)

    assert report["purged"] and aws_deletes["repos"] == ["deploy-wizard/r-1"]
    assert await release_states(d_id) == [('a', 'old'), ('c', 'current')]
    assert await Deploy_Service.services_deploy_release_rollback_target(db, d_id) is None

    # 다시 켜서 running 이 되고 새 버전에 문제가 생겼다고 하자 (이미지는 current 와 같은 태그로 다시 만들어졌다)
    async with AsyncSessionLocal() as session:
        await session.execute(update(Deploy).where(Deploy.d_id == d_id).values(status='running', service_arn="arn:aws:ecs:x:1:service/s",
                                                                              image_uri="111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/x:ccccccc"))
        await session.commit()
    i_id=await make_incident(db, d_id, kind='bad_release')
    fakes=Fakes(healthy_images=(PREV_IMAGE,))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    assert fakes.updates == []
    assert (await fresh_incident(i_id)).status == 'needs_action'


# 이미지를 지운 뒤 같은 태그로 다시 빌드한 current 의 정상 확인 시각은 비워진다 - 그 뒤 새 버전을 배포해도 죽은 이미지가 되돌리기 대상이 되지 않는다
@pytest.mark.asyncio
async def test_purge_clears_current_healthy_since_so_a_later_release_has_no_dead_target(db, aws_deletes):
    d_id=await make_deploy(db)
    await set_repository(d_id)
    async with AsyncSessionLocal() as session:
        await session.execute(update(Deploy_Release).where(Deploy_Release.d_id == d_id, Deploy_Release.state == 'current')
                              .values(healthy_since=datetime(2026, 11, 2)))
        await session.commit()

    await Deploy_Service.services_deploy_session_end(db)

    async with AsyncSessionLocal() as session:
        current=(await session.execute(select(Deploy_Release).where(Deploy_Release.d_id == d_id, Deploy_Release.state == 'current'))).scalars().one()
        assert current.healthy_since is None

    # 다시 켜서 같은 태그로 다시 빌드된 뒤 새 커밋을 배포한다
    async with AsyncSessionLocal() as session:
        await session.execute(update(Deploy).where(Deploy.d_id == d_id).values(status='running', service_arn="arn:aws:ecs:x:1:service/s",
                                                                              image_uri=CUR_IMAGE))
        await session.commit()
    async with AsyncSessionLocal() as session:
        await session.execute(update(Deploy).where(Deploy.d_id == d_id).values(commit_sha="e" * 40, image_uri=CUR_IMAGE + "2"))
        await session.commit()
    async with AsyncSessionLocal() as session:
        await Deploy_Service.services_deploy_release_record(session, d_id)

    assert await release_states(d_id) == [('a', 'old'), ('c', 'previous'), ('e', 'current')]
    assert await Deploy_Service.services_deploy_release_rollback_target(db, d_id) is None


# 이미지를 남기는 작업 종료(--keep-images)와 보기만(dry_run)은 되돌리기 대상을 건드리지 않는다
@pytest.mark.asyncio
async def test_session_end_keep_images_and_dry_run_keep_rollback_target(db, aws_deletes):
    d_id=await make_deploy(db)
    await set_repository(d_id)

    await Deploy_Service.services_deploy_session_end(db, dry_run=True)
    assert await release_states(d_id) == [('a', 'previous'), ('c', 'current')]

    await Deploy_Service.services_deploy_session_end(db, keep_images=True)
    assert aws_deletes["repos"] == []
    assert await release_states(d_id) == [('a', 'previous'), ('c', 'current')]


# 배포 삭제로 저장소가 지워질 때도 마찬가지다
@pytest.mark.asyncio
async def test_deploy_delete_removes_rollback_target(db, aws_deletes):
    d_id=await make_deploy(db, status='stopped')
    await set_repository(d_id)

    await Deploy_Service.services_deploy_delete(db, d_id)

    assert aws_deletes["repos"] == ["deploy-wizard/r-1"]
    assert await release_states(d_id) == [('a', 'old'), ('c', 'current')]
