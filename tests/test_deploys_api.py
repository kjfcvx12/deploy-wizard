import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

from shared.database import Base, async_engine

from features.deploys.pipeline import Deploy_Pipeline
from features.deploys import pipeline as pipeline_module


@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    # API 테스트에서는 파이프라인을 실제로 돌리지 않는다
    started=[]
    start_steps=[]

    def fake_start(d_id, start_step=None):
        started.append(d_id)
        start_steps.append(start_step)
        return True

    monkeypatch.setattr(Deploy_Pipeline, "pipeline_start", staticmethod(fake_start))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.started=started
        c.start_steps=start_steps
        yield c


@pytest.mark.asyncio
async def test_deploy_create_and_get(client):
    response=await client.post("/api/deploys", json={"repo_url": "https://github.com/kjfcvx12/middle_project_4/"})

    assert response.status_code == 201
    body=response.json()
    assert body["status"] == "queued"
    assert body["repo_url"] == "https://github.com/kjfcvx12/middle_project_4"
    assert client.started == [body["d_id"]]

    response=await client.get(f"/api/deploys/{body['d_id']}")
    assert response.status_code == 200

    response=await client.get("/api/deploys")
    assert [d["d_id"] for d in response.json()] == [body["d_id"]]


# M6 - 생성 시 넘긴 계정 연결이 실제로 저장된다 (services_deploy_create가 Deploy_Create를 다시 만들면서 빠뜨리기 쉽다)
@pytest.mark.asyncio
async def test_deploy_create_persists_account_links(client):
    response=await client.post("/api/deploys", json={
        "repo_url": "https://github.com/o/r", "aws_account_id": 5, "github_installation_id": 9,
    })

    assert response.status_code == 201
    body=response.json()
    assert body["aws_account_id"] == 5
    assert body["github_installation_id"] == 9

    fetched=(await client.get(f"/api/deploys/{body['d_id']}")).json()
    assert fetched["aws_account_id"] == 5
    assert fetched["github_installation_id"] == 9


@pytest.mark.asyncio
async def test_deploy_create_rejects_bad_url(client):
    response=await client.post("/api/deploys", json={"repo_url": "https://evil.example/x/y"})

    assert response.status_code == 400
    assert client.started == []


@pytest.mark.asyncio
async def test_deploy_404(client):
    assert (await client.get("/api/deploys/999")).status_code == 404


# 진행 중에는 다시 배포·삭제를 막는다
@pytest.mark.asyncio
async def test_deploy_conflict_while_running(client):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    assert (await client.post(f"/api/deploys/{d_id}/redeploy")).status_code == 409
    assert (await client.delete(f"/api/deploys/{d_id}")).status_code == 409


# 실패한 파이프라인 -> failed + 한국어 해설 + 로그. AWS 리소스가 없으면 삭제는 DB만 정리한다
@pytest.mark.asyncio
async def test_pipeline_failure_is_explained(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    def fake_clone(repo_url, branch, dest, on_line=None, token=None):
        on_line("Cloning into ...")
        raise pipeline_module.Proc_Error("명령 실패 (exit 128) :git clone", "remote: Repository not found.")

    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_clone", staticmethod(fake_clone))

    await Deploy_Pipeline.pipeline_run(d_id)

    body=(await client.get(f"/api/deploys/{d_id}")).json()
    assert body["status"] == "failed"
    assert body["error_step"] == "cloning"
    assert body["explain"]["source"] == "rule"
    assert "레포" in body["explain"]["summary"]

    logs=(await client.get(f"/api/deploys/{d_id}/logs")).json()
    assert any(log["level"] == "error" for log in logs)

    after=logs[-1]["d_l_id"]
    assert (await client.get(f"/api/deploys/{d_id}/logs", params={"after": after})).json() == []

    assert (await client.delete(f"/api/deploys/{d_id}")).json()["deleted"] == []
    assert (await client.get(f"/api/deploys/{d_id}")).status_code == 404


# M6 - 브랜치 목록 조회도 GitHub 설치가 있으면 그 토큰으로 (private 레포)
@pytest.mark.asyncio
async def test_deploy_get_remote_uses_github_token(client, monkeypatch):
    from features.deploys import services as deploys_services_module

    seen=[]
    async def fake_token(db, g_id):
        seen.append(g_id)
        return "ghs_xyz"

    def fake_remote(repo_url, token=None):
        seen.append(token)
        from features.repos.scheme import Repo_Remote
        return Repo_Remote(default_branch="main", branches=["main"])

    monkeypatch.setattr(deploys_services_module.Github_Service, "services_github_token_by_g_id", staticmethod(fake_token))
    monkeypatch.setattr(deploys_services_module.Repo_Service, "services_repo_remote", staticmethod(fake_remote))

    response=await client.get("/api/deploys/remote", params={"repo_url": "https://github.com/o/r", "github_installation_id": 3})
    assert response.status_code == 200
    assert seen == [3, "ghs_xyz"]


# M6 - 삭제할 때도 연결된 AWS 계정 세션으로 지운다 (개발 세션이 아니라)
@pytest.mark.asyncio
async def test_deploy_delete_uses_connected_aws_account(client, monkeypatch):
    from features.deploys import services as deploys_services_module
    from features.deploys.crud import Deploy_Crud
    from shared.database import AsyncSessionLocal

    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    async with AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d_id, {
            "status": "running", "service_arn": "arn:aws:ecs:...:service/x", "repository_name": "deploy-wizard/x",
            "aws_account_id": 7,
        })
        await db.commit()

    seen=[]
    async def spy_build_session(db, aws_account_id):
        seen.append(aws_account_id)
        return object()

    monkeypatch.setattr(deploys_services_module.Aws_Account_Service, "services_aws_account_build_session", staticmethod(spy_build_session))
    monkeypatch.setattr(deploys_services_module.Express_Service, "services_express_delete", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(deploys_services_module.Express_Service, "services_express_delete_repository", staticmethod(lambda *a, **kw: None))

    response=await client.delete(f"/api/deploys/{d_id}")
    assert response.status_code == 200
    assert seen == [7]


# 멈춤 -> 다시 켜기 -> 삭제. 멈춤은 요금이 나가는 서비스만 내리고 이미지는 남긴다. 다시 켜기는 빌드 없이 배포 단계부터
@pytest.mark.asyncio
async def test_deploy_stop_start_delete(client, monkeypatch):
    from features.deploys import services as deploys_services_module
    from features.deploys.crud import Deploy_Crud
    from shared.database import AsyncSessionLocal

    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    # 아직 안 뜬 배포는 멈출 수도, 다시 켤 수도 없다
    assert (await client.post(f"/api/deploys/{d_id}/stop")).status_code == 409
    assert (await client.post(f"/api/deploys/{d_id}/start")).status_code == 409

    async with AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d_id, {
            "status": "running", "service_arn": "arn:aws:ecs:...:service/x", "service_name": "dw-r-1",
            "endpoint": "https://dw-r-1.ecs.ap-northeast-2.on.aws", "repository_name": "deploy-wizard/r-1",
            "image_uri": "111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/deploy-wizard/r-1:abc1234", "aws_account_id": 7,
        })
        await db.commit()

    seen=[]
    async def spy_build_session(db, aws_account_id):
        seen.append(aws_account_id)
        return object()

    deleted_services, deleted_repos=[], []
    monkeypatch.setattr(deploys_services_module.Aws_Account_Service, "services_aws_account_build_session", staticmethod(spy_build_session))
    monkeypatch.setattr(deploys_services_module.Express_Service, "services_express_delete",
                        staticmethod(lambda session, service_arn: deleted_services.append(service_arn)))
    monkeypatch.setattr(deploys_services_module.Express_Service, "services_express_delete_repository",
                        staticmethod(lambda session, repository_name: deleted_repos.append(repository_name)))

    body=(await client.post(f"/api/deploys/{d_id}/stop")).json()
    assert body["status"] == "stopped"
    assert body["service_arn"] is None and body["endpoint"] is None
    assert body["image_uri"]
    assert deleted_services == ["arn:aws:ecs:...:service/x"] and deleted_repos == []
    assert seen == [7]

    # 이미 멈춘 것을 또 멈출 수 없다
    assert (await client.post(f"/api/deploys/{d_id}/stop")).status_code == 409

    body=(await client.post(f"/api/deploys/{d_id}/start")).json()
    assert body["status"] == "queued"
    assert client.started[-1] == d_id and client.start_steps[-1] == "deploying"

    # 멈춘 상태에서 삭제하면 남겨 둔 이미지 저장소까지 지운다
    async with AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "stopped"})
        await db.commit()

    assert (await client.delete(f"/api/deploys/{d_id}")).status_code == 200
    assert deleted_repos == ["deploy-wizard/r-1"] and len(deleted_services) == 1


# 작업 종료 - 요금이 나가는 것을 모두 멈추되 기록은 남긴다. 보기만(dry_run) 하면 아무것도 건드리지 않는다
@pytest.mark.asyncio
async def test_deploy_session_end(client, monkeypatch):
    from features.deploys import services as deploys_services_module
    from features.deploys.services import Deploy_Service
    from features.deploys.crud import Deploy_Crud
    from shared.database import AsyncSessionLocal

    async def make(**fields):
        d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]
        async with AsyncSessionLocal() as db:
            await Deploy_Crud.crud_deploy_update(db, d_id, fields)
            await db.commit()
        return d_id

    running=await make(status="running", service_arn="arn:svc:1", endpoint="https://a.example", repository_name="deploy-wizard/r-1", image_uri="img:1")
    failed=await make(status="failed", error_step="deploying", service_arn="arn:svc:2", repository_name="deploy-wizard/r-2", image_uri="img:2")
    stopped=await make(status="stopped", repository_name="deploy-wizard/r-3", image_uri="img:3")
    building=await make(status="building")
    idle=await make(status="failed", error_step="cloning")

    async def fake_build_session(db, aws_account_id):
        return object()

    deleted_services, deleted_repos=[], []
    monkeypatch.setattr(deploys_services_module.Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_build_session))
    monkeypatch.setattr(deploys_services_module.Express_Service, "services_express_delete",
                        staticmethod(lambda session, service_arn: deleted_services.append(service_arn)))
    monkeypatch.setattr(deploys_services_module.Express_Service, "services_express_delete_repository",
                        staticmethod(lambda session, repository_name: deleted_repos.append(repository_name)))

    async with AsyncSessionLocal() as db:
        preview=await Deploy_Service.services_deploy_session_end(db, dry_run=True)

    assert len(preview["stopped"]) == 2 and len(preview["purged"]) == 3 and len(preview["in_progress"]) == 1
    assert deleted_services == [] and deleted_repos == []
    assert (await client.get(f"/api/deploys/{running}")).json()["status"] == "running"

    async with AsyncSessionLocal() as db:
        report=await Deploy_Service.services_deploy_session_end(db)

    assert sorted(deleted_services) == ["arn:svc:1", "arn:svc:2"]
    assert sorted(deleted_repos) == ["deploy-wizard/r-1", "deploy-wizard/r-2", "deploy-wizard/r-3"]
    assert report["failed"] == []

    # 떠 있던 것은 stopped 로, 실패한 것은 실패 기록 그대로 - 둘 다 리소스 흔적만 지워진다. 기록은 남아 다시 켤 수 있다
    body=(await client.get(f"/api/deploys/{running}")).json()
    assert body["status"] == "stopped" and body["service_arn"] is None and body["endpoint"] is None and body["image_uri"] is None
    body=(await client.get(f"/api/deploys/{failed}")).json()
    assert body["status"] == "failed" and body["error_step"] == "deploying" and body["service_arn"] is None
    assert (await client.get(f"/api/deploys/{stopped}")).json()["image_uri"] is None
    assert (await client.get(f"/api/deploys/{building}")).json()["status"] == "building"
    assert (await client.get(f"/api/deploys/{idle}")).json()["status"] == "failed"

    # 이미지를 지웠으니 [다시 켜기]는 배포 단계가 아니라 평소 이어하기 규칙(처음부터)으로 간다
    await client.post(f"/api/deploys/{running}/start")
    assert client.start_steps[-1] is None

    # 한 번 더 돌려도 할 일이 없다
    async with AsyncSessionLocal() as db:
        again=await Deploy_Service.services_deploy_session_end(db)
    assert again["stopped"] == [] and again["purged"] == []


# --keep-images - 서비스만 내리고 이미지는 남긴다. [다시 켜기]가 빌드 없이 배포 단계부터 간다
@pytest.mark.asyncio
async def test_deploy_session_end_keep_images(client, monkeypatch):
    from features.deploys import services as deploys_services_module
    from features.deploys.services import Deploy_Service
    from features.deploys.crud import Deploy_Crud
    from shared.database import AsyncSessionLocal

    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]
    async with AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "running", "service_arn": "arn:svc:1", "repository_name": "deploy-wizard/r-1", "image_uri": "img:1"})
        await db.commit()

    async def fake_build_session(db, aws_account_id):
        return object()

    def no_repo_delete(*a, **kw):
        raise AssertionError("--keep-images 면 이미지를 지우면 안 된다")

    monkeypatch.setattr(deploys_services_module.Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_build_session))
    monkeypatch.setattr(deploys_services_module.Express_Service, "services_express_delete", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(deploys_services_module.Express_Service, "services_express_delete_repository", staticmethod(no_repo_delete))

    async with AsyncSessionLocal() as db:
        report=await Deploy_Service.services_deploy_session_end(db, keep_images=True)

    assert len(report["stopped"]) == 1 and report["purged"] == [] and report["failed"] == []
    body=(await client.get(f"/api/deploys/{d_id}")).json()
    assert body["status"] == "stopped" and body["image_uri"] == "img:1"

    await client.post(f"/api/deploys/{d_id}/start")
    assert client.start_steps[-1] == "deploying"


# 다시 켜기는 배포 단계만 돈다 - 클론·빌드·푸시를 건너뛰고 남겨 둔 이미지로 서비스를 새로 만든다
@pytest.mark.asyncio
async def test_pipeline_start_step_deploying_skips_build(client, monkeypatch):
    from features.deploys.crud import Deploy_Crud
    from features.express.scheme import Express_Status
    from shared.database import AsyncSessionLocal

    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    async with AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d_id, {
            "status": "queued", "commit_sha": "a" * 40, "language": "python", "support_level": "official", "app_dir": ".",
            "dockerfile": "FROM python:3.12\n", "dockerfile_source": "template_rule", "port": 8000, "health_check_path": "/",
            "image_uri": "111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/x:abc1234", "repository_name": "deploy-wizard/r-1",
        })
        await db.commit()

    def fail(*_a, **_kw):
        raise AssertionError("다시 켜기에서는 이 단계를 건너뛰어야 한다")

    async def fake_build_session(db, aws_account_id):
        return object()

    created=[]
    def spy_create(session, service_name, image_uri, *a, **kw):
        created.append((service_name, image_uri))
        return Express_Status(service_arn="arn:svc", service_name=service_name)

    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_clone", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Dockerfile_Service, "services_dockerfile_generate", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Dockerfile_Service, "services_dockerfile_write", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_image", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_push", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Build_Service, "services_build_remove_local", staticmethod(lambda *a, **kw: None))
    monkeypatch.setattr(pipeline_module.Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_build_session))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_create", staticmethod(spy_create))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_update", staticmethod(fail))
    monkeypatch.setattr(pipeline_module.Express_Service, "services_express_wait",
                        staticmethod(lambda *a, **kw: Express_Status(service_arn="arn:svc", endpoint="https://x.example")))

    await Deploy_Pipeline.pipeline_run(d_id, "deploying")

    body=(await client.get(f"/api/deploys/{d_id}")).json()
    assert body["status"] == "running" and body["endpoint"] == "https://x.example"
    assert created == [(body["service_name"], "111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/x:abc1234")]


# 서버 재시작으로 끊긴 배포는 failed 로 돌려놓는다
@pytest.mark.asyncio
async def test_pipeline_recover(client):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    assert await Deploy_Pipeline.pipeline_recover() == 1
    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "failed"

    issues=(await client.get(f"/api/deploys/{d_id}/issues")).json()
    assert len(issues) == 1
    assert issues[0]["step"] == "queued"


# 실패할 때마다 문제 이력이 쌓인다 - 다시 배포해도 지난 실패가 남는다
@pytest.mark.asyncio
async def test_pipeline_issue_history_accumulates(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]

    def fake_clone(repo_url, branch, dest, on_line=None, token=None):
        raise pipeline_module.Proc_Error("명령 실패 (exit 128) :git clone", "remote: Repository not found.")

    monkeypatch.setattr(pipeline_module.Repo_Service, "services_repo_clone", staticmethod(fake_clone))

    await Deploy_Pipeline.pipeline_run(d_id)
    await Deploy_Pipeline.pipeline_run(d_id)

    issues=(await client.get(f"/api/deploys/{d_id}/issues")).json()
    assert len(issues) == 2
    assert all(issue["step"] == "cloning" for issue in issues)

    # 배포 자체에는 최신 실패만 보인다
    body=(await client.get(f"/api/deploys/{d_id}")).json()
    assert body["error_step"] == "cloning"
