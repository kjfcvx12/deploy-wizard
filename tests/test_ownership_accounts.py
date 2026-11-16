import time
from urllib.parse import urlparse, parse_qs

import jwt as pyjwt
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select, text

from shared.database import Base, async_engine, AsyncSessionLocal
from shared.settings import settings

from features.accounts import services as accounts_module

from auth_helpers import make_user, auth_header


# 로그인 계획 Task 6 - 계정 연결 소유권(남의 것은 404, 외부 호출 0번)·서명된 설치 state·연결 정보 암호화

ROLE_ARN="arn:aws:iam::222222222222:role/DeployWizardCrossAccountRole"


class Fake_Response:
    def __init__(self, json_data):
        self._json=json_data
        self.status_code=200

    def raise_for_status(self):
        return None

    def json(self):
        return self._json


# GitHub API 가짜 - 불릴 때마다 적는다
class Fake_Async_Client:
    def __init__(self, calls, data):
        self.calls=calls
        self.data=data

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, headers=None, params=None):
        self.calls.append(("github", url))
        return Fake_Response(self.data)

    async def post(self, url, headers=None, json=None):
        self.calls.append(("github", url))
        return Fake_Response(self.data)


@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app

    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "github_app_slug", "deploy-wizard-test")

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    # AWS·GitHub 는 가짜 - 불린 것만 적는다
    calls=[]
    data={"account": {"login": "octo-login", "type": "User"}, "repository_selection": "all",
          "token": "ghs_fake", "total_count": 0, "repositories": []}

    def fake_account_id(session):
        calls.append(("aws", "get_account_id"))
        return "222222222222"

    def fake_assume(role_arn, external_id):
        calls.append(("aws", "assume"))
        return object()

    def fake_dev_session():
        calls.append(("aws", "dev_session"))
        return object()

    monkeypatch.setattr(accounts_module, "get_account_id", fake_account_id)
    monkeypatch.setattr(accounts_module, "get_assumed_session", fake_assume)
    monkeypatch.setattr(accounts_module, "get_aws_session", fake_dev_session)
    monkeypatch.setattr(accounts_module.Github_Service, "services_github_app_jwt", staticmethod(lambda: "fake-jwt"))
    monkeypatch.setattr(accounts_module.httpx, "AsyncClient", lambda *a, **kw: Fake_Async_Client(calls, data))

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


# 사용자의 AWS 계정(역할 등록 끝남)·GitHub 설치·둘을 이은 블록을 바로 만든다 - 반환: (a_id, g_id, c_id)
async def accounts_make(u_id:int|None, installation_id:int=111, label:str="mine") -> tuple[int, int, int]:
    from features.accounts.models import Aws_Account, Github_Installation, Connection
    from shared.secrets import encrypt_secret

    async with AsyncSessionLocal() as db:
        account=Aws_Account(label=label, external_id_encrypted=encrypt_secret("ext"), u_id=u_id, role_arn=ROLE_ARN,
                            aws_account_id="222222222222", status="verified")
        installation=Github_Installation(installation_id=installation_id, account_login="login-" + label, u_id=u_id)
        db.add_all([account, installation])
        await db.flush()
        connection=Connection(label=label, aws_account_id=account.a_id, github_installation_id=installation.g_id, u_id=u_id)
        db.add(connection)
        await db.commit()
        return account.a_id, installation.g_id, connection.c_id


# 설치 주소에서 state 를 꺼낸다
async def install_state(client, headers=None, c_id:int|None=None) -> str:
    params={"c_id": c_id} if c_id is not None else {}
    response=await client.get("/api/accounts/github/install-url", params=params, headers=headers or {})
    assert response.status_code == 200, response.text
    return parse_qs(urlparse(response.json()["url"]).query)["state"][0]


ROUTES_404=[
    ("GET", "/api/accounts/aws/{a_id}", None),
    ("PATCH", "/api/accounts/aws/{a_id}/role-arn", {"role_arn": ROLE_ARN}),
    ("POST", "/api/accounts/aws/{a_id}/reverify", None),
    ("GET", "/api/accounts/aws/{a_id}/template-status", None),
    ("DELETE", "/api/accounts/aws/{a_id}/template-files", None),
    ("DELETE", "/api/accounts/aws/{a_id}", None),
    ("PATCH", "/api/accounts/connections/{c_id}", {"github_installation_id": None}),
    ("DELETE", "/api/accounts/connections/{c_id}", None),
    ("POST", "/api/accounts/connections/{c_id}/aws", None),
    ("GET", "/api/accounts/github/install-url?c_id={c_id}", None),
    ("GET", "/api/accounts/github/{g_id}/check", None),
    ("GET", "/api/accounts/github/{g_id}/repositories", None),
    ("DELETE", "/api/accounts/github/{g_id}", None),
]


# a_id·c_id·g_id 를 받는 모든 계정 라우트 - B 의 토큰으로 A 의 id 는 404, AWS·GitHub 가짜는 한 번도 불리지 않고 A 의 것은 그대로
@pytest.mark.asyncio
@pytest.mark.parametrize("method,path,body", ROUTES_404)
async def test_accounts_routes_404_for_other(client, monkeypatch, method, path, body):
    from features.accounts.models import Aws_Account, Github_Installation, Connection

    a, b=await users_on(monkeypatch)
    a_id, g_id, c_id=await accounts_make(a)

    url=path.format(a_id=a_id, g_id=g_id, c_id=c_id)
    response=await client.request(method, url, json=body, headers=auth_header(b))

    assert response.status_code == 404, response.text
    assert client.calls == []

    async with AsyncSessionLocal() as db:
        account=await db.get(Aws_Account, a_id)
        connection=await db.get(Connection, c_id)
        assert account is not None and account.role_arn == ROLE_ARN and account.status == "verified"
        assert await db.get(Github_Installation, g_id) is not None
        assert connection is not None and connection.aws_account_id == a_id and connection.github_installation_id == g_id

    # A 는 같은 읽기 경로가 404 가 아니다
    if method == "GET" and "/check" not in url and "/repositories" not in url and "template-status" not in url:
        assert (await client.get(url, headers=auth_header(a))).status_code == 200


# 내 블록에 남의 AWS 계정·GitHub 설치를 잇기 - 404, 블록은 그대로
@pytest.mark.asyncio
async def test_accounts_link_others_404(client, monkeypatch):
    from features.accounts.models import Connection

    a, b=await users_on(monkeypatch)
    a_id, g_id, _=await accounts_make(a, 111, "a")
    _, _, c_b=await accounts_make(b, 222, "b")

    for body in ({"aws_account_id": a_id}, {"github_installation_id": g_id}):
        response=await client.patch(f"/api/accounts/connections/{c_b}", json=body, headers=auth_header(b))
        assert response.status_code == 404, response.text

    async with AsyncSessionLocal() as db:
        connection=await db.get(Connection, c_b)
        assert connection.aws_account_id != a_id and connection.github_installation_id != g_id

    assert client.calls == []


# 세 목록 모두 내 것만, 새로 만든 것의 주인은 만든 사용자
@pytest.mark.asyncio
async def test_accounts_lists_only_mine(client, monkeypatch):
    from features.accounts.models import Aws_Account, Connection

    a, b=await users_on(monkeypatch)
    a_id, g_id, c_id=await accounts_make(a, 111, "a")
    b_id, h_id, d_id=await accounts_make(b, 222, "b")

    for user, mine in ((a, (a_id, g_id, c_id)), (b, (b_id, h_id, d_id))):
        assert [x["a_id"] for x in (await client.get("/api/accounts/aws", headers=auth_header(user))).json()] == [mine[0]]
        assert [x["g_id"] for x in (await client.get("/api/accounts/github", headers=auth_header(user))).json()] == [mine[1]]
        blocks=(await client.get("/api/accounts/connections", headers=auth_header(user))).json()
        assert [(x["c_id"], x["aws"]["a_id"], x["github"]["g_id"]) for x in blocks] == [(mine[2], mine[0], mine[1])]

    created=await client.post("/api/accounts/connections", json={"label": "새 블록"}, headers=auth_header(a))
    assert created.status_code == 201
    setup=await client.post(f"/api/accounts/connections/{created.json()['c_id']}/aws", headers=auth_header(a))
    assert setup.status_code == 201
    direct=await client.post("/api/accounts/aws", json={"label": "따로"}, headers=auth_header(a))
    assert direct.status_code == 201

    async with AsyncSessionLocal() as db:
        assert (await db.get(Connection, created.json()["c_id"])).u_id == a
        assert (await db.get(Aws_Account, setup.json()["a_id"])).u_id == a
        assert (await db.get(Aws_Account, direct.json()["a_id"])).u_id == a

    assert len((await client.get("/api/accounts/connections", headers=auth_header(b))).json()) == 1
    assert len((await client.get("/api/accounts/aws", headers=auth_header(b))).json()) == 1


# 블록 도입 전 계정 채우기도 내 것만 - B 의 블록 없는 계정이 A 의 목록에 블록으로 생기지 않는다
@pytest.mark.asyncio
async def test_accounts_backfill_only_mine(client, monkeypatch):
    from features.accounts.models import Aws_Account, Connection

    a, b=await users_on(monkeypatch)

    async with AsyncSessionLocal() as db:
        db.add(Aws_Account(label="b 의 옛 계정", external_id_encrypted="x", u_id=b))
        await db.commit()

    assert (await client.get("/api/accounts/connections", headers=auth_header(a))).json() == []

    blocks=(await client.get("/api/accounts/connections", headers=auth_header(b))).json()
    assert [x["label"] for x in blocks] == ["b 의 옛 계정"]

    async with AsyncSessionLocal() as db:
        assert [c.u_id for c in (await db.execute(select(Connection))).scalars().all()] == [b]


# 설치 콜백 - A 의 설치 주소에서 꺼낸 state 만 통한다. 위조·만료·옛 숫자 형식·다른 종류의 토큰은 설치를 저장하지 않고 github_error
@pytest.mark.asyncio
async def test_github_callback_signed_state(client, monkeypatch):
    from features.accounts.models import Github_Installation, Connection

    a, b=await users_on(monkeypatch)
    created=await client.post("/api/accounts/connections", json={"label": "a 블록"}, headers=auth_header(a))
    c_id=created.json()["c_id"]

    state=await install_state(client, auth_header(a), c_id)
    assert not state.isdigit()

    now=int(time.time())
    forged=pyjwt.encode({"typ": "gh_state", "u": b, "c": None, "iat": now, "exp": now + 900}, "wrong-key", algorithm="HS256")
    expired=pyjwt.encode({"typ": "gh_state", "u": a, "c": c_id, "iat": now - 2000, "exp": now - 1000}, settings.auth_jwt_key, algorithm="HS256")
    wrong_typ=auth_header(a)["Authorization"].split(" ", 1)[1]

    for bad in (forged, expired, "5", str(c_id), wrong_typ, "garbage", None):
        params={"installation_id": 556}
        if bad is not None:
            params["state"]=bad
        response=await client.get("/api/accounts/github/callback", params=params, follow_redirects=False)
        assert response.status_code in (302, 307)
        assert response.headers["location"] == "/accounts?connected=github_error", bad

    async with AsyncSessionLocal() as db:
        assert (await db.execute(select(Github_Installation))).scalars().all() == []
    assert client.calls == []

    # 진짜 state - 설치의 주인은 A, A 의 블록에 이어진다. 리다이렉트 주소에 state 가 실리지 않는다
    response=await client.get("/api/accounts/github/callback", params={"installation_id": 555, "state": state}, follow_redirects=False)
    assert response.headers["location"] == "/accounts?connected=github"
    assert state not in response.headers["location"]

    async with AsyncSessionLocal() as db:
        installation=(await db.execute(select(Github_Installation))).scalars().one()
        assert installation.installation_id == 555 and installation.u_id == a
        assert installation.account_login == "octo-login"
        assert (await db.get(Connection, c_id)).github_installation_id == installation.g_id

    assert [x["installation_id"] for x in (await client.get("/api/accounts/github", headers=auth_header(a))).json()] == [555]
    assert (await client.get("/api/accounts/github", headers=auth_header(b))).json() == []


# 이미 B 가 가진 installation_id 로 A 가 콜백 - 주인이 바뀌지 않고 github_taken, GitHub 조회도 하지 않는다
@pytest.mark.asyncio
async def test_github_callback_taken_by_other(client, monkeypatch):
    from features.accounts.models import Github_Installation

    a, b=await users_on(monkeypatch)
    _, g_b, _=await accounts_make(b, 777, "b")

    state=await install_state(client, auth_header(a))
    response=await client.get("/api/accounts/github/callback", params={"installation_id": 777, "state": state}, follow_redirects=False)
    assert response.headers["location"] == "/accounts?connected=github_taken"

    async with AsyncSessionLocal() as db:
        installation=await db.get(Github_Installation, g_b)
        assert installation.u_id == b and installation.account_login == "login-b"

    assert client.calls == []


# 끔 모드 - 같은 서명 형식(u=None)으로 지금처럼 이어지고, state 없는 콜백(GitHub 쪽에서 바로 온 것)도 받는다
@pytest.mark.asyncio
async def test_github_callback_off_mode(client):
    from features.accounts.models import Github_Installation, Connection

    c_id=(await client.post("/api/accounts/connections", json={"label": "블록"})).json()["c_id"]
    state=await install_state(client, None, c_id)

    claims=pyjwt.decode(state, options={"verify_signature": False})
    assert claims["typ"] == "gh_state" and claims["u"] is None and claims["c"] == c_id
    assert claims["exp"] - claims["iat"] == 900

    response=await client.get("/api/accounts/github/callback", params={"installation_id": 555, "state": state}, follow_redirects=False)
    assert response.headers["location"] == "/accounts?connected=github"

    response=await client.get("/api/accounts/github/callback", params={"installation_id": 556}, follow_redirects=False)
    assert response.headers["location"] == "/accounts?connected=github"

    # 옛 숫자 state 는 끔 모드에서도 거절
    response=await client.get("/api/accounts/github/callback", params={"installation_id": 557, "state": "5"}, follow_redirects=False)
    assert response.headers["location"] == "/accounts?connected=github_error"

    async with AsyncSessionLocal() as db:
        installations=(await db.execute(select(Github_Installation).order_by(Github_Installation.installation_id))).scalars().all()
        assert [(x.installation_id, x.u_id) for x in installations] == [(555, None), (556, None)]
        assert (await db.get(Connection, c_id)).github_installation_id == installations[0].g_id


# 끔 모드에서 AUTH_JWT_KEY 가 없으면 SECRET_KEY 에서 용도 이름으로 파생한 키로 서명한다 (새 환경변수 없이 동작)
@pytest.mark.asyncio
async def test_github_state_key_fallback(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_jwt_key", None)

    state=await install_state(client)
    with pytest.raises(pyjwt.InvalidSignatureError):
        pyjwt.decode(state, settings.secret_key, algorithms=["HS256"])

    response=await client.get("/api/accounts/github/callback", params={"installation_id": 555, "state": state}, follow_redirects=False)
    assert response.headers["location"] == "/accounts?connected=github"


# 연결 정보는 DB 에 암호문으로 - raw SQL 로는 암호문, ORM·API 로는 평문
@pytest.mark.asyncio
async def test_accounts_fields_encrypted_at_rest(client):
    from features.accounts.models import Aws_Account, Github_Installation

    a_id=(await client.post("/api/accounts/aws", json={"label": "x"})).json()["a_id"]
    attached=await client.patch(f"/api/accounts/aws/{a_id}/role-arn", json={"role_arn": ROLE_ARN})
    assert attached.status_code == 200, attached.text
    await client.get("/api/accounts/github/callback", params={"installation_id": 555}, follow_redirects=False)

    async with AsyncSessionLocal() as db:
        role_arn, account_id=(await db.execute(text("SELECT role_arn, aws_account_id FROM aws_accounts"))).one()
        (login,)=(await db.execute(text("SELECT account_login FROM github_installations"))).one()

        for raw, plain in ((role_arn, ROLE_ARN), (account_id, "222222222222"), (login, "octo-login")):
            assert raw.startswith("gAAAAA") and plain not in raw

        account=await db.get(Aws_Account, a_id)
        assert account.role_arn == ROLE_ARN and account.aws_account_id == "222222222222"
        assert (await db.execute(select(Github_Installation))).scalars().one().account_login == "octo-login"

    read=(await client.get(f"/api/accounts/aws/{a_id}")).json()
    assert read["role_arn"] == ROLE_ARN and read["aws_account_id"] == "222222222222"
    assert (await client.get("/api/accounts/github")).json()[0]["account_login"] == "octo-login"


# 이전 전 평문이 남은 DB - 조용히 섞어 읽지 않고 이전 스크립트를 안내하는 한국어 오류
@pytest.mark.asyncio
async def test_accounts_legacy_plaintext_clear_error(client):
    from features.accounts.models import Aws_Account
    from shared.secrets import Secret_Error

    async with AsyncSessionLocal() as db:
        await db.execute(text("INSERT INTO aws_accounts (label, role_arn, external_id_encrypted, status) VALUES ('old', :arn, 'x', 'verified')"),
                         {"arn": ROLE_ARN})
        await db.commit()

    async with AsyncSessionLocal() as db:
        with pytest.raises(Secret_Error) as exc:
            (await db.execute(select(Aws_Account))).scalars().all()

    assert "migrate_login.py" in str(exc.value)
    assert ROLE_ARN not in str(exc.value)
