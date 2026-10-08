import sys
import pytest

from shared.masking import mask_text
from shared.proc import proc_run, Proc_Error

from features.explains.services import Explain_Service
from features.express.services import Express_Service


@pytest.mark.parametrize("secret", [
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAIOSFODNN7EXAMPLE",
    "sk-ant-api03-abcdefghijklmnop",
])
def test_mask_tokens(secret):
    assert secret not in mask_text(f"error while using {secret} here")


def test_mask_url_password_and_assign():
    masked=mask_text("fatal: https://user:hunter2@github.com/o/r DB_PASSWORD=swordfish")

    assert "hunter2" not in masked
    assert "swordfish" not in masked
    assert "github.com/o/r" in masked


def test_proc_run_ok_and_fail():
    assert "hi" in proc_run([sys.executable, "-c", "print('hi')"])

    with pytest.raises(Proc_Error) as e:
        proc_run([sys.executable, "-c", "import sys; print('boom'); sys.exit(3)"])
    assert "boom" in e.value.output


def test_proc_run_timeout():
    with pytest.raises(Proc_Error) as e:
        proc_run([sys.executable, "-c", "import time; time.sleep(30)"], timeout=1)
    assert "시간 초과" in str(e.value)


def test_proc_run_missing_command():
    with pytest.raises(Proc_Error):
        proc_run(["definitely-not-a-command-xyz"])


@pytest.mark.asyncio
@pytest.mark.parametrize("log, keyword", [
    ("exec /usr/local/bin/python: exec format error", "아키텍처"),
    ("denied: Your authorization token has expired. Reauthenticate and try again.", "ECR"),
    ("User: arn:aws:iam::1:user/x is not authorized to perform: ecs:CreateExpressGatewayService", "권한"),
    ("Cannot connect to the Docker daemon at npipe", "Docker"),
    ("remote: Repository not found.", "레포"),
    ("AWS 계정 연결이 완료되지 않았습니다", "AWS"),
    ("GitHub 연결이 끊어졌습니다. 다시 설치해 주세요.", "GitHub"),
])
async def test_explain_by_rule(log, keyword):
    result=await Explain_Service.services_explain_error("building", log)

    assert result.source == "rule"
    assert keyword in result.summary
    assert result.actions


# 모르는 에러 + LLM 꺼짐 -> 죽지 않고 기본 안내
@pytest.mark.asyncio
async def test_explain_unknown_without_llm():
    result=await Explain_Service.services_explain_error("deploying", "something nobody has seen")

    assert result.source == "none"


class Fake_Ecs:
    def create_express_gateway_service(self, **params):
        self.params=params
        return {"service": {"serviceArn": "arn:svc", "serviceName": params["serviceName"],
                            "status": {"statusCode": "ACTIVE"}, "activeConfigurations": []}}


class Fake_Session:
    def __init__(self):
        self.ecs=Fake_Ecs()

    def client(self, name):
        return self.ecs


# 연결된 계정(M6)이면 넘겨받은 역할을 쓰고, 아니면 .env 값 - 둘 다 없으면 만드는 법을 알려준다
def test_express_create_role_arns(monkeypatch):
    from features.express import services as express_module

    monkeypatch.setattr(express_module.settings, "ecs_execution_role_arn", None)
    monkeypatch.setattr(express_module.settings, "ecs_infrastructure_role_arn", None)

    session=Fake_Session()
    Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000,
                                            role_arns=("arn:user:exec", "arn:user:infra"))

    assert session.ecs.params["executionRoleArn"] == "arn:user:exec"
    assert session.ecs.params["infrastructureRoleArn"] == "arn:user:infra"
    assert session.ecs.params["tags"] == [{"key": "managed-by", "value": "deploy-wizard"}]

    with pytest.raises(express_module.Express_Error):
        Express_Service.services_express_create(Fake_Session(), "dw-x-1", "img:1", 8000)


# describe 응답에서 공개 주소를 꺼낸다
def test_express_to_status_endpoint():
    status=Express_Service.services_express_to_status({
        "serviceArn": "arn:aws:ecs:ap-northeast-2:1:service/default/dw-x-1",
        "serviceName": "dw-x-1",
        "status": {"statusCode": "ACTIVE"},
        "activeConfigurations": [{"ingressPaths": [
            {"accessType": "PRIVATE", "endpoint": "internal.example"},
            {"accessType": "PUBLIC", "endpoint": "dw-x-1.ecs.ap-northeast-2.on.aws"},
        ]}],
    })

    assert status.status_code == "ACTIVE"
    assert status.endpoint == "https://dw-x-1.ecs.ap-northeast-2.on.aws"
