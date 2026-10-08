import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

from shared.database import Base, async_engine

from features.deploys.pipeline import Deploy_Pipeline
from features.deploys import pipeline as pipeline_module
from features.deploys.crud import Deploy_Crud
from features.express.scheme import Express_Status

# 이어하기(M5) - 실패 지점 앞 단계는 저장된 값으로 건너뛴다


@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    monkeypatch.setattr(Deploy_Pipeline, "pipeline_start", staticmethod(lambda d_id: True))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# 실패했던 지점까지의 값을 DB에 채워 넣는다 (실제로는 이전 실행이 남긴 것)
async def stub_progress(d_id, **fields):
    async with pipeline_module.AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d_id, fields)
        await db.commit()


def fail(*_a, **_kw):
    raise AssertionError("이 단계는 건너뛰었어야 한다")


# 계정 연결 없이 개발 세션을 쓰는 것처럼 - AWS를 실제로 부르지 않는다
async def fake_build_session(db, aws_account_id):
    return object()


def boom(*_a, **_kw):
    raise RuntimeError("push 실패")


@pytest.mark.asyncio
async def test_pipeline_resume_skips_earlier_steps(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    await stub_progress(d_id, status="failed", error_step="pushing",
                        commit_sha="a" * 40, language="python", support_level="official", app_dir=".",
                        dockerfile="FROM python:3.12\n", dockerfile_source="template_rule",
                        port=8000, health_check_path="/")

    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_clone", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_detect", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Dockerfile_Service, "services_dockerfile_generate", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Dockerfile_Service, "services_dockerfile_write", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_image", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_image_exists", staticmethod(lambda tag: True))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_push",
                        staticmethod(lambda *a, **kw: "111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/x:abc1234"))
    monkeypatch.setattr(pipeline_module.Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_build_session))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_create",
                        staticmethod(lambda *a, **kw: Express_Status(service_arn="arn:svc", service_name="dw-r-1")))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_wait",
                        staticmethod(lambda *a, **kw: Express_Status(service_arn="arn:svc", endpoint="https://x.example")))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_remove_local", staticmethod(lambda *a, **kw: None))

    await Deploy_Pipeline.pipeline_run(d_id)

    body=(await client.get(f"/api/deploys/{d_id}")).json()
    assert body["status"] == "running"
    assert body["endpoint"] == "https://x.example"


@pytest.mark.asyncio
async def test_pipeline_resume_rebuilds_when_local_image_gone(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    await stub_progress(d_id, status="failed", error_step="pushing",
                        commit_sha="a" * 40, language="python", support_level="official", app_dir=".",
                        dockerfile="FROM python:3.12\n", dockerfile_source="template_rule",
                        port=8000, health_check_path="/")

    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_clone", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_detect", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Dockerfile_Service, "services_dockerfile_generate", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Dockerfile_Service, "services_dockerfile_write", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_image_exists", staticmethod(lambda tag: False))

    built=[]
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_image",
                        staticmethod(lambda *a, **kw: built.append(True)))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_push", staticmethod(boom))
    monkeypatch.setattr(pipeline_module.Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_build_session))

    await Deploy_Pipeline.pipeline_run(d_id)

    assert built == [True]
    body=(await client.get(f"/api/deploys/{d_id}")).json()
    assert body["status"] == "failed"
    assert body["error_step"] == "pushing"


@pytest.mark.asyncio
async def test_pipeline_resume_from_deploying_skips_build_and_push(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    await stub_progress(d_id, status="failed", error_step="deploying",
                        commit_sha="a" * 40, language="python", support_level="official", app_dir=".",
                        dockerfile="FROM python:3.12\n", dockerfile_source="template_rule",
                        port=8000, health_check_path="/",
                        image_uri="111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/x:abc1234",
                        repository_name="deploy-wizard/r-1")

    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_clone", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Dockerfile_Service, "services_dockerfile_write", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_image", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_push", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_build_session))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_create",
                        staticmethod(lambda *a, **kw: Express_Status(service_arn="arn:svc", service_name="dw-r-1")))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_wait",
                        staticmethod(lambda *a, **kw: Express_Status(service_arn="arn:svc", endpoint="https://x.example")))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_remove_local", staticmethod(lambda *a, **kw: None))

    await Deploy_Pipeline.pipeline_run(d_id)

    body=(await client.get(f"/api/deploys/{d_id}")).json()
    assert body["status"] == "running"
    assert body["endpoint"] == "https://x.example"


# M6 - 연결된 AWS 계정이 있으면 그 계정 id로 세션을 만든다 (없으면 None 그대로, M1~M5 동작 유지)
@pytest.mark.asyncio
async def test_pipeline_passes_connected_aws_account_id(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    await stub_progress(d_id, status="failed", error_step="deploying", aws_account_id=42,
                        commit_sha="a" * 40, language="python", support_level="official", app_dir=".",
                        dockerfile="FROM python:3.12\n", dockerfile_source="template_rule",
                        port=8000, health_check_path="/",
                        image_uri="111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/x:abc1234",
                        repository_name="deploy-wizard/r-1")

    seen=[]
    async def spy_build_session(db, aws_account_id):
        seen.append(aws_account_id)
        return object()

    # 연결된 계정이면 ECS 역할도 그 계정 것을 넘겨야 한다 (.env 의 개발 계정 역할은 남의 계정에서 못 쓴다)
    user_roles=("arn:aws:iam::222222222222:role/ecsTaskExecutionRole",
                "arn:aws:iam::222222222222:role/ecsInfrastructureRoleForExpressServices")
    async def fake_role_arns(db, aws_account_id):
        return user_roles if aws_account_id == 42 else None

    created_with=[]
    def spy_create(*a, **kw):
        created_with.append(kw.get("role_arns"))
        return Express_Status(service_arn="arn:svc", service_name="dw-r-1")

    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_clone", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Dockerfile_Service, "services_dockerfile_write", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_image", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_push", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Aws_Account_Service, "services_aws_account_build_session", staticmethod(spy_build_session))
    monkeypatch.setattr(pipeline_module.Aws_Account_Service, "services_aws_account_role_arns", staticmethod(fake_role_arns))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_create", staticmethod(spy_create))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_wait",
                        staticmethod(lambda *a, **kw: Express_Status(service_arn="arn:svc", endpoint="https://x.example")))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_remove_local", staticmethod(lambda *a, **kw: None))

    await Deploy_Pipeline.pipeline_run(d_id)

    assert seen == [42]
    assert created_with == [user_roles]
    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "running"


# M6 - GitHub 설치가 연결돼 있으면 클론 전에 설치 토큰을 받아서 그대로 넘긴다
@pytest.mark.asyncio
async def test_pipeline_clone_uses_github_installation_token(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r", "github_installation_id": 9})).json()["d_id"]

    seen_installation_ids=[]
    async def fake_token(db, g_id):
        seen_installation_ids.append(g_id)
        return "ghs_faketoken"

    seen_clone_tokens=[]
    def fake_clone(repo_url, branch, dest, on_line=None, token=None):
        seen_clone_tokens.append(token)
        raise RuntimeError("stop-here-test")

    monkeypatch.setattr(pipeline_module.Github_Service, "services_github_token_by_g_id", staticmethod(fake_token))
    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_clone", staticmethod(fake_clone))

    await Deploy_Pipeline.pipeline_run(d_id)

    assert seen_installation_ids == [9]
    assert seen_clone_tokens == ["ghs_faketoken"]

    body=(await client.get(f"/api/deploys/{d_id}")).json()
    assert body["status"] == "failed"
    assert body["error_step"] == "cloning"


# 연결 안 했으면 지금까지처럼 토큰 없이 (public 클론, M1~M5 동작 유지)
@pytest.mark.asyncio
async def test_pipeline_clone_without_github_installation_passes_no_token(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    seen_clone_tokens=[]
    def fake_clone(repo_url, branch, dest, on_line=None, token=None):
        seen_clone_tokens.append(token)
        raise RuntimeError("stop-here-test")

    monkeypatch.setattr(pipeline_module.Github_Service, "services_github_token_by_g_id", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_clone", staticmethod(fake_clone))

    await Deploy_Pipeline.pipeline_run(d_id)

    assert seen_clone_tokens == [None]


@pytest.mark.asyncio
async def test_pipeline_resume_from_restarts_when_missing_step(client):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    async with pipeline_module.AsyncSessionLocal() as db:
        deploy=await Deploy_Crud.crud_deploy_get_by_d_id(db, d_id)
        assert await Deploy_Pipeline.pipeline_resume_from(d_id, deploy) == "cloning"

    await stub_progress(d_id, error_step="building")
    async with pipeline_module.AsyncSessionLocal() as db:
        deploy=await Deploy_Crud.crud_deploy_get_by_d_id(db, d_id)
        # commit_sha가 없으면 building이라고 적혀 있어도 처음부터 다시 한다
        assert await Deploy_Pipeline.pipeline_resume_from(d_id, deploy) == "cloning"
