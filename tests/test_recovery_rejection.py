import pytest
from botocore.exceptions import (ClientError, ReadTimeoutError, ParamValidationError, NoCredentialsError, PartialCredentialsError,
                                 EndpointConnectionError)

from shared.database import AsyncSessionLocal

from features.deploys.models import Deploy_Release
from features.incidents.recovery import Recovery_Service, Recovery_State, UNRECORDED_DETAIL, RESUME_DETAIL
from features.incidents.models import Recovery_Action

from recovery_helpers import (_now, db, notified, aws_session, Fakes, make_deploy, make_incident, add_action, fresh_incident,
                              action_rows, CUR_IMAGE, PREV_IMAGE)

pytestmark=pytest.mark.usefixtures("aws_session")


def client_error(code, http_status, retries=0, message="x"):
    return ClientError({"Error": {"Code": code, "Message": message},
                        "ResponseMetadata": {"HTTPStatusCode": http_status, "RetryAttempts": retries}}, "UpdateExpressGatewayService")


# (오류, AWS 가 적용하지 않았다고 볼 수 있는가) - 확실하지 않으면 False (표식을 남긴다)
REJECTION_CASES=[
    (client_error("AccessDeniedException", 403), True),
    (client_error("ValidationException", 400), True),
    (client_error("ValidationException", 400, retries=2), False),
    (client_error("ThrottlingException", 429), False),
    (client_error("ThrottlingException", 400), False),
    (client_error("RequestLimitExceeded", 400), False),
    (client_error("TooManyRequestsException", 429), False),
    (client_error("TooManyRequests", 429), False),
    (client_error("InternalFailure", 500), False),
    (client_error("ServiceUnavailable", 503), False),
    (client_error("RequestTimeout", 400), False),
    (client_error("RequestTimeoutException", 400), False),
    (client_error("ConflictException", 409), False),
    (client_error("ResourceConflictException", 400), False),
    (ClientError({"Error": {"Code": "AccessDeniedException", "Message": "x"}}, "UpdateExpressGatewayService"), False),
    (ReadTimeoutError(endpoint_url="https://ecs.ap-northeast-2.amazonaws.com"), False),
    (EndpointConnectionError(endpoint_url="https://ecs.ap-northeast-2.amazonaws.com"), False),
    (TimeoutError("timed out"), False),
    (ParamValidationError(report="Invalid type for parameter x"), True),
    (NoCredentialsError(), True),
    (PartialCredentialsError(provider="env", cred_var="AWS_SECRET_ACCESS_KEY"), True),
]


@pytest.mark.parametrize("error,rejected", REJECTION_CASES, ids=[f"{type(e).__name__}-{i}" for i, (e, _) in enumerate(REJECTION_CASES)])
def test_update_rejected_decision_table(error, rejected):
    assert Recovery_State.services_recovery_update_rejected(error) is rejected


# 재시도 끝에 나온 오류는 표식을 남기고, 이후 자동 복구는 AWS 를 부르지 않는다
@pytest.mark.asyncio
async def test_rollback_retried_client_error_is_marked_and_blocks_later_actions(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='bad_release')
    fakes=Fakes(fail_update=client_error("InternalFailure", 500, retries=4))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    rows=await action_rows(i_id)
    assert [(row.action, row.result) for row in rows] == [('rollback', 'failed')]
    assert rows[0].detail.startswith(UNRECORDED_DETAIL)

    later=await make_incident(db, d_id, kind='unhealthy')
    again=Fakes(healthy_images=(CUR_IMAGE, PREV_IMAGE))
    # 실제로는 인시던트마다 새 세션이다 (앞 세션이 쥔 오래된 행을 읽지 않게)
    async with AsyncSessionLocal() as fresh:
        await Recovery_Service.services_recovery_start(fresh, later, **again.kwargs())

    assert again.updates == [] and again.waits == [] and again.checked == []
    assert (await fresh_incident(later)).status == 'needs_action'


# 보내기 전에 막힌 로컬 오류는 표식을 남기지 않는다
@pytest.mark.asyncio
async def test_rollback_param_validation_error_is_not_marked(db, notified):
    d_id=await make_deploy(db)
    i_id=await make_incident(db, d_id, kind='bad_release')
    fakes=Fakes(fail_update=ParamValidationError(report="bad"))

    await Recovery_Service.services_recovery_start(db, i_id, **fakes.kwargs())

    rows=await action_rows(i_id)
    assert not rows[0].detail.startswith(UNRECORDED_DETAIL)


# 다른 인시던트의 되돌리기 시도가 running 으로 남아 있으면 (표식을 못 쓴 경우) 자동 복구를 하지 않는다
@pytest.mark.asyncio
async def test_stuck_running_rollback_of_another_incident_blocks_recovery(db, notified):
    d_id=await make_deploy(db)
    old=await make_incident(db, d_id, kind='bad_release', status='needs_action')
    await add_action(db, old, 'rollback', 'running')
    later=await make_incident(db, d_id, kind='unhealthy')
    fakes=Fakes(healthy_images=(CUR_IMAGE, PREV_IMAGE))

    await Recovery_Service.services_recovery_start(db, later, **fakes.kwargs())

    assert fakes.updates == [] and fakes.waits == [] and fakes.checked == []
    assert (await fresh_incident(later)).status == 'needs_action'


# 같은 인시던트 자신의 running 시도는 막지 않고, 새 릴리스가 생기면 막힘이 풀린다
@pytest.mark.asyncio
async def test_stuck_running_rollback_block_lifts_with_a_newer_release(db, notified):
    from datetime import timedelta

    d_id=await make_deploy(db)
    old=await make_incident(db, d_id, kind='bad_release', status='needs_action')
    await add_action(db, old, 'rollback', 'running')

    async with AsyncSessionLocal() as session:
        session.add(Deploy_Release(d_id=d_id, commit_sha="e" * 40, image_uri=CUR_IMAGE + "2", state='current', created_at=_now() + timedelta(hours=1)))
        await session.commit()

    later=await make_incident(db, d_id, kind='unhealthy')
    fakes=Fakes(healthy_images=(CUR_IMAGE,))

    await Recovery_Service.services_recovery_start(db, later, **fakes.kwargs())

    assert len(fakes.updates) == 1
