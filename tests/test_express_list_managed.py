import pytest
from botocore.exceptions import ClientError

from features.express.services import Express_Service


ACCOUNT="123456789012"


# 서비스 ARN 만들기 - 클러스터가 없으면 옛 형식
def arn_service(name:str, cluster:str|None="default") -> str:
    path=f"{cluster}/{name}" if cluster else name
    return f"arn:aws:ecs:ap-northeast-2:{ACCOUNT}:service/{path}"


class Fake_Paginator:
    def __init__(self, arns):
        self.arns=arns

    def paginate(self, **kwargs):
        # 페이지를 둘로 쪼개 돌려준다
        items=[{"ResourceARN": arn} for arn in self.arns]
        half=len(items) // 2
        return [{"ResourceTagMappingList": items[:half]}, {"ResourceTagMappingList": items[half:]}]


class Fake_Tagging:
    def __init__(self, arns):
        self.arns=arns

    def get_paginator(self, name):
        assert name == "get_resources"
        return Fake_Paginator(self.arns)


class Fake_Ecs:
    def __init__(self, states:dict, raise_error:bool=False):
        # states: 서비스 ARN -> ACTIVE|DRAINING|INACTIVE|MISSING
        self.states=states
        self.raise_error=raise_error
        self.calls=[]

    def describe_services(self, cluster, services):
        self.calls.append({"cluster": cluster, "services": list(services)})
        assert len(services) <= 10
        if self.raise_error:
            raise ClientError({"Error": {"Code": "AccessDeniedException", "Message": "no"}}, "DescribeServices")

        found=[]
        failures=[]
        for arn in services:
            state=self.states.get(arn, "MISSING")
            if state == "MISSING":
                failures.append({"arn": arn, "reason": "MISSING"})
            else:
                found.append({"serviceArn": arn, "status": state})
        return {"services": found, "failures": failures}


class Fake_Session:
    def __init__(self, arns, ecs):
        self.tagging=Fake_Tagging(arns)
        self.ecs=ecs

    def client(self, name):
        if name == "resourcegroupstaggingapi":
            return self.tagging
        if name == "ecs":
            return self.ecs
        raise AssertionError(name)


# 삭제가 끝난(INACTIVE) 서비스는 정리 대상에서 뺀다
def test_express_list_managed_excludes_inactive():
    arn=arn_service("dw-gone")
    session=Fake_Session([arn], Fake_Ecs({arn: "INACTIVE"}))

    assert Express_Service.services_express_list_managed(session) == []


# ACTIVE 와 DRAINING 은 아직 끝나지 않았으니 그대로 보인다
def test_express_list_managed_keeps_active_and_draining():
    active=arn_service("dw-live")
    draining=arn_service("dw-draining")
    session=Fake_Session([active, draining], Fake_Ecs({active: "ACTIVE", draining: "DRAINING"}))

    result=Express_Service.services_express_list_managed(session)

    assert {item.arn for item in result} == {active, draining}
    assert all(item.kind == "ecs_service" for item in result)


# describe 가 MISSING 으로 돌려주면 서비스가 이미 없는 것이니 뺀다
def test_express_list_managed_excludes_missing():
    arn=arn_service("dw-vanished")
    session=Fake_Session([arn], Fake_Ecs({}))

    assert Express_Service.services_express_list_managed(session) == []


# 그 밖의 실패 사유는 확신할 수 없으니 남겨 둔다
def test_express_list_managed_keeps_unknown_failure():
    arn=arn_service("dw-odd")

    class Odd_Ecs(Fake_Ecs):
        def describe_services(self, cluster, services):
            return {"services": [], "failures": [{"arn": services[0], "reason": "SOMETHING_ELSE"}]}

    session=Fake_Session([arn], Odd_Ecs({}))

    assert [item.arn for item in Express_Service.services_express_list_managed(session)] == [arn]


# ECR 리포지토리는 describe_services 를 거치지 않고 그대로 나온다
def test_express_list_managed_ecr_unaffected():
    repo=f"arn:aws:ecr:ap-northeast-2:{ACCOUNT}:repository/dw-app"
    ecs=Fake_Ecs({})
    session=Fake_Session([repo], ecs)

    result=Express_Service.services_express_list_managed(session)

    assert [(item.kind, item.arn, item.name) for item in result] == [("ecr_repository", repo, "dw-app")]
    assert ecs.calls == []


# 한 번에 10개까지만 묻고, 클러스터별로 나눈다
def test_express_list_managed_batches_by_cluster_and_ten():
    arns=[arn_service(f"dw-{i}", "default") for i in range(23)] + [arn_service("dw-x", "other")]
    states={arn: "ACTIVE" for arn in arns}
    ecs=Fake_Ecs(states)
    session=Fake_Session(arns, ecs)

    result=Express_Service.services_express_list_managed(session)

    assert len(result) == 24
    assert sorted(len(call["services"]) for call in ecs.calls if call["cluster"] == "default") == [3, 10, 10]
    assert [call["services"] for call in ecs.calls if call["cluster"] == "other"] == [[arns[-1]]]


# 클러스터 이름이 없는 옛 형식 ARN 은 죽지 않고 그대로 남긴다
def test_express_list_managed_old_arn_format_kept():
    arn=arn_service("dw-old", None)
    ecs=Fake_Ecs({})
    session=Fake_Session([arn], ecs)

    result=Express_Service.services_express_list_managed(session)

    assert [item.arn for item in result] == [arn]
    assert ecs.calls == []


# describe 호출이 막히면 상태를 모르니 전부 남겨 둔다 (지우지 못하는 쪽이 안전)
def test_express_list_managed_describe_error_keeps_all():
    arn=arn_service("dw-live")
    session=Fake_Session([arn], Fake_Ecs({arn: "INACTIVE"}, raise_error=True))

    assert [item.arn for item in Express_Service.services_express_list_managed(session)] == [arn]
