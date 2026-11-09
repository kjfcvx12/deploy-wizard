import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy.future import select

from shared.database import Base, async_engine, AsyncSessionLocal

from features.deploys.pipeline import Deploy_Pipeline
from features.deploys import pipeline as pipeline_module
from features.deploys.crud import Deploy_Crud
from features.deploys.models import Deploy_Release
from features.deploys.services import Deploy_Service
from features.express.scheme import Express_Status

IMAGE="111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/x:"


@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    monkeypatch.setattr(Deploy_Pipeline, "pipeline_start", staticmethod(lambda *a, **kw: True))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# 배포의 현재 커밋·이미지를 바꾼다 (실제로는 파이프라인이 채운다)
async def stub_deploy(d_id, **fields):
    async with AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d_id, fields)
        await db.commit()


# 배포가 running 에 도달한 것처럼 릴리스를 기록한다
async def release(d_id, sha_char, status='running'):
    await stub_deploy(d_id, commit_sha=sha_char * 40, image_uri=f"{IMAGE}{sha_char * 7}", status=status)
    async with AsyncSessionLocal() as db:
        return await Deploy_Service.services_deploy_release_record(db, d_id)


# 릴리스를 (id 순) state 목록으로
async def release_states(d_id):
    async with AsyncSessionLocal() as db:
        rows=(await db.execute(select(Deploy_Release).where(Deploy_Release.d_id == d_id).order_by(Deploy_Release.d_r_id))).scalars().all()
        return [(r.commit_sha[0], r.state) for r in rows]


async def make_deploy(client) -> int:
    return (await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]


@pytest.mark.asyncio
async def test_release_first_deploy_is_current(client):
    d_id=await make_deploy(client)

    first=await release(d_id, "a")

    assert first.state == 'current' and first.image_uri == f"{IMAGE}aaaaaaa" and first.commit_sha == "a" * 40
    assert await release_states(d_id) == [("a", "current")]


@pytest.mark.asyncio
async def test_release_second_deploy_demotes_first_to_previous(client):
    d_id=await make_deploy(client)

    await release(d_id, "a")
    await release(d_id, "b")

    assert await release_states(d_id) == [("a", "previous"), ("b", "current")]


@pytest.mark.asyncio
async def test_release_keeps_only_one_previous(client):
    d_id=await make_deploy(client)

    await release(d_id, "a")
    await release(d_id, "b")
    await release(d_id, "c")

    assert await release_states(d_id) == [("a", "old"), ("b", "previous"), ("c", "current")]

    async with AsyncSessionLocal() as db:
        previous=await Deploy_Service.services_deploy_release_previous(db, d_id)
        assert previous.commit_sha == "b" * 40


@pytest.mark.asyncio
async def test_release_other_deploys_are_untouched(client):
    first=await make_deploy(client)
    second=await make_deploy(client)

    await release(first, "a")
    await release(second, "b")
    await release(first, "c")

    assert await release_states(first) == [("a", "previous"), ("c", "current")]
    assert await release_states(second) == [("b", "current")]


@pytest.mark.asyncio
async def test_release_same_version_again_adds_nothing(client):
    d_id=await make_deploy(client)

    await release(d_id, "a")
    await release(d_id, "a")

    assert await release_states(d_id) == [("a", "current")]


@pytest.mark.asyncio
async def test_release_failed_rows_are_left_alone(client):
    d_id=await make_deploy(client)

    await release(d_id, "a")
    async with AsyncSessionLocal() as db:
        db.add(Deploy_Release(d_id=d_id, commit_sha="f" * 40, image_uri=f"{IMAGE}fffffff", state='failed'))
        await db.commit()

    await release(d_id, "b")

    assert await release_states(d_id) == [("a", "previous"), ("f", "failed"), ("b", "current")]


@pytest.mark.asyncio
async def test_release_previous_ignores_empty_image_uri(client):
    d_id=await make_deploy(client)

    async with AsyncSessionLocal() as db:
        assert await Deploy_Service.services_deploy_release_previous(db, d_id) is None

        db.add(Deploy_Release(d_id=d_id, commit_sha="a" * 40, image_uri="", state='previous'))
        await db.commit()
        assert await Deploy_Service.services_deploy_release_previous(db, d_id) is None

        db.add(Deploy_Release(d_id=d_id, commit_sha="b" * 40, image_uri=f"{IMAGE}bbbbbbb", state='previous'))
        await db.commit()
        assert (await Deploy_Service.services_deploy_release_previous(db, d_id)).commit_sha == "b" * 40


@pytest.mark.asyncio
async def test_release_unknown_deploy_is_404(client):
    from fastapi import HTTPException

    async with AsyncSessionLocal() as db:
        with pytest.raises(HTTPException) as error:
            await Deploy_Service.services_deploy_release_record(db, 9999)
    assert error.value.status_code == 404


def fake_success(monkeypatch):
    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_clone", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Dockerfile_Service, "services_dockerfile_write", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_image_exists", staticmethod(lambda tag: True))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_remove_local", staticmethod(lambda *a, **kw: None))

    async def fake_session(db, aws_account_id):
        return object()

    monkeypatch.setattr(pipeline_module.Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_session))


# 첫 배포가 끝난 뒤 "다시 배포"가 deploying 단계에서 도는 상태를 만든다 (서비스가 이미 있다)
async def prepare_redeploy(d_id, sha_char):
    await stub_deploy(d_id, status="queued", error_step="deploying",
                      commit_sha=sha_char * 40, language="python", support_level="official", app_dir=".",
                      dockerfile="FROM python:3.12\n", dockerfile_source="template_rule",
                      port=8000, health_check_path="/", service_arn="arn:svc",
                      image_uri=f"{IMAGE}{sha_char * 7}", repository_name="deploy-wizard/r-1")


@pytest.mark.asyncio
async def test_pipeline_records_release_only_on_running(client, monkeypatch):
    fake_success(monkeypatch)
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_update", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_wait",
                        staticmethod(lambda *a, **kw: Express_Status(service_arn="arn:svc", endpoint="https://x.example")))

    d_id=await make_deploy(client)

    await prepare_redeploy(d_id, "a")
    await Deploy_Pipeline.pipeline_run(d_id, "deploying")
    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "running"
    assert await release_states(d_id) == [("a", "current")]

    await prepare_redeploy(d_id, "b")
    await Deploy_Pipeline.pipeline_run(d_id, "deploying")
    assert await release_states(d_id) == [("a", "previous"), ("b", "current")]


@pytest.mark.asyncio
async def test_pipeline_failed_redeploy_leaves_releases_unchanged(client, monkeypatch):
    fake_success(monkeypatch)

    d_id=await make_deploy(client)
    await release(d_id, "a")
    before=await release_states(d_id)

    def boom(*_a, **_kw):
        raise RuntimeError("update 실패")

    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_update", staticmethod(boom))

    await prepare_redeploy(d_id, "b")
    await Deploy_Pipeline.pipeline_run(d_id, "deploying")

    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "failed"
    assert await release_states(d_id) == before == [("a", "current")]


@pytest.mark.asyncio
async def test_pipeline_release_error_does_not_fail_a_running_deploy(client, monkeypatch):
    fake_success(monkeypatch)
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_update", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_wait",
                        staticmethod(lambda *a, **kw: Express_Status(service_arn="arn:svc", endpoint="https://x.example")))

    async def boom(db, d_id):
        raise RuntimeError("릴리스 기록 실패")

    monkeypatch.setattr(Deploy_Service, "services_deploy_release_record", staticmethod(boom))

    d_id=await make_deploy(client)
    await prepare_redeploy(d_id, "a")
    await Deploy_Pipeline.pipeline_run(d_id, "deploying")

    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "running"
