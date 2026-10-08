import pytest
import pytest_asyncio
import httpx
import jwt as pyjwt
from httpx import AsyncClient, ASGITransport
from botocore.exceptions import ClientError

from shared.database import Base, async_engine

from features.accounts import services as accounts_module


class Fake_Response:
    def __init__(self, status_code, json_data):
        self.status_code=status_code
        self._json=json_data

    def raise_for_status(self):
        if self.status_code >= 400:
            request=httpx.Request("GET", "https://api.github.com/x")
            response=httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("error", request=request, response=response)

    def json(self):
        return self._json


class Fake_Async_Client:
    def __init__(self, response):
        self._response=response

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, headers=None, params=None):
        return self._response

    async def post(self, url, headers=None, json=None):
        return self._response


@pytest_asyncio.fixture
async def client():
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# AWS 계정 등록 - 생성 직후에만 external_id 를 보여주고, 이후 조회에는 안 나온다
@pytest.mark.asyncio
async def test_aws_account_create_hides_secret_afterward(client, monkeypatch):
    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "111111111111")

    response=await client.post("/api/accounts/aws", json={"label": "내 서브 계정", "region": "ap-northeast-2"})
    assert response.status_code == 201

    body=response.json()
    assert body["external_id"]
    assert body["our_account_id"] == "111111111111"
    assert body["template_download_url"] == "/api/accounts/aws/template"
    assert body["stack_create_url"] == "https://ap-northeast-2.console.aws.amazon.com/cloudformation/home?region=ap-northeast-2#/stacks/create"
    a_id=body["a_id"]

    read=(await client.get(f"/api/accounts/aws/{a_id}")).json()
    assert "external_id" not in read
    assert "external_id_encrypted" not in read
    assert read["status"] == "pending"
    assert read["role_arn"] is None


# 스택 생성 주소 - 리전은 사용자 입력이라 형식이 이상하면 주소에 넣지 않고 기본 리전으로
def test_aws_account_stack_create_url_rejects_bad_region():
    from features.accounts.services import Aws_Account_Service

    assert Aws_Account_Service.services_aws_account_stack_create_url("us-east-1").startswith("https://us-east-1.console.aws.amazon.com/")

    for bad in ["evil.example/x", "us-east-1.evil.com", "", None]:
        url=Aws_Account_Service.services_aws_account_stack_create_url(bad)
        assert url.startswith(f"https://{accounts_module.settings.aws_region}.console.aws.amazon.com/")


@pytest.mark.asyncio
async def test_aws_account_404(client):
    assert (await client.get("/api/accounts/aws/999")).status_code == 404


# 역할 ARN 등록 - AssumeRole 이 성공하면 verified
@pytest.mark.asyncio
async def test_aws_account_attach_role_success(client, monkeypatch):
    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "222222222222")
    a_id=(await client.post("/api/accounts/aws", json={"label": "x"})).json()["a_id"]

    monkeypatch.setattr(accounts_module, "get_assumed_session", lambda role_arn, external_id: object())

    response=await client.patch(f"/api/accounts/aws/{a_id}/role-arn", json={"role_arn": "arn:aws:iam::222222222222:role/DeployWizardCrossAccountRole"})
    assert response.status_code == 200

    body=response.json()
    assert body["status"] == "verified"
    assert body["aws_account_id"] == "222222222222"
    assert body["last_verified_at"]


# 연결된 계정에 배포할 때 쓸 ECS 역할 - CFN 템플릿이 그 계정에 만든 것. 연결 없으면 None, 연결 미완료면 막는다
@pytest.mark.asyncio
async def test_aws_account_role_arns(client, monkeypatch):
    from shared.database import AsyncSessionLocal
    from features.accounts.services import Aws_Account_Service

    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "222222222222")
    monkeypatch.setattr(accounts_module, "get_assumed_session", lambda role_arn, external_id: object())
    a_id=(await client.post("/api/accounts/aws", json={"label": "x"})).json()["a_id"]

    async with AsyncSessionLocal() as db:
        assert await Aws_Account_Service.services_aws_account_role_arns(db, None) is None

        with pytest.raises(ValueError):
            await Aws_Account_Service.services_aws_account_role_arns(db, a_id)

    await client.patch(f"/api/accounts/aws/{a_id}/role-arn", json={"role_arn": "arn:aws:iam::222222222222:role/DeployWizardCrossAccountRole"})

    async with AsyncSessionLocal() as db:
        assert await Aws_Account_Service.services_aws_account_role_arns(db, a_id) == (
            "arn:aws:iam::222222222222:role/DeployWizardEcsTaskExecutionRole",
            "arn:aws:iam::222222222222:role/DeployWizardEcsInfrastructureRole",
        )


class Fake_S3:
    def __init__(self, buckets, denied=False):
        self.buckets=buckets
        self.denied=denied
        self.deleted=[]

    def list_buckets(self):
        if self.denied:
            raise ClientError({"Error": {"Code": "AccessDenied", "Message": "not authorized to perform: s3:ListAllMyBuckets"}}, "ListBuckets")
        return {"Buckets": [{"Name": name} for name in self.buckets]}

    def get_paginator(self, name):
        s3=self

        class Paginator:
            def paginate(self, Bucket):
                keys=s3.buckets[Bucket]
                return [{"Contents": [{"Key": key} for key in keys[:1]]}, {"Contents": [{"Key": key} for key in keys[1:]]}, {}]

        return Paginator()

    def delete_object(self, Bucket, Key):
        self.deleted.append((Bucket, Key))


class Fake_S3_Session:
    def __init__(self, s3):
        self.s3=s3

    def client(self, name):
        return self.s3


# 템플릿 파일 삭제 - cf-templates-* 버킷의 우리 템플릿만 지운다. 다른 파일·다른 버킷은 우리 것이 아니다 (설계 제약 8)
def test_aws_account_template_files_delete_only_ours():
    from features.accounts.services import Aws_Account_Service

    s3=Fake_S3({
        "cf-templates-abc123-ap-northeast-2": ["2026-10-06T083009.545Zi8s-deploy_wizard_role.yaml", "2026-01-01T000000.000Zabc-someone-else.yaml",
                                              "2026-10-07T010101.000Zxyz-deploy_wizard_role.yaml"],
        "my-app-data": ["2026-10-06T083009.545Zi8s-deploy_wizard_role.yaml"],
        "cf-templates-abc123-us-east-1": ["not-deploy_wizard_role.yaml.bak"],
    })

    deleted=Aws_Account_Service.services_aws_account_template_files_delete(Fake_S3_Session(s3))

    assert deleted == 2
    assert s3.deleted == [
        ("cf-templates-abc123-ap-northeast-2", "2026-10-06T083009.545Zi8s-deploy_wizard_role.yaml"),
        ("cf-templates-abc123-ap-northeast-2", "2026-10-07T010101.000Zxyz-deploy_wizard_role.yaml"),
    ]


# [템플릿 파일 삭제] 버튼 - 연결 전이면 400, 역할에 권한이 없으면(옛 템플릿으로 만든 스택) 스택 업데이트를 안내하는 403
@pytest.mark.asyncio
async def test_aws_account_template_cleanup_api(client, monkeypatch):
    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "222222222222")
    a_id=(await client.post("/api/accounts/aws", json={"label": "x"})).json()["a_id"]

    assert (await client.delete(f"/api/accounts/aws/{a_id}/template-files")).status_code == 400
    assert (await client.delete("/api/accounts/aws/999/template-files")).status_code == 404

    s3=Fake_S3({"cf-templates-abc123-ap-northeast-2": ["2026-10-06T083009.545Zi8s-deploy_wizard_role.yaml"]})
    monkeypatch.setattr(accounts_module, "get_assumed_session", lambda role_arn, external_id: Fake_S3_Session(s3))
    await client.patch(f"/api/accounts/aws/{a_id}/role-arn", json={"role_arn": "arn:aws:iam::222222222222:role/DeployWizardCrossAccountRole"})

    response=await client.delete(f"/api/accounts/aws/{a_id}/template-files")
    assert response.status_code == 200
    assert response.json()["deleted"] == 1

    s3.denied=True
    response=await client.delete(f"/api/accounts/aws/{a_id}/template-files")
    assert response.status_code == 403
    assert "스택을 업데이트" in response.json()["detail"]

    # 연결 자체는 그대로다
    assert (await client.get(f"/api/accounts/aws/{a_id}")).json()["status"] == "verified"


class Fake_Iam:
    def __init__(self, tags=None, denied=False):
        self.tags=tags or []
        self.denied=denied
        self.asked=[]

    def get_role(self, RoleName):
        self.asked.append(RoleName)
        if self.denied:
            raise ClientError({"Error": {"Code": "AccessDenied", "Message": "not authorized to perform: iam:GetRole"}}, "GetRole")
        return {"Role": {"RoleName": RoleName, "Tags": self.tags}}


class Fake_Iam_Session:
    def __init__(self, iam, s3=None):
        self.iam=iam
        self.s3=s3 or Fake_S3({})

    def client(self, name):
        return self.s3 if name == "s3" else self.iam


ROLE_ARN="arn:aws:iam::222222222222:role/DeployWizardCrossAccountRole"


# 사용자 계정에 깔린 템플릿 버전 - 역할 태그로 읽는다. 태그가 없거나 읽을 권한이 없는 옛 스택은 0 (= 업데이트 필요)
def test_aws_account_template_version():
    from features.accounts.services import Aws_Account_Service

    iam=Fake_Iam(tags=[{"Key": "managed-by", "Value": "deploy-wizard"}, {"Key": "template-version", "Value": "2"}])
    assert Aws_Account_Service.services_aws_account_template_version(Fake_Iam_Session(iam), ROLE_ARN) == 2
    assert iam.asked == ["DeployWizardCrossAccountRole"]

    assert Aws_Account_Service.services_aws_account_template_version(Fake_Iam_Session(Fake_Iam(tags=[{"Key": "managed-by", "Value": "deploy-wizard"}])), ROLE_ARN) == 0
    assert Aws_Account_Service.services_aws_account_template_version(Fake_Iam_Session(Fake_Iam(denied=True)), ROLE_ARN) == 0


# 템플릿의 버전 태그와 코드의 TEMPLATE_VERSION 이 어긋나면 "업데이트 필요"가 영원히 뜨거나 영원히 안 뜬다
def test_aws_account_template_version_matches_template():
    from pathlib import Path

    template=(Path(accounts_module.__file__).parent / "cloudformation" / "deploy_wizard_role.yaml").read_text(encoding="utf-8")

    assert f"- Key: {accounts_module.TEMPLATE_VERSION_TAG}\n          Value: '{accounts_module.TEMPLATE_VERSION}'\n" in template
    assert "Action: iam:GetRole" in template


# [스택 업데이트 필요] 표시의 근거 - 옛 스택이면 update_needed, 최신이면 아니다. 연결 전이면 400
@pytest.mark.asyncio
async def test_aws_account_template_status_api(client, monkeypatch):
    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "222222222222")
    a_id=(await client.post("/api/accounts/aws", json={"label": "x"})).json()["a_id"]

    assert (await client.get(f"/api/accounts/aws/{a_id}/template-status")).status_code == 400

    iam=Fake_Iam(denied=True)
    s3=Fake_S3({"cf-templates-abc123-ap-northeast-2": ["2026-10-06T083009.545Zi8s-deploy_wizard_role.yaml", "other.yaml"]})
    monkeypatch.setattr(accounts_module, "get_assumed_session", lambda role_arn, external_id: Fake_Iam_Session(iam, s3))
    await client.patch(f"/api/accounts/aws/{a_id}/role-arn", json={"role_arn": ROLE_ARN})

    # 옛 스택 - 목록 권한도 없으니 파일은 세지 않는다 (버튼을 안 보여준다)
    body=(await client.get(f"/api/accounts/aws/{a_id}/template-status")).json()
    assert body["update_needed"] is True
    assert body["current_version"] == 0 and body["latest_version"] == accounts_module.TEMPLATE_VERSION
    assert body["template_file_count"] == 0
    assert body["template_download_url"] == "/api/accounts/aws/template"
    assert body["stack_list_url"].endswith("#/stacks")

    iam.denied=False
    iam.tags=[{"Key": "template-version", "Value": str(accounts_module.TEMPLATE_VERSION)}]
    body=(await client.get(f"/api/accounts/aws/{a_id}/template-status")).json()
    assert body["update_needed"] is False and body["current_version"] == accounts_module.TEMPLATE_VERSION
    assert body["template_file_count"] == 1

    # 지우고 나면 0 - 화면이 [템플릿 파일 삭제]를 숨기고 "남은 파일 없음"으로 바꾼다
    assert (await client.delete(f"/api/accounts/aws/{a_id}/template-files")).json()["deleted"] == 1
    s3.buckets["cf-templates-abc123-ap-northeast-2"]=["other.yaml"]
    assert (await client.get(f"/api/accounts/aws/{a_id}/template-status")).json()["template_file_count"] == 0


# 템플릿의 역할 이름과 코드의 상수가 어긋나면 연결된 계정 배포가 깨진다
def test_aws_account_template_role_names_match():
    from pathlib import Path

    template=(Path(accounts_module.__file__).parent / "cloudformation" / "deploy_wizard_role.yaml").read_text(encoding="utf-8")

    assert f"RoleName: {accounts_module.CFN_EXECUTION_ROLE_NAME}\n" in template
    assert f"RoleName: {accounts_module.CFN_INFRASTRUCTURE_ROLE_NAME}\n" in template


# 역할 ARN 등록 - AssumeRole 거부되면 invalid + 이유 저장, 재시도할 수 있게 예외를 400 으로
@pytest.mark.asyncio
async def test_aws_account_attach_role_failure_then_reverify(client, monkeypatch):
    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "333333333333")
    a_id=(await client.post("/api/accounts/aws", json={"label": "x"})).json()["a_id"]

    def fail_assume(role_arn, external_id):
        raise ClientError({"Error": {"Code": "AccessDenied", "Message": "not authorized to assume role"}}, "AssumeRole")

    monkeypatch.setattr(accounts_module, "get_assumed_session", fail_assume)

    response=await client.patch(f"/api/accounts/aws/{a_id}/role-arn", json={"role_arn": "arn:aws:iam::333333333333:role/x"})
    assert response.status_code == 400
    assert "확인하지 못했습니다" in response.json()["detail"]

    read=(await client.get(f"/api/accounts/aws/{a_id}")).json()
    assert read["status"] == "invalid"
    assert read["last_error"]

    # 스택을 고치고 다시 확인하면 verified 로 바뀐다
    monkeypatch.setattr(accounts_module, "get_assumed_session", lambda role_arn, external_id: object())
    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "333333333333")

    reverified=(await client.post(f"/api/accounts/aws/{a_id}/reverify")).json()
    assert reverified["status"] == "verified"


@pytest.mark.asyncio
async def test_aws_account_reverify_without_role_arn(client, monkeypatch):
    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "666666666666")
    a_id=(await client.post("/api/accounts/aws", json={"label": "x"})).json()["a_id"]
    assert (await client.post(f"/api/accounts/aws/{a_id}/reverify")).status_code == 400


# 삭제 - 연결이 없어져도 배포 기록은 그대로 (unlink 만)
@pytest.mark.asyncio
async def test_aws_account_delete(client, monkeypatch):
    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "444444444444")
    a_id=(await client.post("/api/accounts/aws", json={"label": "x"})).json()["a_id"]

    assert (await client.delete(f"/api/accounts/aws/{a_id}")).status_code == 200
    assert (await client.get(f"/api/accounts/aws/{a_id}")).status_code == 404


@pytest.mark.asyncio
async def test_aws_account_template_download(client):
    response=await client.get("/api/accounts/aws/template")
    assert response.status_code == 200
    assert "DeployWizardCrossAccountRole" in response.text
    assert "ExternalId" in response.text


# 연결 안 된 배포는 지금까지처럼 개발 세션을 그대로 쓴다 (M1~M5 동작 유지)
@pytest.mark.asyncio
async def test_build_session_falls_back_when_no_account(monkeypatch):
    from shared.database import AsyncSessionLocal

    sentinel=object()
    monkeypatch.setattr(accounts_module, "get_aws_session", lambda: sentinel)

    async with AsyncSessionLocal() as db:
        session=await accounts_module.Aws_Account_Service.services_aws_account_build_session(db, None)

    assert session is sentinel


# 연결은 있지만 role_arn 이 아직 없으면 ValueError - pipeline 이 일반 실패로 받도록
@pytest.mark.asyncio
async def test_build_session_raises_when_not_verified(client, monkeypatch):
    from shared.database import AsyncSessionLocal

    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "555555555555")
    a_id=(await client.post("/api/accounts/aws", json={"label": "x"})).json()["a_id"]

    with pytest.raises(ValueError):
        async with AsyncSessionLocal() as db:
            await accounts_module.Aws_Account_Service.services_aws_account_build_session(db, a_id)


# GitHub App JWT - 실제 RSA 키로 서명하고, 우리가 서명한 게 맞는지 검증까지 해본다
def test_github_app_jwt_is_signed_correctly(monkeypatch, tmp_path):
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization

    key=rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem=key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                          serialization.NoEncryption()).decode()
    key_path=tmp_path / "key.pem"
    key_path.write_text(pem)

    monkeypatch.setattr(accounts_module.settings, "github_app_id", "99999")
    monkeypatch.setattr(accounts_module.settings, "github_app_private_key_path", str(key_path))

    token=accounts_module.Github_Service.services_github_app_jwt()
    decoded=pyjwt.decode(token, key.public_key(), algorithms=["RS256"])

    assert decoded["iss"] == "99999"
    assert decoded["exp"] > decoded["iat"]


@pytest.mark.asyncio
async def test_github_install_url(client, monkeypatch):
    monkeypatch.setattr(accounts_module.settings, "github_app_slug", "deploy-wizard-test")

    response=await client.get("/api/accounts/github/install-url")
    assert response.json()["url"] == "https://github.com/apps/deploy-wizard-test/installations/new"

    # 운영자가 앱을 아직 등록하지 않았으면 깨진 주소(/apps//installations/new) 대신 한국어 안내
    monkeypatch.setattr(accounts_module.settings, "github_app_slug", None)
    response=await client.get("/api/accounts/github/install-url")
    assert response.status_code == 503
    assert "준비되지 않았습니다" in response.json()["detail"]


# 설치 콜백 - installation_id 를 받아 GitHub에서 계정 정보를 조회해 저장하고 화면으로 돌려보낸다
@pytest.mark.asyncio
async def test_github_callback_creates_installation(client, monkeypatch):
    monkeypatch.setattr(accounts_module.Github_Service, "services_github_app_jwt", staticmethod(lambda: "fake-jwt"))
    fake=Fake_Response(200, {"account": {"login": "kjfcvx12", "type": "User"}, "repository_selection": "selected"})
    monkeypatch.setattr(accounts_module.httpx, "AsyncClient", lambda *a, **kw: Fake_Async_Client(fake))

    response=await client.get("/api/accounts/github/callback", params={"installation_id": 555}, follow_redirects=False)
    assert response.status_code in (302, 307)
    assert response.headers["location"] == "/accounts?connected=github"

    installations=(await client.get("/api/accounts/github")).json()
    assert len(installations) == 1
    assert installations[0]["installation_id"] == 555
    assert installations[0]["account_login"] == "kjfcvx12"
    assert installations[0]["repository_selection"] == "selected"


# 연결 블록 - [+]로 빈 블록을 만들고, 그 안에서 AWS 와 GitHub 를 하나씩 잇는다. 블록을 지우면 AWS 연결은 같이, GitHub 설치는 남는다
@pytest.mark.asyncio
async def test_connection_block_flow(client, monkeypatch):
    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "222222222222")
    monkeypatch.setattr(accounts_module.Github_Service, "services_github_app_jwt", staticmethod(lambda: "fake-jwt"))
    monkeypatch.setattr(accounts_module.settings, "github_app_slug", "deploy-wizard-test")
    fake=Fake_Response(200, {"account": {"login": "kjfcvx12", "type": "User"}, "repository_selection": "selected"})
    monkeypatch.setattr(accounts_module.httpx, "AsyncClient", lambda *a, **kw: Fake_Async_Client(fake))

    assert (await client.get("/api/accounts/connections")).json() == []
    assert (await client.post("/api/accounts/connections", json={"label": ""})).status_code == 422

    block=(await client.post("/api/accounts/connections", json={"label": "운영"})).json()
    c_id=block["c_id"]
    assert block["aws"] is None and block["github"] is None

    # AWS - 블록 이름으로 계정이 만들어져 이어진다. 한 블록에 두 번은 안 된다
    setup=(await client.post(f"/api/accounts/connections/{c_id}/aws")).json()
    assert setup["label"] == "운영" and setup["external_id"]
    assert (await client.post(f"/api/accounts/connections/{c_id}/aws")).status_code == 409
    assert (await client.post("/api/accounts/connections/999/aws")).status_code == 404

    # GitHub - 설치 주소에 블록 번호를 state 로 싣고, 콜백이 그 블록에 잇는다
    url=(await client.get("/api/accounts/github/install-url", params={"c_id": c_id})).json()["url"]
    assert url == f"https://github.com/apps/deploy-wizard-test/installations/new?state={c_id}"
    await client.get("/api/accounts/github/callback", params={"installation_id": 555, "state": str(c_id)}, follow_redirects=False)

    block=(await client.get("/api/accounts/connections")).json()[0]
    assert block["aws"]["a_id"] == setup["a_id"] and block["aws"]["status"] == "pending"
    assert block["github"]["account_login"] == "kjfcvx12"
    g_id=block["github"]["g_id"]

    # 두 번째 블록은 이미 연결한 GitHub 를 골라 쓴다 (설치는 GitHub 계정마다 하나). 없는 설치는 404, null 이면 뗀다
    other=(await client.post("/api/accounts/connections", json={"label": "개발"})).json()["c_id"]
    assert (await client.patch(f"/api/accounts/connections/{other}", json={"github_installation_id": 999})).status_code == 404
    assert (await client.patch(f"/api/accounts/connections/{other}", json={"github_installation_id": g_id})).json()["github"]["g_id"] == g_id

    # 보내지 않은 쪽은 그대로다 - AWS 만 잇거나 떼도 GitHub 는 남는다
    shared=(await client.patch(f"/api/accounts/connections/{other}", json={"aws_account_id": setup["a_id"]})).json()
    assert shared["aws"]["a_id"] == setup["a_id"] and shared["github"]["g_id"] == g_id
    assert (await client.patch(f"/api/accounts/connections/{other}", json={"aws_account_id": None})).json()["github"]["g_id"] == g_id

    assert (await client.patch(f"/api/accounts/connections/{other}", json={"github_installation_id": None})).json()["github"] is None

    # 블록 삭제 - AWS 계정 연결은 같이 지워지고 GitHub 설치는 남는다
    assert (await client.delete(f"/api/accounts/connections/{c_id}")).status_code == 200
    assert (await client.get(f"/api/accounts/aws/{setup['a_id']}")).status_code == 404
    assert len((await client.get("/api/accounts/github")).json()) == 1
    assert [b["label"] for b in (await client.get("/api/accounts/connections")).json()] == ["개발"]


# 블록의 AWS 계정 바꾸기 - 이미 연결한 계정을 [선택]으로 잇는다. 여러 블록이 같은 계정을 가리킬 수 있다
@pytest.mark.asyncio
async def test_connection_select_aws_account(client, monkeypatch):
    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "222222222222")

    first=(await client.post("/api/accounts/connections", json={"label": "운영"})).json()["c_id"]
    second=(await client.post("/api/accounts/connections", json={"label": "개발"})).json()["c_id"]
    a_first=(await client.post(f"/api/accounts/connections/{first}/aws")).json()["a_id"]
    a_second=(await client.post(f"/api/accounts/connections/{second}/aws")).json()["a_id"]

    assert (await client.patch(f"/api/accounts/connections/{first}", json={"aws_account_id": 999})).status_code == 404
    assert (await client.patch(f"/api/accounts/connections/{first}", json={"aws_account_id": a_second})).json()["aws"]["a_id"] == a_second

    # 떨어져 나온 계정은 블록이 새로 생기지 않고 그대로 남아 다시 고를 수 있다
    blocks=(await client.get("/api/accounts/connections")).json()
    assert [(b["label"], b["aws"]["a_id"]) for b in blocks] == [("운영", a_second), ("개발", a_second)]
    assert len((await client.get("/api/accounts/aws")).json()) == 2

    # 같이 쓰는 계정은 블록 하나를 지워도 남고, 마지막으로 쓰던 블록을 지우면 같이 지워진다
    await client.delete(f"/api/accounts/connections/{first}")
    assert (await client.get(f"/api/accounts/aws/{a_second}")).status_code == 200
    await client.delete(f"/api/accounts/connections/{second}")
    assert (await client.get(f"/api/accounts/aws/{a_second}")).status_code == 404

    # 블록이 하나도 없으면 남은 계정에 블록이 생겨 화면에서 사라지지 않는다
    blocks=(await client.get("/api/accounts/connections")).json()
    assert [(b["label"], b["aws"]["a_id"]) for b in blocks] == [("운영", a_first)]


# 블록 도입 전에 연결한 AWS 계정은 목록을 읽을 때 블록이 생긴다. AWS 계정을 따로 지우면 블록에서 떨어진다
@pytest.mark.asyncio
async def test_connection_backfills_existing_aws_account(client, monkeypatch):
    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "222222222222")
    a_id=(await client.post("/api/accounts/aws", json={"label": "예전 연결"})).json()["a_id"]

    blocks=(await client.get("/api/accounts/connections")).json()
    assert [(b["label"], b["aws"]["a_id"], b["github"]) for b in blocks] == [("예전 연결", a_id, None)]
    assert len((await client.get("/api/accounts/connections")).json()) == 1

    await client.delete(f"/api/accounts/aws/{a_id}")
    blocks=(await client.get("/api/accounts/connections")).json()
    assert len(blocks) == 1 and blocks[0]["aws"] is None


# 블록 도입 전 데이터가 AWS 하나·GitHub 하나뿐이면 한 블록으로 묶어 준다 (누가 봐도 한 쌍)
@pytest.mark.asyncio
async def test_connection_backfill_pairs_single_aws_and_github(client, monkeypatch):
    monkeypatch.setattr(accounts_module, "get_account_id", lambda session: "222222222222")
    monkeypatch.setattr(accounts_module.Github_Service, "services_github_app_jwt", staticmethod(lambda: "fake-jwt"))
    fake=Fake_Response(200, {"account": {"login": "kjfcvx12", "type": "User"}, "repository_selection": "selected"})
    monkeypatch.setattr(accounts_module.httpx, "AsyncClient", lambda *a, **kw: Fake_Async_Client(fake))

    a_id=(await client.post("/api/accounts/aws", json={"label": "test"})).json()["a_id"]
    await client.get("/api/accounts/github/callback", params={"installation_id": 555}, follow_redirects=False)

    blocks=(await client.get("/api/accounts/connections")).json()
    assert len(blocks) == 1
    assert blocks[0]["aws"]["a_id"] == a_id and blocks[0]["github"]["account_login"] == "kjfcvx12"


# 연결 확인 - 설치 토큰으로 실제 접근해 본 결과(레포 수·이름). 연결이 끊겼으면 한국어 400
@pytest.mark.asyncio
async def test_github_installation_check(client, monkeypatch):
    monkeypatch.setattr(accounts_module.Github_Service, "services_github_app_jwt", staticmethod(lambda: "fake-jwt"))
    fake=Fake_Response(200, {"account": {"login": "kjfcvx12", "type": "User"}, "repository_selection": "selected",
                             "token": "ghs_abc123", "total_count": 2,
                             "repositories": [{"full_name": "kjfcvx12/a"}, {"full_name": "kjfcvx12/b"}]})
    monkeypatch.setattr(accounts_module.httpx, "AsyncClient", lambda *a, **kw: Fake_Async_Client(fake))

    await client.get("/api/accounts/github/callback", params={"installation_id": 555}, follow_redirects=False)
    g_id=(await client.get("/api/accounts/github")).json()[0]["g_id"]

    body=(await client.get(f"/api/accounts/github/{g_id}/check")).json()
    assert body["account_login"] == "kjfcvx12"
    assert body["repository_count"] == 2
    assert body["repositories"] == ["kjfcvx12/a", "kjfcvx12/b"]

    assert (await client.get("/api/accounts/github/999/check")).status_code == 404

    monkeypatch.setattr(accounts_module.httpx, "AsyncClient", lambda *a, **kw: Fake_Async_Client(Fake_Response(401, {})))
    response=await client.get(f"/api/accounts/github/{g_id}/check")
    assert response.status_code == 400
    assert "확인하지 못했습니다" in response.json()["detail"]


# 레포 목록 - 설치가 읽을 수 있는 레포의 주소를 돌려준다 (새 배포 폼의 주소 목록). 주소가 없으면 이름으로 만든다
@pytest.mark.asyncio
async def test_github_installation_repositories(client, monkeypatch):
    monkeypatch.setattr(accounts_module.Github_Service, "services_github_app_jwt", staticmethod(lambda: "fake-jwt"))
    fake=Fake_Response(200, {"account": {"login": "kjfcvx12", "type": "User"}, "repository_selection": "all",
                             "token": "ghs_abc123", "total_count": 2,
                             "repositories": [{"full_name": "kjfcvx12/a", "html_url": "https://github.com/kjfcvx12/a",
                                               "private": True, "default_branch": "main"},
                                              {"full_name": "kjfcvx12/b"}]})
    monkeypatch.setattr(accounts_module.httpx, "AsyncClient", lambda *a, **kw: Fake_Async_Client(fake))

    await client.get("/api/accounts/github/callback", params={"installation_id": 555}, follow_redirects=False)
    g_id=(await client.get("/api/accounts/github")).json()[0]["g_id"]

    body=(await client.get(f"/api/accounts/github/{g_id}/repositories")).json()
    assert body == [{"full_name": "kjfcvx12/a", "html_url": "https://github.com/kjfcvx12/a", "private": True, "default_branch": "main"},
                    {"full_name": "kjfcvx12/b", "html_url": "https://github.com/kjfcvx12/b", "private": False, "default_branch": None}]

    assert (await client.get("/api/accounts/github/999/repositories")).status_code == 404

    monkeypatch.setattr(accounts_module.httpx, "AsyncClient", lambda *a, **kw: Fake_Async_Client(Fake_Response(401, {})))
    response=await client.get(f"/api/accounts/github/{g_id}/repositories")
    assert response.status_code == 400
    assert "불러오지 못했습니다" in response.json()["detail"]


# 클론용 설치 토큰 - 성공하면 토큰 문자열, 최소 권한(contents/metadata)만 요청한다
@pytest.mark.asyncio
async def test_github_installation_token_success(monkeypatch):
    monkeypatch.setattr(accounts_module.Github_Service, "services_github_app_jwt", staticmethod(lambda: "fake-jwt"))
    fake=Fake_Response(201, {"token": "ghs_abc123"})
    monkeypatch.setattr(accounts_module.httpx, "AsyncClient", lambda *a, **kw: Fake_Async_Client(fake))

    token=await accounts_module.Github_Service.services_github_installation_token(555)
    assert token == "ghs_abc123"


# 배포에 저장되는 것은 우리 g_id, GitHub API 가 받는 것은 GitHub 의 installation_id - 둘을 섞으면 실제 GitHub 에서 404 가 난다
# (mock 테스트가 토큰 함수를 통째로 막아서 오랫동안 못 잡았던 버그. 여기서는 번호가 실제로 바뀌는지를 본다)
@pytest.mark.asyncio
async def test_github_token_by_g_id_uses_github_installation_id(client, monkeypatch):
    from shared.database import AsyncSessionLocal

    monkeypatch.setattr(accounts_module.Github_Service, "services_github_app_jwt", staticmethod(lambda: "fake-jwt"))
    fake=Fake_Response(200, {"account": {"login": "kjfcvx12", "type": "User"}, "repository_selection": "all"})
    monkeypatch.setattr(accounts_module.httpx, "AsyncClient", lambda *a, **kw: Fake_Async_Client(fake))

    await client.get("/api/accounts/github/callback", params={"installation_id": 168503578}, follow_redirects=False)
    g_id=(await client.get("/api/accounts/github")).json()[0]["g_id"]
    assert g_id != 168503578

    asked=[]
    async def spy_token(installation_id, permissions=None):
        asked.append(installation_id)
        return "ghs_abc123"

    monkeypatch.setattr(accounts_module.Github_Service, "services_github_installation_token", staticmethod(spy_token))

    async with AsyncSessionLocal() as db:
        assert await accounts_module.Github_Service.services_github_token_by_g_id(db, g_id) == "ghs_abc123"
        assert asked == [168503578]

        with pytest.raises(ValueError):
            await accounts_module.Github_Service.services_github_token_by_g_id(db, 999)


# 설치가 끊겼으면(401/404) ValueError - pipeline이 일반 실패로 받도록. HTTPException이 아니다
@pytest.mark.asyncio
async def test_github_installation_token_failure_is_value_error(monkeypatch):
    monkeypatch.setattr(accounts_module.Github_Service, "services_github_app_jwt", staticmethod(lambda: "fake-jwt"))
    fake=Fake_Response(401, {"message": "Bad credentials"})
    monkeypatch.setattr(accounts_module.httpx, "AsyncClient", lambda *a, **kw: Fake_Async_Client(fake))

    with pytest.raises(ValueError):
        await accounts_module.Github_Service.services_github_installation_token(555)


# 삭제 - 쓰던 배포는 남기고 연결만 뗀다 (GitHub 앱 자체는 지우지 않는다)
@pytest.mark.asyncio
async def test_github_installation_delete(client, monkeypatch):
    monkeypatch.setattr(accounts_module.Github_Service, "services_github_app_jwt", staticmethod(lambda: "fake-jwt"))
    fake=Fake_Response(200, {"account": {"login": "o", "type": "Organization"}, "repository_selection": "all"})
    monkeypatch.setattr(accounts_module.httpx, "AsyncClient", lambda *a, **kw: Fake_Async_Client(fake))

    await client.get("/api/accounts/github/callback", params={"installation_id": 777}, follow_redirects=False)
    g_id=(await client.get("/api/accounts/github")).json()[0]["g_id"]

    assert (await client.delete(f"/api/accounts/github/{g_id}")).status_code == 200
    assert (await client.get("/api/accounts/github")).json() == []


@pytest.mark.asyncio
async def test_github_installation_delete_404(client):
    assert (await client.delete("/api/accounts/github/999")).status_code == 404
