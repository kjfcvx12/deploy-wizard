import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from shared.database import Base, async_engine, AsyncSessionLocal

from features.deploys.crud import Deploy_Crud
from features.deploys.pipeline import Deploy_Pipeline
from features.deploys import pipeline as pipeline_module
from features.express.scheme import Express_Status
from features.incidents.models import Recovery_Action
from features.incidents.services import Incident_Service
from features.notifications.models import Notification
from features.notifications.services import Notification_Service
from features.watches.services import Watch_Service
from features.watches import services as watches_module

from recovery_helpers import db, make_deploy, make_incident

IMAGE="111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/x:"

# 알림이 붙는 자리(파이프라인 끝, 새 커밋, 모니터 해제 경로) 시험


@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    monkeypatch.setattr(Deploy_Pipeline, "pipeline_start", staticmethod(lambda *a, **kw: True))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def kinds_written(kind=None) -> list[tuple[str, str]]:
    async with AsyncSessionLocal() as session:
        query=select(Notification).where(Notification.channel == 'inapp').order_by(Notification.n_id)
        if kind:
            query=query.where(Notification.kind == kind)
        return [(row.kind, row.title) for row in (await session.execute(query)).scalars().all()]


def fake_success(monkeypatch):
    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_clone", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Dockerfile_Service, "services_dockerfile_write", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_image_exists", staticmethod(lambda tag: True))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_remove_local", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_update", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_wait",
                        staticmethod(lambda *a, **kw: Express_Status(service_arn="arn:svc", endpoint="https://x.example")))

    async def fake_session(db, aws_account_id):
        return object()

    monkeypatch.setattr(pipeline_module.Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_session))


async def prepare_redeploy(d_id):
    async with AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d_id, dict(
            status="queued", error_step="deploying", commit_sha="a" * 40, language="python", support_level="official", app_dir=".",
            dockerfile="FROM python:3.12\n", dockerfile_source="template_rule", port=8000, health_check_path="/", service_arn="arn:svc",
            image_uri=f"{IMAGE}aaaaaaa", repository_name="deploy-wizard/r-1"))
        await db.commit()


@pytest.mark.asyncio
async def test_pipeline_running_fires_deploy_succeeded_once(client, monkeypatch):
    fake_success(monkeypatch)
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]
    await prepare_redeploy(d_id)

    await Deploy_Pipeline.pipeline_run(d_id, "deploying")
    await Notification_Service.services_notification_tasks_wait()

    assert [kind for kind, _ in await kinds_written()] == ['deploy_succeeded']


@pytest.mark.asyncio
async def test_pipeline_failure_fires_deploy_failed_once(client, monkeypatch):
    fake_success(monkeypatch)

    def boom(*_a, **_kw):
        raise RuntimeError("update 실패")

    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_update", staticmethod(boom))
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]
    await prepare_redeploy(d_id)

    await Deploy_Pipeline.pipeline_run(d_id, "deploying")
    await Notification_Service.services_notification_tasks_wait()

    assert [kind for kind, _ in await kinds_written()] == ['deploy_failed']
    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "failed"


@pytest.mark.asyncio
async def test_pipeline_notification_error_never_breaks_the_pipeline(client, monkeypatch):
    fake_success(monkeypatch)

    def broken(*args, **kwargs):
        raise RuntimeError("알림 모듈 오류")

    monkeypatch.setattr(Notification_Service, "services_notification_deploy_fire", staticmethod(broken))
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]
    await prepare_redeploy(d_id)

    await Deploy_Pipeline.pipeline_run(d_id, "deploying")

    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "running"


@pytest.mark.asyncio
async def test_watch_poll_new_commit_notifies_once_when_auto_redeploy_off(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]
    async with AsyncSessionLocal() as session:
        await Deploy_Crud.crud_deploy_update(session, d_id, {"auto_redeploy": False, "commit_sha": "a" * 40})
        await session.commit()

    monkeypatch.setattr(watches_module.Repo_Service, "services_repo_commit_sha", staticmethod(lambda url, branch, token: "b" * 40))

    for _ in range(2):
        async with AsyncSessionLocal() as session:
            deploy=await Deploy_Crud.crud_deploy_get_by_d_id(session, d_id)
        await Watch_Service.services_watch_poll_deploy(deploy)
        await Notification_Service.services_notification_tasks_wait()

    written=await kinds_written('new_commit')
    assert len(written) == 1 and "bbbbbbb" in written[0][1]


@pytest.mark.asyncio
async def test_watch_poll_does_not_notify_new_commit_when_auto_redeploy_on(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]
    monkeypatch.setattr(watches_module.Repo_Service, "services_repo_commit_sha", staticmethod(lambda url, branch, token: "b" * 40))

    async def fake_redeploy(db, d_id):
        return None

    monkeypatch.setattr(watches_module.Deploy_Service, "services_deploy_redeploy", staticmethod(fake_redeploy))
    async with AsyncSessionLocal() as session:
        deploy=await Deploy_Crud.crud_deploy_get_by_d_id(session, d_id)

    await Watch_Service.services_watch_poll_deploy(deploy)
    await Notification_Service.services_notification_tasks_wait()

    assert await kinds_written('new_commit') == []


@pytest.mark.asyncio
async def test_watch_webhook_push_notifies_new_commit_when_auto_redeploy_off(client):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r", "branch": "main"})).json()["d_id"]
    async with AsyncSessionLocal() as session:
        await Deploy_Crud.crud_deploy_update(session, d_id, {"auto_redeploy": False})
        await session.commit()

    for _ in range(2):
        async with AsyncSessionLocal() as session:
            await Watch_Service.services_watch_handle_push(session, "https://github.com/o/r", "main", "c" * 40, "main")
        await Notification_Service.services_notification_tasks_wait()

    assert len(await kinds_written('new_commit')) == 1


@pytest.mark.asyncio
async def test_watch_notification_error_never_breaks_the_poll(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]
    async with AsyncSessionLocal() as session:
        await Deploy_Crud.crud_deploy_update(session, d_id, {"auto_redeploy": False, "commit_sha": "a" * 40})
        await session.commit()

    def broken(*args, **kwargs):
        raise RuntimeError("알림 모듈 오류")

    monkeypatch.setattr(Notification_Service, "services_notification_deploy_fire", staticmethod(broken))
    monkeypatch.setattr(watches_module.Repo_Service, "services_repo_commit_sha", staticmethod(lambda url, branch, token: "b" * 40))
    async with AsyncSessionLocal() as session:
        deploy=await Deploy_Crud.crud_deploy_get_by_d_id(session, d_id)

    await Watch_Service.services_watch_poll_deploy(deploy)

    async with AsyncSessionLocal() as session:
        assert (await Deploy_Crud.crud_deploy_get_by_d_id(session, d_id)).watch_commit_sha == "b" * 40


# 모니터 경로 - 해제 알림은 모니터의 세션·루프를 붙잡지 않도록 백그라운드로 띄운다
@pytest.mark.asyncio
async def test_incident_notify_spawn_uses_injected_spawner(db):
    spawned=[]

    started=Incident_Service.services_incident_notify_spawn(7, 'incident_recovered', spawner=lambda i_id, kind: spawned.append((i_id, kind)))

    assert spawned == [(7, 'incident_recovered')] and started is None


@pytest.mark.asyncio
async def test_incident_notify_spawn_default_runs_in_own_task_with_own_session(db, monkeypatch):
    sent=[]

    async def fake_send(session, incident, kind):
        sent.append((incident.i_id, kind, session is not db))

    monkeypatch.setattr(Notification_Service, "services_notification_send_incident", staticmethod(fake_send))
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id)

    task=Incident_Service.services_incident_notify_spawn(i_id, 'incident_recovered')

    assert sent == []
    from features.incidents.services import INCIDENT_TASKS
    assert task in INCIDENT_TASKS
    await Incident_Service.services_incident_tasks_wait()
    assert sent == [(i_id, 'incident_recovered', True)] and task not in INCIDENT_TASKS


@pytest.mark.asyncio
async def test_incident_notify_spawn_swallows_errors_with_masked_log(db, monkeypatch, caplog):
    async def boom(session, incident, kind):
        raise RuntimeError("실패 AKIAABCDEFGHIJKLMNOP")

    monkeypatch.setattr(Notification_Service, "services_notification_send_incident", staticmethod(boom))
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id)

    Incident_Service.services_incident_notify_spawn(i_id, 'incident_recovered')
    await Incident_Service.services_incident_tasks_wait()

    assert "AKIAABCDEFGHIJKLMNOP" not in caplog.text


@pytest.mark.asyncio
async def test_incident_resolve_on_monitor_path_does_not_notify_inline(db, monkeypatch):
    inline=[]
    spawned=[]

    async def fake_send(session, incident, kind):
        inline.append(kind)

    monkeypatch.setattr(Notification_Service, "services_notification_send_incident", staticmethod(fake_send))
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, status='needs_action')
    db.add(Recovery_Action(i_id=i_id, action='restart', result='failed'))
    await db.commit()

    resolved=await Incident_Service.services_incident_resolve(db, d_id, notify_spawner=lambda i, kind: spawned.append((i, kind)))

    assert resolved.status == 'resolved'
    assert inline == [] and spawned == [(i_id, 'incident_recovered')]

