import re
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from shared.database import Base, async_engine, AsyncSessionLocal
from shared.settings import settings

from features.deploys.pipeline import Deploy_Pipeline

from auth_helpers import make_user, auth_header


# 로그인 계획 Task 5 - 배포·환경변수·인시던트 소유권 (남의 것은 404, 백그라운드는 그대로)

ROOT=Path(__file__).resolve().parent.parent


@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app
    from features.accounts.services import Aws_Account_Service, Github_Service
    from features.express.services import Express_Service

    monkeypatch.setattr(settings, "auth_enabled", False)

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    # 파이프라인·AWS·GitHub 는 가짜 - 불린 것만 적는다
    calls=[]

    def fake_start(d_id, start_step=None):
        calls.append(("pipeline", d_id))
        return True

    async def fake_build(db, aws_account_id):
        calls.append(("aws_session", aws_account_id))
        return "FAKE_SESSION"

    async def fake_token(db, g_id):
        calls.append(("github_token", g_id))
        return "ghs_fake"

    def fake_express(*args, **kwargs):
        calls.append(("express", args[1:]))

    monkeypatch.setattr(Deploy_Pipeline, "pipeline_start", staticmethod(fake_start))
    monkeypatch.setattr(Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_build))
    monkeypatch.setattr(Github_Service, "services_github_token_by_g_id", staticmethod(fake_token))
    monkeypatch.setattr(Express_Service, "services_express_delete", staticmethod(fake_express))
    monkeypatch.setattr(Express_Service, "services_express_delete_repository", staticmethod(fake_express))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.calls=calls
        yield c


# 사용자 A·B 를 만들고 켬 모드로 바꾼다 - 반환: (A, B)
async def users_on(monkeypatch) -> tuple[int, int]:
    async with AsyncSessionLocal() as db:
        a=await make_user(db, "a@example.com")
        b=await make_user(db, "b@example.com")

    monkeypatch.setattr(settings, "auth_enabled", True)
    return a, b


# 배포 행을 바로 만든다 (파이프라인 없이) - 반환: d_id
async def deploy_make(u_id:int|None, **values) -> int:
    from features.deploys.models import Deploy

    async with AsyncSessionLocal() as db:
        db_deploy=Deploy(repo_url="https://github.com/o/r", status=values.pop("status", "running"), u_id=u_id, **values)
        db.add(db_deploy)
        await db.commit()
        return db_deploy.d_id


# 사용자의 AWS 계정·GitHub 설치를 만든다 - 반환: (a_id, g_id)
async def accounts_make(u_id:int|None, installation_id:int=111) -> tuple[int, int]:
    from features.accounts.models import Aws_Account, Github_Installation

    async with AsyncSessionLocal() as db:
        account=Aws_Account(label="mine", external_id_encrypted="x", u_id=u_id)
        installation=Github_Installation(installation_id=installation_id, account_login="someone", u_id=u_id)
        db.add_all([account, installation])
        await db.commit()
        return account.a_id, installation.g_id


# 배포 수
async def deploy_count() -> int:
    from features.deploys.models import Deploy

    async with AsyncSessionLocal() as db:
        return len((await db.execute(select(Deploy))).scalars().all())


# 목록은 내 것만
@pytest.mark.asyncio
async def test_ownership_deploy_list_only_mine(client, monkeypatch):
    a, b=await users_on(monkeypatch)
    a1=await deploy_make(a)
    a2=await deploy_make(a)
    b1=await deploy_make(b)

    mine=await client.get("/api/deploys", headers=auth_header(a))
    assert mine.status_code == 200
    assert sorted(d["d_id"] for d in mine.json()) == sorted([a1, a2])

    theirs=await client.get("/api/deploys", headers=auth_header(b))
    assert [d["d_id"] for d in theirs.json()] == [b1]


ROUTES_404=[
    ("GET", "/api/deploys/{d_id}", None),
    ("GET", "/api/deploys/{d_id}/logs", None),
    ("GET", "/api/deploys/{d_id}/issues", None),
    ("GET", "/api/deploys/{d_id}/health", None),
    ("GET", "/api/deploys/{d_id}/health-history", None),
    ("PATCH", "/api/deploys/{d_id}/settings", {"auto_redeploy": False}),
    ("POST", "/api/deploys/{d_id}/redeploy", None),
    ("POST", "/api/deploys/{d_id}/env/continue", None),
    ("POST", "/api/deploys/{d_id}/stop", None),
    ("POST", "/api/deploys/{d_id}/start", None),
    ("DELETE", "/api/deploys/{d_id}", None),
    ("GET", "/api/deploys/{d_id}/env", None),
    ("PUT", "/api/deploys/{d_id}/env/X", {"kind": "config", "value": "v2"}),
    ("DELETE", "/api/deploys/{d_id}/env/X/value", None),
    ("GET", "/api/deploys/{d_id}/incidents", None),
    ("GET", "/api/incidents/{i_id}", None),
]


# d_id 를 받는 모든 라우트 - B 의 토큰으로 A 의 id 는 404, 가짜 파이프라인·AWS 는 불리지 않고 A 의 것은 그대로
@pytest.mark.asyncio
@pytest.mark.parametrize("method,path,body", ROUTES_404)
async def test_ownership_deploy_routes_404_for_other(client, monkeypatch, method, path, body):
    from features.incidents.crud import Incident_Crud
    from features.envvars.crud import Env_Crud
    from features.envvars.scheme import Env_Found
    from features.deploys.models import Deploy

    a, b=await users_on(monkeypatch)
    d_id=await deploy_make(a, service_arn="arn:aws:ecs:ap-northeast-2:111111111111:service/x", repository_name="repo-x",
                           endpoint="http://a.invalid", image_uri="img")

    async with AsyncSessionLocal() as db:
        await Env_Crud.crud_env_upsert_found(db, d_id, Env_Found(name="X", required=True, has_default=False, kind="config", source="user", source_hint=None))
        incident=await Incident_Crud.crud_incident_create(db, d_id, "unhealthy", "요약")
        await db.commit()
        i_id=incident.i_id

    url=path.format(d_id=d_id, i_id=i_id)
    response=await client.request(method, url, json=body, headers=auth_header(b))

    assert response.status_code == 404, response.text
    assert client.calls == []

    # A 의 배포는 그대로 (멈추거나 지워지지 않았다)
    async with AsyncSessionLocal() as db:
        deploy=await db.get(Deploy, d_id)
        assert deploy.status == "running" and deploy.auto_redeploy is True

    # A 는 같은 경로가 404 가 아니다 (읽기 경로만 확인)
    if method == "GET" and "/health" not in url:
        assert (await client.get(url, headers=auth_header(a))).status_code == 200


# 인시던트 전체 목록도 내 배포 것만 - 남의 d_id 로 걸러도 비어 있다
@pytest.mark.asyncio
async def test_ownership_incident_list_only_mine(client, monkeypatch):
    from features.incidents.crud import Incident_Crud

    a, b=await users_on(monkeypatch)
    d_a=await deploy_make(a)
    d_b=await deploy_make(b)

    async with AsyncSessionLocal() as db:
        i_a=(await Incident_Crud.crud_incident_create(db, d_a, "unhealthy", "a")).i_id
        i_b=(await Incident_Crud.crud_incident_create(db, d_b, "unhealthy", "b")).i_id
        await db.commit()

    assert [i["i_id"] for i in (await client.get("/api/incidents", headers=auth_header(a))).json()] == [i_a]
    assert [i["i_id"] for i in (await client.get("/api/incidents", headers=auth_header(b))).json()] == [i_b]
    assert (await client.get(f"/api/incidents?d_id={d_a}", headers=auth_header(b))).json() == []


# 남의 AWS 계정·GitHub 설치로 만들기·분석·브랜치 조회 - 404, 배포 행이 생기지 않고 A 의 자격증명이 쓰이지 않는다
@pytest.mark.asyncio
async def test_ownership_create_with_others_account_404(client, monkeypatch):
    from features.repos.services import Repo_Service

    a, b=await users_on(monkeypatch)
    a_id, g_id=await accounts_make(a)

    # 레포를 읽으려 하면 실패로 드러나게
    def no_repo(*args, **kwargs):
        raise AssertionError("레포를 읽으면 안 된다")

    monkeypatch.setattr(Repo_Service, "services_repo_commit_sha", staticmethod(no_repo))
    monkeypatch.setattr(Repo_Service, "services_repo_remote", staticmethod(no_repo))
    monkeypatch.setattr(Repo_Service, "services_repo_clone", staticmethod(no_repo))

    for extra in ({"aws_account_id": a_id}, {"github_installation_id": g_id}, {"aws_account_id": a_id, "github_installation_id": g_id}):
        body={"repo_url": "https://github.com/o/r", **extra}

        created=await client.post("/api/deploys", json=body, headers=auth_header(b))
        assert created.status_code == 404, created.text

        advice=await client.post("/api/deploys/advice", json=body, headers=auth_header(b))
        assert advice.status_code == 404, advice.text

    remote=await client.get("/api/deploys/remote", params={"repo_url": "https://github.com/o/r", "github_installation_id": g_id}, headers=auth_header(b))
    assert remote.status_code == 404, remote.text

    # 없는 id 도 404
    assert (await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r", "aws_account_id": 9999}, headers=auth_header(b))).status_code == 404

    assert await deploy_count() == 0
    assert client.calls == []

    # A 자신은 만들 수 있다
    mine=await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r", "aws_account_id": a_id, "github_installation_id": g_id}, headers=auth_header(a))
    assert mine.status_code == 201, mine.text


# 만든 배포의 주인은 만든 사용자
@pytest.mark.asyncio
async def test_ownership_create_sets_u_id(client, monkeypatch):
    from features.deploys.models import Deploy

    a, b=await users_on(monkeypatch)

    created=await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"}, headers=auth_header(a))
    assert created.status_code == 201, created.text

    async with AsyncSessionLocal() as db:
        deploy=await db.get(Deploy, created.json()["d_id"])
        assert deploy.u_id == a

    assert client.calls == [("pipeline", created.json()["d_id"])]


# 끔 모드 - 주인 없는(u_id null) 배포·남의 배포까지 지금처럼 전부 보인다
@pytest.mark.asyncio
async def test_ownership_off_mode_unchanged(client, monkeypatch):
    async with AsyncSessionLocal() as db:
        a=await make_user(db, "a@example.com")

    d_none=await deploy_make(None)
    d_a=await deploy_make(a)

    listed=await client.get("/api/deploys")
    assert listed.status_code == 200
    assert sorted(d["d_id"] for d in listed.json()) == sorted([d_none, d_a])
    assert (await client.get(f"/api/deploys/{d_a}")).status_code == 200
    assert (await client.get(f"/api/deploys/{d_none}/env")).status_code == 200

    created=await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})
    assert created.status_code == 201

    from features.deploys.models import Deploy
    async with AsyncSessionLocal() as db:
        assert (await db.get(Deploy, created.json()["d_id"])).u_id is None


# 켬 모드에서도 백그라운드(파이프라인·헬스·감시·복구)는 주인 인자 없이 부르고 모든 배포를 본다
@pytest.mark.asyncio
async def test_ownership_background_paths_unfiltered(client, monkeypatch):
    from features.deploys.crud import Deploy_Crud
    from features.deploys.services import Deploy_Service

    a, b=await users_on(monkeypatch)
    d_a=await deploy_make(a)
    d_b=await deploy_make(b)

    async with AsyncSessionLocal() as db:
        assert sorted(d.d_id for d in await Deploy_Crud.crud_deploy_get_all(db)) == sorted([d_a, d_b])
        assert (await Deploy_Service.services_deploy_get_d_id(db, d_b)).d_id == d_b
        assert sorted(d.d_id for d in await Deploy_Service.services_deploy_get_pollable(db)) == sorted([d_a, d_b])

    # 백그라운드 코드는 주인을 넘기지 않는다
    for rel in ("features/deploys/pipeline.py", "features/watches/services.py",
                "features/incidents/recovery.py", "features/incidents/recovery_state.py"):
        source=(ROOT / rel).read_text(encoding="utf-8")
        assert not re.search(r"\bu_id\b", source), rel


# 모든 표는 u_id 를 갖거나 FK 사슬로 그런 표에 닿는다 - 새 표가 소유권을 잊으면 실패한다
def test_ownership_table_coverage():
    import main  # noqa: F401 - 모든 모델을 Base.metadata 에 올린다

    tables=Base.metadata.tables

    # 표가 주인을 갖는가 - u_id 열이 있거나 FK 로 가리키는 표가 주인을 갖는다
    def owned(name:str, seen:frozenset=frozenset()) -> bool:
        if name in seen:
            return False
        table=tables[name]
        if "u_id" in table.columns:
            return True
        return any(owned(fk.column.table.name, seen | {name}) for fk in table.foreign_keys)

    assert len(tables) > 10
    missing=[name for name in tables if name != "users" and not owned(name)]
    assert missing == [], "소유권이 빠진 표: " + ", ".join(sorted(missing))
