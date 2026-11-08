import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

from shared.database import Base, async_engine, AsyncSessionLocal

# create_all 이 모든 표를 알도록 모델을 불러 둔다
from features.accounts import models as account_models
from features.envvars import models as envvar_models
from features.deploys.pipeline import Deploy_Pipeline
from features.deploys import pipeline as pipeline_module
from features.deploys.crud import Deploy_Crud
from features.envvars.scheme import Env_Found, Env_Update
from features.envvars.services import Env_Service
from features.express.services import Express_Service
from features.express.scheme import Express_Status
from features.repos.scheme import Repo_Detect
from features.dockerfiles.scheme import Dockerfile_Result

# 환경변수 입력 대기(needs_input) - 첫 배포는 멈추고, 다시 배포는 멈추지 않고, 값은 로그에 나오지 않는다

IMAGE_URI="111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/x:abc1234"
SECRET_VALUE="s3cr3t-value-xyz"


@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    monkeypatch.setattr(Deploy_Pipeline, "pipeline_start", staticmethod(lambda d_id, start_step=None: True))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# 배포 한 건을 만들고 d_id 를 돌려준다
async def make_deploy(client) -> int:
    return (await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]


# 배포의 열을 직접 바꾼다
async def set_deploy(d_id:int, **fields):
    async with AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d_id, fields)
        await db.commit()


# 이전 실행이 남긴 값을 채운다 - 배포 단계부터 이어서 돌릴 수 있는 상태
async def set_built(d_id:int, **fields):
    values=dict(commit_sha="a" * 40, language="python", support_level="official", app_dir=".",
                dockerfile="FROM python:3.12\n", dockerfile_source="template_rule", port=8000,
                health_check_path="/", image_uri=IMAGE_URI, repository_name="deploy-wizard/r-1")
    values.update(fields)
    await set_deploy(d_id, **values)


# 변수 이름을 저장하고, 값이 있으면 config 일반 값으로 입력한다
async def save_env(d_id:int, name:str, required:bool=True, value:str|None=None):
    async with AsyncSessionLocal() as db:
        await Env_Service.services_env_save_found(db, d_id, [
            Env_Found(name=name, required=required, has_default=not required, kind='config', source='code', source_hint='app.py:1')])

    if value is not None:
        async with AsyncSessionLocal() as db:
            await Env_Service.services_env_update(db, d_id, name, Env_Update(value=value))


# 배포 로그 메시지 전부
async def get_logs(d_id:int) -> list:
    async with AsyncSessionLocal() as db:
        return await Deploy_Crud.crud_deploy_log_get_after(db, d_id, 0)


def fail(*_a, **_kw):
    raise AssertionError("이 단계는 건너뛰었어야 한다")


# 계정 연결 없이 개발 세션을 쓰는 것처럼 - AWS를 실제로 부르지 않는다
async def fake_build_session(db, aws_account_id):
    return object()


# AWS·Docker·git 경계를 막는다. 호출을 모아 돌려준다
def stub_boundaries(monkeypatch, found:list[Env_Found]|None=None) -> dict:
    calls={"create": [], "update": [], "remove_local": [], "clone": []}

    def fake_clone(*a, **kw):
        calls["clone"].append(True)
        return "a" * 40

    def fake_create(*a, **kw):
        calls["create"].append(kw)
        return Express_Status(service_arn="arn:svc", service_name="dw-r-1")

    def fake_update(*a, **kw):
        calls["update"].append(kw)

    async def fake_analyze(app_path):
        return list(found or [])

    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_clone", staticmethod(fake_clone))
    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_detect",
                        staticmethod(lambda p: Repo_Detect(language="python", support_level="official", app_dir=".", manifest="requirements.txt")))
    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_normalize", staticmethod(lambda p: []))
    monkeypatch.setattr(pipeline_module.Env_Service, "services_env_analyze", staticmethod(fake_analyze))
    monkeypatch.setattr(pipeline_module.Dockerfile_Service, "services_dockerfile_generate",
                        staticmethod(lambda *a, **kw: _async_result(Dockerfile_Result(dockerfile="FROM python:3.12\n", port=8000, source="template_rule"))))
    monkeypatch.setattr(pipeline_module.Dockerfile_Service, "services_dockerfile_write", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_image", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_push", staticmethod(lambda *a, **kw: IMAGE_URI))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_remove_local",
                        staticmethod(lambda *a, **kw: calls["remove_local"].append(True)))
    monkeypatch.setattr(pipeline_module.Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_build_session))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_create", staticmethod(fake_create))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_update", staticmethod(fake_update))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_wait",
                        staticmethod(lambda *a, **kw: Express_Status(service_arn="arn:svc", endpoint="https://x.example")))
    return calls


# 코루틴을 돌려주는 가짜 (generate 는 async 함수다)
async def _async_result(value):
    return value


@pytest.mark.asyncio
async def test_pipeline_pauses_at_needs_input_before_deploying(client, monkeypatch):
    d_id=await make_deploy(client)
    calls=stub_boundaries(monkeypatch, [Env_Found(name="DATABASE_URL", required=True, has_default=False,
                                                  kind="config", source="code", source_hint="app.py:1")])

    await Deploy_Pipeline.pipeline_run(d_id)

    body=(await client.get(f"/api/deploys/{d_id}")).json()
    assert body["status"] == "needs_input"
    assert body["error_msg"] is None and body["error_step"] is None
    assert body["env_pending"] == 1
    assert calls["create"] == [] and calls["update"] == []
    # 이미지는 그대로 남겨 [이어서 배포]가 빌드 없이 끝나게 한다
    assert calls["remove_local"] == []

    logs=await get_logs(d_id)
    assert any(l.level == "warn" and l.message == "환경변수 입력이 필요합니다 :DATABASE_URL" for l in logs)
    assert any(l.message == "환경변수 1개를 찾았습니다 (필수 1개)" for l in logs)


@pytest.mark.asyncio
async def test_pipeline_continue_deploys_with_environment(client, monkeypatch):
    d_id=await make_deploy(client)
    await set_built(d_id, status="queued")
    await save_env(d_id, "LOG_LEVEL", value="info")
    calls=stub_boundaries(monkeypatch)

    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_clone", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_image", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_push", staticmethod(fail))

    await Deploy_Pipeline.pipeline_run(d_id, "deploying")

    assert len(calls["create"]) == 1
    assert calls["create"][0]["environment"] == {"LOG_LEVEL": "info"}
    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "running"


@pytest.mark.asyncio
async def test_pipeline_deploys_without_env_vars_passes_no_environment(client, monkeypatch):
    d_id=await make_deploy(client)
    calls=stub_boundaries(monkeypatch)

    await Deploy_Pipeline.pipeline_run(d_id)

    assert calls["create"][0]["environment"] is None
    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "running"


@pytest.mark.asyncio
async def test_pipeline_redeploy_does_not_pause_and_resends_env(client, monkeypatch):
    d_id=await make_deploy(client)
    await set_built(d_id, status="queued", service_arn="arn:svc")
    await save_env(d_id, "LOG_LEVEL", value="info")
    await save_env(d_id, "API_URL")
    calls=stub_boundaries(monkeypatch)

    await Deploy_Pipeline.pipeline_run(d_id, "deploying")

    assert calls["create"] == []
    assert len(calls["update"]) == 1
    assert calls["update"][0]["environment"] == {"LOG_LEVEL": "info"}
    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "running"

    logs=await get_logs(d_id)
    assert any(l.level == "warn" and "API_URL" in l.message for l in logs)


@pytest.mark.asyncio
async def test_pipeline_continue_after_image_purged_rebuilds_from_start(client, monkeypatch):
    d_id=await make_deploy(client)
    await set_built(d_id, status="queued", image_uri=None, repository_name=None)
    await save_env(d_id, "LOG_LEVEL", value="info")
    calls=stub_boundaries(monkeypatch)

    await Deploy_Pipeline.pipeline_run(d_id, "deploying")

    # 작업 종료로 이미지를 지웠으면 배포 단계만 돌릴 수 없다 - 처음부터 다시 만든다
    assert calls["clone"] == [True]
    assert calls["create"][0]["environment"] == {"LOG_LEVEL": "info"}


# 가짜 세션 - update_express_gateway_service 에 넘어온 인자를 모은다
class Fake_Ecs:

    def __init__(self):
        self.update_kwargs=[]

    def update_express_gateway_service(self, **kwargs):
        self.update_kwargs.append(kwargs)


class Fake_Session:

    def __init__(self):
        self.ecs=Fake_Ecs()

    def client(self, name):
        return self.ecs


def test_express_update_sends_environment_only_when_present():
    session=Fake_Session()

    Express_Service.services_express_update(session, "arn:svc", IMAGE_URI, 8000, "/", environment={"LOG_LEVEL": "info"})
    Express_Service.services_express_update(session, "arn:svc", IMAGE_URI, 8000, "/")
    Express_Service.services_express_update(session, "arn:svc", IMAGE_URI, 8000, "/", environment={})

    with_env, without_env, empty_env=session.ecs.update_kwargs
    assert with_env["primaryContainer"]["environment"] == [{"name": "LOG_LEVEL", "value": "info"}]
    assert "environment" not in without_env["primaryContainer"]
    assert "environment" not in empty_env["primaryContainer"]


@pytest.mark.asyncio
async def test_recover_leaves_needs_input_alone(client):
    waiting=await make_deploy(client)
    building=await make_deploy(client)
    await set_deploy(waiting, status="needs_input")
    await set_deploy(building, status="building")

    assert await Deploy_Pipeline.pipeline_recover() == 1

    waiting_body=(await client.get(f"/api/deploys/{waiting}")).json()
    assert waiting_body["status"] == "needs_input" and waiting_body["error_msg"] is None
    assert (await client.get(f"/api/deploys/{building}")).json()["status"] == "failed"


@pytest.mark.asyncio
async def test_pipeline_logs_never_contain_values(client, monkeypatch):
    d_id=await make_deploy(client)
    await save_env(d_id, "LOG_LEVEL", value=SECRET_VALUE)
    await save_env(d_id, "API_URL")
    calls=stub_boundaries(monkeypatch, [
        Env_Found(name="LOG_LEVEL", required=True, has_default=False, kind="config", source="code", source_hint="app.py:1"),
        Env_Found(name="API_URL", required=True, has_default=False, kind="config", source="code", source_hint="app.py:2")])

    # 값이 없는 API_URL 때문에 멈춘 뒤, 값을 넣고 이어서 배포한다
    await Deploy_Pipeline.pipeline_run(d_id)
    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "needs_input"

    async with AsyncSessionLocal() as db:
        await Env_Service.services_env_update(db, d_id, "API_URL", Env_Update(value=SECRET_VALUE + "-2"))

    await Deploy_Pipeline.pipeline_run(d_id, "deploying")

    assert calls["create"][0]["environment"]["LOG_LEVEL"] == SECRET_VALUE
    logs=await get_logs(d_id)
    assert logs
    assert not any(SECRET_VALUE in l.message for l in logs)


@pytest.mark.asyncio
async def test_session_end_purges_needs_input_leftovers(client, monkeypatch):
    from features.deploys import services as deploys_services_module
    from features.deploys.services import Deploy_Service

    d_id=await make_deploy(client)
    await set_deploy(d_id, status="needs_input", repository_name="deploy-wizard/r-1", image_uri=IMAGE_URI)

    deleted_repos=[]
    monkeypatch.setattr(deploys_services_module.Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_build_session))
    monkeypatch.setattr(deploys_services_module.Express_Service, "services_express_delete_repository",
                        staticmethod(lambda session, repository_name: deleted_repos.append(repository_name)))

    async with AsyncSessionLocal() as db:
        preview=await Deploy_Service.services_deploy_session_end(db, dry_run=True)

    assert len(preview["purged"]) == 1 and preview["in_progress"] == []
    assert deleted_repos == []

    async with AsyncSessionLocal() as db:
        report=await Deploy_Service.services_deploy_session_end(db)

    assert deleted_repos == ["deploy-wizard/r-1"] and report["failed"] == []
    body=(await client.get(f"/api/deploys/{d_id}")).json()
    assert body["status"] == "needs_input" and body["image_uri"] is None
