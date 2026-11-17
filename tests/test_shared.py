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


class Draining_Ecs(Fake_Ecs):
    def __init__(self, drains:int):
        self.drains=drains
        self.calls=0

    def create_express_gateway_service(self, **params):
        self.calls+=1
        if self.calls <= self.drains:
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "InvalidParameterException",
                                         "Message": "Unable to Start a service that is still Draining."}},
                              "CreateExpressGatewayService")
        return super().create_express_gateway_service(**params)


# 같은 이름의 옛 서비스가 DRAINING 이면 기다렸다가 다시 만든다 - 안내는 한 번만
def test_express_create_waits_while_draining(monkeypatch):
    from features.express import services as express_module

    monkeypatch.setattr(express_module.settings, "deploy_poll_seconds", 0)
    session=Fake_Session()
    session.ecs=Draining_Ecs(drains=3)
    messages=[]

    result=Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000,
                                                   role_arns=("arn:e", "arn:i"), on_progress=messages.append)

    assert result.service_arn == "arn:svc"
    assert session.ecs.calls == 4
    assert len(messages) == 1


# DRAINING 이 시간 안에 안 끝나면 그 오류를 그대로 올린다
def test_express_create_gives_up_when_draining_too_long(monkeypatch):
    from botocore.exceptions import ClientError
    from features.express import services as express_module

    monkeypatch.setattr(express_module.settings, "deploy_poll_seconds", 0)
    monkeypatch.setattr(express_module.settings, "deploy_timeout", 0)
    session=Fake_Session()
    session.ecs=Draining_Ecs(drains=99)

    with pytest.raises(ClientError):
        Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000, role_arns=("arn:e", "arn:i"))


# 다른 오류는 기다리지 않고 바로 올린다
def test_express_create_other_errors_not_retried(monkeypatch):
    from botocore.exceptions import ClientError
    from features.express import services as express_module

    class Other_Ecs(Fake_Ecs):
        calls=0

        def create_express_gateway_service(self, **params):
            Other_Ecs.calls+=1
            raise ClientError({"Error": {"Code": "AccessDeniedException", "Message": "nope"}}, "CreateExpressGatewayService")

    monkeypatch.setattr(express_module.settings, "deploy_poll_seconds", 0)
    session=Fake_Session()
    session.ecs=Other_Ecs()

    with pytest.raises(ClientError):
        Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000, role_arns=("arn:e", "arn:i"))

    assert Other_Ecs.calls == 1


# 증설 설정은 4개가 다 있을 때만 scalingTarget 으로 보낸다 - 없으면 키 자체가 없다
def test_express_create_scaling_target():
    scaling={"minTaskCount": 1, "maxTaskCount": 3, "autoScalingMetric": "AVERAGE_CPU", "autoScalingTargetValue": 60}

    session=Fake_Session()
    Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000, role_arns=("arn:e", "arn:i"), scaling=scaling)
    assert session.ecs.params["scalingTarget"] == scaling

    session=Fake_Session()
    Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000, role_arns=("arn:e", "arn:i"))
    assert "scalingTarget" not in session.ecs.params

    # 일부만 있으면 보내지 않는다
    session=Fake_Session()
    Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000, role_arns=("arn:e", "arn:i"), scaling={"minTaskCount": 1})
    assert "scalingTarget" not in session.ecs.params


# cpu·memory - 인자 > .env 값 > 보내지 않음
def test_express_create_passes_cpu_memory(monkeypatch):
    from features.express import services as express_module

    monkeypatch.setattr(express_module.settings, "ecs_cpu", None)
    monkeypatch.setattr(express_module.settings, "ecs_memory", None)

    session=Fake_Session()
    Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000, role_arns=("arn:e", "arn:i"), cpu="512", memory="1024")
    assert session.ecs.params["cpu"] == "512" and session.ecs.params["memory"] == "1024"

    monkeypatch.setattr(express_module.settings, "ecs_cpu", "256")
    monkeypatch.setattr(express_module.settings, "ecs_memory", "512")

    session=Fake_Session()
    Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000, role_arns=("arn:e", "arn:i"))
    assert session.ecs.params["cpu"] == "256" and session.ecs.params["memory"] == "512"

    session=Fake_Session()
    Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000, role_arns=("arn:e", "arn:i"), cpu="1024", memory="2048")
    assert session.ecs.params["cpu"] == "1024" and session.ecs.params["memory"] == "2048"

    monkeypatch.setattr(express_module.settings, "ecs_cpu", None)
    monkeypatch.setattr(express_module.settings, "ecs_memory", None)

    session=Fake_Session()
    Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000, role_arns=("arn:e", "arn:i"))
    assert "cpu" not in session.ecs.params and "memory" not in session.ecs.params


# 기존 서비스 갱신은 사양·증설을 건드리지 않는다 (확인을 거친 재배포 몫) - 보내는 키는 그대로
def test_express_update_params_unchanged():
    class Update_Ecs:
        def update_express_gateway_service(self, **params):
            self.params=params

    session=Fake_Session()
    session.ecs=Update_Ecs()

    Express_Service.services_express_update(session, "arn:svc", "img:2", 8000, "/health", environment={"A": "1"})

    assert set(session.ecs.params) == {"serviceArn", "healthCheckPath", "primaryContainer"}


# 사양을 정하지 않은 배포 - 비용 추정이 가정한 사양과 서비스 생성이 실제로 보내는 사양이 같다 (.env 의 유효한 프리셋 쌍)
def test_express_create_matches_default_estimate_with_valid_env(monkeypatch):
    from shared.settings import settings
    from features.pricing.scheme import Price_Table
    from features.pricing.services import Pricing_Service

    table=Price_Table(region="ap-northeast-2", basis_date="2026-11-11", fargate_vcpu_hour=0.04656, fargate_gb_hour=0.00511, alb_hour=0.0225)
    monkeypatch.setattr(settings, "ecs_cpu", "512")
    monkeypatch.setattr(settings, "ecs_memory", "1024")

    estimate=Pricing_Service.services_pricing_estimate(table)
    session=Fake_Session()
    Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000, role_arns=("arn:e", "arn:i"))

    assert (estimate.cpu, estimate.memory) == ("512", "1024")
    assert (session.ecs.params["cpu"], session.ecs.params["memory"]) == (estimate.cpu, estimate.memory)


# .env 쌍이 프리셋이 아니거나 한쪽뿐이면 둘 다 무시한다 - 추정은 256/512, 생성은 사양을 보내지 않고, 경고를 남긴다
@pytest.mark.parametrize("cpu, memory", [("1024", "4096"), ("300", "512"), ("1024", None), (None, "2048")])
def test_express_create_ignores_invalid_env_pair(monkeypatch, caplog, cpu, memory):
    import logging
    from shared.settings import settings
    from features.pricing.scheme import Price_Table
    from features.pricing.services import Pricing_Service

    table=Price_Table(region="ap-northeast-2", basis_date="2026-11-11", fargate_vcpu_hour=0.04656, fargate_gb_hour=0.00511, alb_hour=0.0225)
    monkeypatch.setattr(settings, "ecs_cpu", cpu)
    monkeypatch.setattr(settings, "ecs_memory", memory)

    estimate=Pricing_Service.services_pricing_estimate(table)
    session=Fake_Session()
    with caplog.at_level(logging.WARNING, logger="features.express.services"):
        Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000, role_arns=("arn:e", "arn:i"))

    assert (estimate.cpu, estimate.memory) == ("256", "512")
    assert "cpu" not in session.ecs.params and "memory" not in session.ecs.params
    assert any("ECS_CPU" in record.getMessage() for record in caplog.records)


# 배포별 사양이 있으면 .env 는 보지 않는다 (잘못된 .env 여도 경고도 없다)
def test_express_create_explicit_spec_skips_env(monkeypatch, caplog):
    import logging
    from shared.settings import settings

    monkeypatch.setattr(settings, "ecs_cpu", "1024")
    monkeypatch.setattr(settings, "ecs_memory", "4096")

    session=Fake_Session()
    with caplog.at_level(logging.WARNING, logger="features.express.services"):
        Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000, role_arns=("arn:e", "arn:i"), cpu="256", memory="512")

    assert (session.ecs.params["cpu"], session.ecs.params["memory"]) == ("256", "512")
    assert not caplog.records


# .env 가 비어 있으면(ECS_CPU= 처럼 빈 글자) 안 적은 것과 같고 경고도 없다
def test_express_create_blank_env_is_silent(monkeypatch, caplog):
    import logging
    from shared.settings import settings

    monkeypatch.setattr(settings, "ecs_cpu", "")
    monkeypatch.setattr(settings, "ecs_memory", "")

    session=Fake_Session()
    with caplog.at_level(logging.WARNING, logger="features.express.services"):
        Express_Service.services_express_create(session, "dw-x-1", "img:1", 8000, role_arns=("arn:e", "arn:i"))

    assert "cpu" not in session.ecs.params and "memory" not in session.ecs.params
    assert not caplog.records


# 로그인 토큰(dwr_·dwp_)과 암호문(gAAAAA…)도 가린다
def test_mask_text_hides_auth_tokens():
    refresh="dwr_" + "A1b2C3d4E5" * 4 + "xyz"
    pat="dwp_" + "Z9y8X7w6V5" * 4 + "abc"
    cipher="gAAAAA" + "Qw3rTy-_9" * 12
    jwt="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij1234567890"

    for secret in (refresh, pat, cipher, jwt):
        masked=mask_text(f"요청 실패 {secret} 끝")
        assert secret not in masked
        assert "****" in masked
        assert masked.startswith("요청 실패 ") and masked.endswith(" 끝")

    assert len(refresh) == 4 + 43
    assert mask_text("배포가 끝났습니다. 주소는 곧 나옵니다.") == "배포가 끝났습니다. 주소는 곧 나옵니다."
