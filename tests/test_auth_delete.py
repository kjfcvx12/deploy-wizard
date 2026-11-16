import sqlite3

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text, update

from shared.database import Base, async_engine, AsyncSessionLocal
from shared.secrets import blind_index
from shared.settings import settings

from features.accounts import services as accounts_module
from features.auth import google as google_module
from features.auth.google import Google_Identity
from features.auth.crud import Auth_Crud
from features.deploys.models import Deploy, Deploy_Log, Deploy_Issue, Deploy_Release
from features.deploys.pipeline import Deploy_Pipeline
from features.deploys.services import Deploy_Service
from features.envvars.models import Deploy_Env_Var
from features.health.models import Health_Check
from features.incidents.models import Incident, Recovery_Action
from features.accounts.models import Aws_Account, Github_Installation, Connection
from features.notifications.models import Notification, Push_Device, Notification_Setting

from auth_helpers import make_user, auth_header


# 로그인 계획 Task 9 - 계정 삭제 (DELETE /api/me). 기록만 지우고 AWS·GitHub 는 한 번도 부르지 않는다 (Hard rule 3)

MESSAGE_LIVE="먼저 멈추거나 삭제해야 하는 서비스가 있습니다"
MESSAGE_CONFIRM="계정을 삭제하려면 confirm 에 true 를 보내야 합니다"
MESSAGE_PAT_DELETE="개인 토큰으로는 계정을 삭제할 수 없습니다. 로그인한 앱이나 웹에서 삭제해 주세요"
MESSAGE_BUSY="지금 다른 작업이 DB를 쓰고 있습니다. 잠시 뒤 다시 시도해 주세요"

# 표 이름 -> 기록 수를 세는 대상 (계정 삭제가 건드려야 하거나 건드리면 안 되는 표 전부)
TABLES=("deploys", "deploy_logs", "deploy_issues", "deploy_releases", "deploy_env_vars", "health_checks", "incidents", "recovery_actions",
        "connections", "aws_accounts", "github_installations", "notifications", "push_devices", "notification_settings")

IDENTITY=Google_Identity(sub="google-sub-del", email="me@example.com", name="나", picture_url="https://example.com/me.png")


# 가짜 Google 검증기 - 항상 같은 사용자 정보
class Fake_Verifier:

    async def verifier_google_verify(self, id_token:str, client_ids:set[str]) -> Google_Identity:
        return IDENTITY


@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app
    from features.accounts.services import Aws_Account_Service, Github_Service
    from features.express.services import Express_Service

    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "auth_allowed_emails", "me@example.com")
    monkeypatch.setattr(settings, "google_client_id_android", "android-client-id")
    monkeypatch.setattr(google_module, "GOOGLE_VERIFIER", Fake_Verifier())

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    # 파이프라인·AWS·GitHub 는 가짜 - 불린 것이 하나라도 있으면 시험이 실패한다 (이 작업은 AWS·GitHub 호출 0번)
    calls=[]

    def fake_call(name):
        def call(*args, **kwargs):
            calls.append(name)
            return "FAKE"
        return call

    async def fake_async_call(*args, **kwargs):
        calls.append("async")
        return "FAKE"

    class Fake_Http:
        def __init__(self, *args, **kwargs):
            calls.append("httpx")

    monkeypatch.setattr(Deploy_Pipeline, "pipeline_start", staticmethod(fake_call("pipeline_start")))
    monkeypatch.setattr(Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_async_call))
    monkeypatch.setattr(Github_Service, "services_github_token_by_g_id", staticmethod(fake_async_call))
    for name in ("services_express_delete", "services_express_delete_repository", "services_express_update", "services_express_describe", "services_express_wait"):
        monkeypatch.setattr(Express_Service, name, staticmethod(fake_call(name)))
    monkeypatch.setattr(accounts_module, "get_account_id", fake_call("get_account_id"))
    monkeypatch.setattr(accounts_module, "get_assumed_session", fake_call("get_assumed_session"))
    monkeypatch.setattr(accounts_module, "get_aws_session", fake_call("get_aws_session"))
    monkeypatch.setattr(accounts_module.httpx, "AsyncClient", Fake_Http)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.calls=calls
        yield c


# 앱으로 로그인 (가짜 Google) - 응답 본문
async def login_app(client) -> dict:
    response=await client.post("/api/auth/google", json={"id_token": "good-token", "platform": "android"})
    assert response.status_code == 200, response.text
    return response.json()


# 개인 토큰 발급 - 원문
async def pat_issue(client, access:str) -> str:
    response=await client.post("/api/auth/tokens", json={"name": "mcp"}, headers={"Authorization": f"Bearer {access}"})
    assert response.status_code == 201, response.text
    return response.json()["token"]


# 계정 삭제 요청
async def delete_me(client, headers:dict, body=None):
    return await client.request("DELETE", "/api/me", json=body if body is not None else {"confirm": True}, headers=headers)


# 사용자의 기록 한 벌 - 멈춘 배포(로그·이슈·릴리스·환경변수·헬스·인시던트·복구 기록 딸림)·삭제한 배포·서비스 없는 실패 + 연결·AWS 계정·GitHub 설치 + 알림·기기·설정
async def seed(u_id:int, tag:str, extra_deploys:list[dict] | None=None) -> list[int]:
    async with AsyncSessionLocal() as db:
        db_aws=Aws_Account(u_id=u_id, label=f"aws-{tag}", external_id_encrypted="x", role_arn="arn:aws:iam::111111111111:role/R", status="verified")
        db_gh=Github_Installation(u_id=u_id, installation_id=abs(hash(tag)) % 1000000 + 1, account_login=f"login-{tag}")
        db.add_all([db_aws, db_gh])
        await db.flush()
        db.add(Connection(u_id=u_id, label=f"block-{tag}", aws_account_id=db_aws.a_id, github_installation_id=db_gh.g_id))

        deploys=[Deploy(u_id=u_id, repo_url=f"https://github.com/o/{tag}-stopped", status="stopped", service_name=f"{tag}-stopped", repository_name=f"repo-{tag}",
                        aws_account_id=db_aws.a_id, github_installation_id=db_gh.g_id),
                 Deploy(u_id=u_id, repo_url=f"https://github.com/o/{tag}-deleted", status="deleted"),
                 Deploy(u_id=u_id, repo_url=f"https://github.com/o/{tag}-failed", status="failed", service_arn=None)]
        deploys+=[Deploy(u_id=u_id, **item) for item in (extra_deploys or [])]
        db.add_all(deploys)
        await db.flush()

        first=deploys[0]
        db_release=Deploy_Release(d_id=first.d_id, image_uri="img:1", state="current")
        db_incident=Incident(d_id=first.d_id, kind="unhealthy", status="resolved")
        db.add_all([Deploy_Log(d_id=first.d_id, step="build", message="hi"), Deploy_Issue(d_id=first.d_id, step="build", error_msg="x"),
                    db_release, db_incident,
                    Deploy_Env_Var(d_id=first.d_id, name="A", source="code"), Health_Check(d_id=first.d_id, ok=True)])
        await db.flush()
        db.add_all([Recovery_Action(i_id=db_incident.i_id, action="restart", d_r_id=db_release.d_r_id),
                    Notification(u_id=u_id, d_id=first.d_id, i_id=db_incident.i_id, kind="incident_opened", channel="inapp", title="t", body="b"),
                    Push_Device(u_id=u_id, expo_token=f"ExponentPushToken[{tag}]", platform="android"),
                    Notification_Setting(u_id=u_id)])
        await db.commit()
        return [d.d_id for d in deploys]


# 표마다 기록 수 - 계정 삭제 전후를 견주는 데 쓴다
async def counts() -> dict:
    async with async_engine.begin() as conn:
        return {name: (await conn.execute(text(f"SELECT COUNT(*) FROM {name}"))).scalar() for name in TABLES}


# raw SQL 한 줄 실행
async def sql(query:str, **params):
    async with async_engine.begin() as conn:
        result=await conn.execute(text(query), params)
        return result.fetchall() if result.returns_rows else None


# 사용자 행 한 줄 (raw) - 암호화된 열은 암호문 그대로라 상태·인덱스만 본다
async def user_row(u_id:int):
    async with async_engine.begin() as conn:
        return (await conn.execute(text("SELECT status, name, picture_url, google_sub_bidx, email_bidx FROM users WHERE u_id=:u"), {"u": u_id})).first()


# 확인 본문이 없거나 true 가 아니면 400 - 아무것도 지워지지 않는다
@pytest.mark.asyncio
@pytest.mark.parametrize("body", [None, {}, {"confirm": False}, {"confirm": "true"}, {"confirm": 1}, {"confirm": None}, {"other": True}, [True], "raw-text"])
async def test_delete_me_requires_confirm(client, body):
    login=await login_app(client)
    headers={"Authorization": f"Bearer {login['access_token']}"}
    await seed(login["user"]["u_id"], "a")
    before=await counts()

    if body is None:
        response=await client.request("DELETE", "/api/me", headers=headers)
    else:
        response=await client.request("DELETE", "/api/me", json=body, headers=headers)

    assert response.status_code == 400, response.text
    assert response.json()["detail"] == MESSAGE_CONFIRM
    assert await counts() == before
    assert (await user_row(login["user"]["u_id"]))[0] == "active"
    assert (await client.get("/api/me", headers=headers)).status_code == 200


# 본문이 깨진 JSON 이어도 422 가 아니라 400
@pytest.mark.asyncio
async def test_delete_me_confirm_rejects_broken_json(client):
    login=await login_app(client)
    headers={"Authorization": f"Bearer {login['access_token']}", "Content-Type": "application/json"}

    response=await client.request("DELETE", "/api/me", content=b"{not json", headers=headers)

    assert response.status_code == 400
    assert response.json()["detail"] == MESSAGE_CONFIRM


# 로그인이 없으면 401, 개인 토큰으로는 403 - 어느 쪽도 아무것도 지워지지 않는다
@pytest.mark.asyncio
async def test_delete_me_requires_login_and_rejects_pat(client):
    login=await login_app(client)
    await seed(login["user"]["u_id"], "a")
    before=await counts()

    assert (await client.request("DELETE", "/api/me", json={"confirm": True})).status_code == 401
    assert (await client.request("DELETE", "/api/me", json={"confirm": True}, headers={"Authorization": "Bearer nope"})).status_code == 401

    pat=await pat_issue(client, login["access_token"])
    response=await delete_me(client, {"Authorization": f"Bearer {pat}"})

    assert response.status_code == 403
    assert response.json()["detail"] == MESSAGE_PAT_DELETE
    assert await counts() == before
    assert (await user_row(login["user"]["u_id"]))[0] == "active"
    assert client.calls == []


# 살아 있는 배포가 있으면 409 - 목록에 d_id 와 이름이 있고 아무것도 지워지지 않는다
@pytest.mark.asyncio
@pytest.mark.parametrize("live", [{"status": "running", "service_arn": "arn:aws:ecs:x"}, {"status": "queued"}, {"status": "cloning"}, {"status": "analyzing"},
                                  {"status": "generating"}, {"status": "building"}, {"status": "pushing"}, {"status": "deploying"},
                                  {"status": "needs_input"}, {"status": "deleting"}, {"status": "failed", "service_arn": "arn:aws:ecs:x"}])
async def test_delete_me_blocked_by_live_deploy(client, live):
    login=await login_app(client)
    u_id=login["user"]["u_id"]
    d_ids=await seed(u_id, "a", [{"repo_url": "https://github.com/o/live", "service_name": "live-svc", **live}])
    live_id=d_ids[-1]
    await pat_issue(client, login["access_token"])
    before=await counts()
    updated_before=(await sql("SELECT updated_at FROM users WHERE u_id=:u", u=u_id))[0][0]

    response=await delete_me(client, {"Authorization": f"Bearer {login['access_token']}"})

    assert response.status_code == 409, response.text
    detail=response.json()["detail"]
    assert detail.startswith(MESSAGE_LIVE)
    assert f"#{live_id} live-svc" in detail
    assert await counts() == before
    assert (await user_row(u_id))[0] == "active"
    # 막힌 요청은 잠금 쓰기와 토큰 폐기까지 전부 되돌린다
    assert (await sql("SELECT COUNT(*) FROM refresh_tokens WHERE revoked_at IS NULL"))[0][0] == 1
    assert (await sql("SELECT COUNT(*) FROM api_tokens WHERE revoked_at IS NULL"))[0][0] == 1
    assert (await sql("SELECT updated_at FROM users WHERE u_id=:u", u=u_id))[0][0] == updated_before
    assert client.calls == []


# 다른 사용자의 살아 있는 배포는 막지 않고, 서비스 없는 실패·멈춤·삭제는 막지 않는다
@pytest.mark.asyncio
async def test_delete_me_ignores_other_users_live_deploy(client):
    login=await login_app(client)
    other=await make_user_other()
    await seed(other, "b", [{"repo_url": "https://github.com/o/b-live", "status": "running", "service_arn": "arn:aws:ecs:b"}])
    await seed(login["user"]["u_id"], "a")

    response=await delete_me(client, {"Authorization": f"Bearer {login['access_token']}"})

    assert response.status_code == 200, response.text


# 다른 사용자 하나 만들기
async def make_user_other() -> int:
    async with AsyncSessionLocal() as db:
        return await make_user(db, "other@example.com")


# 기록만 지운다 - 모든 표가 비고, AWS·GitHub 호출 0번, 쓰던 토큰은 모두 401, 같은 Google 계정은 새 사용자로 다시 가입한다
@pytest.mark.asyncio
async def test_delete_me_forgets_records_only(client):
    login=await login_app(client)
    u_id=login["user"]["u_id"]
    access, refresh=login["access_token"], login["refresh_token"]
    pat=await pat_issue(client, access)
    await seed(u_id, "a")
    assert all(value > 0 for name, value in (await counts()).items() if name != "notification_settings") and (await counts())["notification_settings"] == 1

    response=await delete_me(client, {"Authorization": f"Bearer {access}"})

    assert response.status_code == 200, response.text
    assert "AWS CloudFormation 스택과 GitHub 앱 설치는 직접 지워 주세요" in response.json()["message"]
    assert await counts() == {name: 0 for name in TABLES}
    assert response.json()["leftover_ecr_repositories"] == ["repo-a"]
    assert client.calls == []

    # 사용자 행은 남기되 개인 정보는 없다
    status_, name, picture, sub_bidx, email_bidx=await user_row(u_id)
    assert status_ == "deleted"
    assert name is None and picture is None
    assert sub_bidx == email_bidx == blind_index("deleted", str(u_id))
    async with AsyncSessionLocal() as db:
        db_user=await Auth_Crud.crud_user_get_by_u_id(db, u_id)
        assert db_user.google_sub == "deleted" and db_user.email == "deleted"
    async with async_engine.begin() as conn:
        raw=(await conn.execute(text("SELECT google_sub, email FROM users WHERE u_id=:u"), {"u": u_id})).first()
        assert "deleted" not in raw[0] and "deleted" not in raw[1] and "me@example.com" not in raw[1]
        assert (await conn.execute(text("SELECT COUNT(*) FROM refresh_tokens WHERE u_id=:u AND revoked_at IS NULL"), {"u": u_id})).scalar() == 0
        assert (await conn.execute(text("SELECT COUNT(*) FROM api_tokens WHERE u_id=:u AND revoked_at IS NULL"), {"u": u_id})).scalar() == 0

    # 쓰던 액세스·리프레시·개인 토큰 모두 쓸 수 없다
    assert (await client.get("/api/me", headers={"Authorization": f"Bearer {access}"})).status_code == 401
    assert (await client.get("/api/me", headers={"Authorization": f"Bearer {pat}"})).status_code == 401
    assert (await client.post("/api/auth/refresh", json={"refresh_token": refresh})).status_code == 401
    assert (await delete_me(client, {"Authorization": f"Bearer {access}"})).status_code == 401

    # 같은 Google 계정으로 다시 로그인하면 새 사용자 - 이전 기록은 없다
    again=await login_app(client)
    assert again["user"]["u_id"] != u_id
    assert again["user"]["email"] == "me@example.com"
    fresh={"Authorization": f"Bearer {again['access_token']}"}
    assert (await client.get("/api/me", headers=fresh)).status_code == 200
    assert (await client.get("/api/deploys", headers=fresh)).json() == []
    assert (await user_row(u_id))[0] == "deleted"
    assert client.calls == []


# 인증을 켠 서버에서도 같다 - 지운 뒤 액세스 토큰은 보호 경로에서 401
@pytest.mark.asyncio
async def test_delete_me_old_access_token_rejected_when_auth_enabled(client, monkeypatch):
    login=await login_app(client)
    headers={"Authorization": f"Bearer {login['access_token']}"}
    monkeypatch.setattr(settings, "auth_enabled", True)
    assert (await client.get("/api/deploys", headers=headers)).status_code == 200

    assert (await delete_me(client, headers)).status_code == 200

    assert (await client.get("/api/deploys", headers=headers)).status_code == 401


# 한 사용자의 기록 내용 - 표마다 그 사용자(u_id)·그 사용자 배포(d_id)·그 사용자 인시던트(i_id)에 딸린 행을 통째로 (삭제 전후를 견주는 데 쓴다)
async def rows_of_user(u_id:int) -> dict:
    deploy_ids=f"SELECT d_id FROM deploys WHERE u_id={u_id}"
    queries={"deploys": f"SELECT * FROM deploys WHERE u_id={u_id} ORDER BY d_id",
             "connections": f"SELECT * FROM connections WHERE u_id={u_id} ORDER BY c_id",
             "aws_accounts": f"SELECT * FROM aws_accounts WHERE u_id={u_id} ORDER BY a_id",
             "github_installations": f"SELECT * FROM github_installations WHERE u_id={u_id} ORDER BY g_id",
             "notifications": f"SELECT * FROM notifications WHERE u_id={u_id} ORDER BY n_id",
             "push_devices": f"SELECT * FROM push_devices WHERE u_id={u_id} ORDER BY p_d_id",
             "notification_settings": f"SELECT * FROM notification_settings WHERE u_id={u_id}",
             "incidents": f"SELECT * FROM incidents WHERE d_id IN ({deploy_ids}) ORDER BY i_id",
             "recovery_actions": f"SELECT * FROM recovery_actions WHERE i_id IN (SELECT i_id FROM incidents WHERE d_id IN ({deploy_ids})) ORDER BY 1"}
    for table in ("deploy_logs", "deploy_issues", "deploy_releases", "deploy_env_vars", "health_checks"):
        queries[table]=f"SELECT * FROM {table} WHERE d_id IN ({deploy_ids}) ORDER BY 1"
    return {table: [tuple(row) for row in await sql(query)] for table, query in queries.items()}


# 남의 기록은 그대로 - 다른 사용자의 행이 표마다 삭제 전후 내용까지 같고, 지운 사용자의 행은 하나도 없다
@pytest.mark.asyncio
async def test_delete_me_leaves_other_user(client):
    other=await make_user_other()
    other_deploys=await seed(other, "b")
    other_before=await rows_of_user(other)
    # 시험이 빈 표를 비교하지 않도록 - 남의 표마다 행이 있다
    assert all(rows for rows in other_before.values()), {table: len(rows) for table, rows in other_before.items()}

    login=await login_app(client)
    u_id=login["user"]["u_id"]
    await seed(u_id, "a")
    mine_before=await rows_of_user(u_id)
    assert all(rows for rows in mine_before.values())

    response=await delete_me(client, {"Authorization": f"Bearer {login['access_token']}"})

    assert response.status_code == 200, response.text
    assert await rows_of_user(other) == other_before
    assert [row[0] for row in (await rows_of_user(other))["deploys"]] == other_deploys
    assert all(rows == [] for rows in (await rows_of_user(u_id)).values())
    async with AsyncSessionLocal() as db:
        assert (await Auth_Crud.crud_user_get_by_u_id(db, other)).status == "active"
    assert (await client.get("/api/deploys", headers=auth_header(other))).json() != []
    assert client.calls == []


# 한 기능의 삭제가 실패하면 전부 되돌린다 - 아무것도 지워지지 않고 사용자는 그대로 active, 토큰도 살아 있다
@pytest.mark.asyncio
async def test_delete_me_rolls_back_when_a_step_fails(client, monkeypatch):
    from features.notifications.services import Notification_Service

    login=await login_app(client)
    u_id=login["user"]["u_id"]
    headers={"Authorization": f"Bearer {login['access_token']}"}
    await seed(u_id, "a")
    before=await counts()

    original=Notification_Service.services_notification_forget_user

    async def forget_then_fail(db, user_id):
        await original(db, user_id)
        raise RuntimeError("세 번째 기능 실패")

    monkeypatch.setattr(Notification_Service, "services_notification_forget_user", staticmethod(forget_then_fail))

    response=await delete_me(client, headers)

    assert response.status_code == 500
    assert await counts() == before
    assert (await user_row(u_id))[0] == "active"
    assert (await client.get("/api/me", headers=headers)).status_code == 200
    async with async_engine.begin() as conn:
        assert (await conn.execute(text("SELECT COUNT(*) FROM refresh_tokens WHERE u_id=:u AND revoked_at IS NULL"), {"u": u_id})).scalar() == 1
    assert client.calls == []


# 살아 있는 배포의 정의는 MCP 의 것과 같다 (파이프라인 진행 상태 + running + needs_input)
def test_delete_me_live_statuses_match_mcp():
    from features.deploys.services import LIVE_STATUSES
    from features.mcp.services import LIVE_STATUSES as MCP_LIVE_STATUSES

    assert set(LIVE_STATUSES) == set(MCP_LIVE_STATUSES)


# 첫 문장이 쓰기 잠금을 잡는다 - 살아 있는 배포 확인 시점에 다른 연결의 쓰기(다시 켜기 같은)는 들어오지 못한다
@pytest.mark.asyncio
async def test_delete_me_takes_write_lock_before_live_check(client, monkeypatch):
    login=await login_app(client)
    u_id=login["user"]["u_id"]
    d_ids=await seed(u_id, "a")
    outcome={}

    original=Deploy_Service.services_deploy_live_for_user

    async def live_after_lock(db, user_id):
        if "locked" not in outcome:
            other=sqlite3.connect(async_engine.url.database, timeout=0.2)
            try:
                other.execute("UPDATE deploys SET status='queued' WHERE d_id=?", (d_ids[0],))
                other.commit()
                outcome["locked"]=False
            except sqlite3.OperationalError as e:
                outcome["locked"]="locked" in str(e)
            finally:
                other.close()
        return await original(db, user_id)

    monkeypatch.setattr(Deploy_Service, "services_deploy_live_for_user", staticmethod(live_after_lock))

    response=await delete_me(client, {"Authorization": f"Bearer {login['access_token']}"})

    assert outcome["locked"] is True
    assert response.status_code == 200, response.text


# 확인 뒤 삭제 전에 배포가 살아나면(경쟁) 삭제 순간의 조건이 지키고, 마지막 확인이 409 + 롤백 - 배포 기록은 그대로 남는다
@pytest.mark.asyncio
async def test_delete_me_race_stopped_deploy_turns_live(client, monkeypatch):
    login=await login_app(client)
    u_id=login["user"]["u_id"]
    d_ids=await seed(u_id, "a")
    before=await counts()
    original=Deploy_Service.services_deploy_live_for_user
    state={"calls": 0}

    async def flip_after_first(db, user_id):
        result=await original(db, user_id)
        state["calls"]+=1
        if state["calls"] == 1:
            await db.execute(update(Deploy).where(Deploy.d_id == d_ids[0]).values(status="queued"))
        return result

    monkeypatch.setattr(Deploy_Service, "services_deploy_live_for_user", staticmethod(flip_after_first))

    response=await delete_me(client, {"Authorization": f"Bearer {login['access_token']}"})

    assert response.status_code == 409, response.text
    assert f"#{d_ids[0]} " in response.json()["detail"]
    assert await counts() == before
    assert (await sql("SELECT status FROM deploys WHERE d_id=:d", d=d_ids[0]))[0][0] == "stopped"
    assert (await user_row(u_id))[0] == "active"
    assert client.calls == []


# 지우는 함수 자체가 지우는 순간의 조건을 쓴다 - 살아 있는 배포와 그 딸린 기록은 지우지 않는다
@pytest.mark.asyncio
async def test_deploy_forget_user_skips_deploy_that_is_live_now(client):
    u_id=await make_user_other()
    d_ids=await seed(u_id, "a")

    async with AsyncSessionLocal() as db:
        await db.execute(update(Deploy).where(Deploy.d_id == d_ids[0]).values(status="queued"))
        forgotten=await Deploy_Service.services_deploy_forget_user(db, u_id)
        await db.commit()

    assert forgotten == 2
    assert [row[0] for row in await sql("SELECT d_id FROM deploys")] == [d_ids[0]]
    for table in ("deploy_logs", "deploy_issues", "deploy_releases", "deploy_env_vars", "health_checks", "incidents", "recovery_actions"):
        assert (await sql(f"SELECT COUNT(*) FROM {table}"))[0][0] == 1, table


# 지운 계정·설치를 가리키던 다른 기록(주인 없는 배포, 남의 블록·배포)은 참조가 NULL 이 되어, id 가 다시 쓰여도 남의 자격증명에 닿지 않는다
@pytest.mark.asyncio
async def test_delete_me_unlinks_references_of_any_owner(client):
    login=await login_app(client)
    u_id=login["user"]["u_id"]
    other=await make_user_other()

    async with AsyncSessionLocal() as db:
        db_aws=Aws_Account(u_id=u_id, label="mine", external_id_encrypted="x", role_arn="arn:aws:iam::111111111111:role/R")
        db_gh=Github_Installation(u_id=u_id, installation_id=777, account_login="mine")
        other_aws=Aws_Account(u_id=other, label="theirs", external_id_encrypted="x")
        db.add_all([db_aws, db_gh, other_aws])
        await db.flush()
        orphan=Deploy(u_id=None, repo_url="https://github.com/o/orphan", status="stopped", aws_account_id=db_aws.a_id, github_installation_id=db_gh.g_id)
        theirs=Deploy(u_id=other, repo_url="https://github.com/o/theirs", status="running", service_arn="arn:aws:ecs:t",
                      aws_account_id=db_aws.a_id, github_installation_id=db_gh.g_id)
        safe=Deploy(u_id=other, repo_url="https://github.com/o/safe", status="stopped", aws_account_id=other_aws.a_id)
        block=Connection(u_id=other, label="b", aws_account_id=db_aws.a_id, github_installation_id=db_gh.g_id)
        safe_block=Connection(u_id=other, label="c", aws_account_id=other_aws.a_id)
        db.add_all([orphan, theirs, safe, block, safe_block])
        await db.commit()
        orphan_id, theirs_id, safe_id, block_id, safe_block_id, other_aws_id=orphan.d_id, theirs.d_id, safe.d_id, block.c_id, safe_block.c_id, other_aws.a_id

    response=await delete_me(client, {"Authorization": f"Bearer {login['access_token']}"})
    assert response.status_code == 200, response.text

    rows={row[0]: tuple(row[1:]) for row in await sql("SELECT d_id, aws_account_id, github_installation_id FROM deploys")}
    assert rows[orphan_id] == (None, None)
    assert rows[theirs_id] == (None, None)
    assert rows[safe_id] == (other_aws_id, None)
    blocks={row[0]: tuple(row[1:]) for row in await sql("SELECT c_id, aws_account_id, github_installation_id FROM connections")}
    assert blocks[block_id] == (None, None)
    assert blocks[safe_block_id] == (other_aws_id, None)

    # 다른 사용자가 새로 만든 계정이 지운 id 를 다시 받아도 옛 배포는 닿지 않는다
    async with AsyncSessionLocal() as db:
        fresh=Aws_Account(u_id=other, label="fresh", external_id_encrypted="x")
        db.add(fresh)
        await db.commit()
        fresh_id=fresh.a_id
    assert [row[0] for row in await sql("SELECT d_id FROM deploys WHERE aws_account_id=:a", a=fresh_id)] == []
    assert client.calls == []


# 남는 ECR 저장소 - 멈춘·서비스 없는 실패 배포의 repository_name(없으면 image_uri 의 저장소 부분)만, 중복 없이 정렬. 삭제된 배포는 이미 지웠으니 뺀다
@pytest.mark.asyncio
async def test_delete_me_reports_leftover_ecr_repositories(client):
    login=await login_app(client)
    u_id=login["user"]["u_id"]
    await seed(u_id, "a", [
        {"repo_url": "https://github.com/o/f1", "status": "failed", "repository_name": None,
         "image_uri": "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/deploy-wizard/zzz-9:build-1"},
        {"repo_url": "https://github.com/o/f2", "status": "stopped", "repository_name": "repo-a"},
        {"repo_url": "https://github.com/o/gone", "status": "deleted", "repository_name": "deploy-wizard/already-deleted-1"}])

    response=await delete_me(client, {"Authorization": f"Bearer {login['access_token']}"})

    assert response.status_code == 200, response.text
    body=response.json()
    assert body["leftover_ecr_repositories"] == ["deploy-wizard/zzz-9", "repo-a"]
    assert "남아 있는 ECR 이미지 저장소(deploy-wizard/zzz-9, repo-a)도 AWS 콘솔에서 직접 지워 주세요" in body["message"]
    assert "AWS CloudFormation 스택과 GitHub 앱 설치는 직접 지워 주세요" in body["message"]
    assert client.calls == []


# 남는 저장소가 없으면 목록은 비고 안내 문장도 없다
@pytest.mark.asyncio
async def test_delete_me_no_leftover_ecr_message_when_none(client):
    login=await login_app(client)

    response=await delete_me(client, {"Authorization": f"Bearer {login['access_token']}"})

    assert response.status_code == 200, response.text
    assert response.json()["leftover_ecr_repositories"] == []
    assert "ECR" not in response.json()["message"]


# 쓰기 잠금 때문에 삭제가 막히면 500 이 아니라 503 + 다시 시도 안내 - 아무것도 지워지지 않고 사용자는 그대로 active, 토큰도 살아 있다
@pytest.mark.asyncio
@pytest.mark.parametrize("where", ["first_write", "later_step"])
async def test_delete_me_database_locked_503(client, monkeypatch, where):
    from sqlalchemy.exc import OperationalError
    from features.notifications.services import Notification_Service

    login=await login_app(client)
    u_id=login["user"]["u_id"]
    headers={"Authorization": f"Bearer {login['access_token']}"}
    await seed(u_id, "a")
    before=await counts()
    locked=OperationalError("UPDATE users SET ...", {}, sqlite3.OperationalError("database is locked"))

    if where == "first_write":
        async def touch_locked(db, user_id, now):
            raise locked

        monkeypatch.setattr(Auth_Crud, "crud_user_touch_active", staticmethod(touch_locked))
    else:
        original=Notification_Service.services_notification_forget_user

        async def forget_then_locked(db, user_id):
            await original(db, user_id)
            raise locked

        monkeypatch.setattr(Notification_Service, "services_notification_forget_user", staticmethod(forget_then_locked))

    response=await delete_me(client, headers)

    assert response.status_code == 503, response.text
    assert response.json()["detail"] == MESSAGE_BUSY
    assert await counts() == before
    assert (await user_row(u_id))[0] == "active"
    async with async_engine.begin() as conn:
        assert (await conn.execute(text("SELECT COUNT(*) FROM refresh_tokens WHERE u_id=:u AND revoked_at IS NULL"), {"u": u_id})).scalar() == 1
    assert client.calls == []


# 잠금과 상관없는 다른 DB 오류는 그대로 500
@pytest.mark.asyncio
async def test_delete_me_other_database_error_stays_500(client, monkeypatch):
    from sqlalchemy.exc import OperationalError

    login=await login_app(client)

    async def touch_broken(db, user_id, now):
        raise OperationalError("UPDATE users SET ...", {}, sqlite3.OperationalError("disk I/O error"))

    monkeypatch.setattr(Auth_Crud, "crud_user_touch_active", staticmethod(touch_broken))

    response=await delete_me(client, {"Authorization": f"Bearer {login['access_token']}"})

    assert response.status_code == 500
    assert response.json()["detail"].startswith("계정 삭제 실패 :")
