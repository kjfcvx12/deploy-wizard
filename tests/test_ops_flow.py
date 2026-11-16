import pytest
from datetime import datetime, timedelta

from sqlalchemy import select, update

from shared.settings import settings
from shared.database import AsyncSessionLocal

from features.deploys.models import Deploy, Deploy_Release
from features.deploys.services import Deploy_Service
from features.health.models import Health_Check
from features.health.services import Health_Service
from features.incidents.models import Incident
from features.incidents.recovery import Recovery_Service
from features.incidents.services import Incident_Service
from features.express.scheme import Express_Status
from features.express.services import Express_Service
from features.notifications.models import Notification, Push_Device
from features.notifications.dispatch import Push_Result
from features.notifications import services as notification_services
from features.notifications.services import Notification_Service
from features.repos.services import Repo_Service
from features.watches.services import Watch_Service

from recovery_helpers import (db, aws_session, Fakes, make_deploy, fresh_incident, fresh_deploy, actions_of, release_states,
                              CUR_SHA, PREV_SHA, CUR_IMAGE, PREV_IMAGE)

pytestmark=pytest.mark.usefixtures("aws_session")

# 운영 복구 흐름 전체 시험 (D1) - 헬스체크 -> 인시던트 -> 알림 -> 자동 복구 -> 해제까지 이어서 확인한다
# 점검기·갱신기·대기기·잠자기·describe·메일·푸시는 모두 가짜 - 실제 AWS·SMTP·Expo·네트워크를 쓰지 않는다

NOW=datetime(2026, 11, 10, 12, 0, 0)
OLD=datetime(2026, 11, 1, 0, 0, 0)


# 흐름에 끼우는 가짜 모음 - 알림 메일·푸시와 describe, 복구 실행기 (updater/waiter/sleeper/checker)
class Flow:

    def __init__(self, fakes:Fakes):
        self.fakes=fakes
        self.mails=[]
        self.pushes=[]
        self.describes=[]


@pytest.fixture
def flow(monkeypatch):
    fakes=Fakes(healthy_images=(PREV_IMAGE,))
    state=Flow(fakes)

    # 복구 실행기에 가짜 updater/waiter/sleeper/checker 를 끼운다 (인시던트 처리 태스크는 인자 없이 부른다)
    original=Recovery_Service.services_recovery_start

    async def start_with_fakes(db, i_id, updater=None, waiter=None, sleeper=None, checker=None):
        await original(db, i_id, **fakes.kwargs())

    monkeypatch.setattr(Recovery_Service, "services_recovery_start", staticmethod(start_with_fakes))

    def describe(session, arn):
        state.describes.append((session, arn))
        return Express_Status(service_arn=arn, status_code="ACTIVE", status_reason="-", deployment_status="IN_PROGRESS")

    monkeypatch.setattr(Express_Service, "services_express_describe", staticmethod(describe))

    # 메일·푸시는 알림 서비스가 부르는 발송기를 가짜로 바꾼다
    async def fake_mail(subject, body):
        state.mails.append((subject, body))

    async def fake_push(devices, title, body, link):
        state.pushes.append(([device.expo_token for device in devices], title, body))
        return Push_Result(sent=len(devices), failed=0, invalid_tokens=[], error=None)

    monkeypatch.setattr(notification_services, "dispatch_mail_send", fake_mail)
    monkeypatch.setattr(notification_services, "dispatch_push_send", fake_push)
    monkeypatch.setattr(settings, "mail_host", "smtp.test")
    monkeypatch.setattr(settings, "mail_to", "me@test")

    return state


async def setup_deploy(db, **kwargs) -> int:
    d_id=await make_deploy(db, **kwargs)
    await db.execute(update(Deploy).where(Deploy.d_id == d_id).values(aws_account_id=1))

    # 새 버전 직후(bad_release)가 아니라 평범한 장애로 보이게 현재 릴리스를 오래된 것으로
    await db.execute(update(Deploy_Release).where(Deploy_Release.d_id == d_id).values(created_at=OLD))
    db.add(Push_Device(expo_token="ExponentPushToken[flowtesttoken000001]", platform='android'))
    await db.commit()
    return d_id


# 실패만 돌려주는 점검기 (모니터용)
def failing_checker(calls=None):
    async def checker(url):
        if calls is not None:
            calls.append(url)
        return False, 503, 7, "HTTP 503"
    return checker


async def run_failures(db, count:int, checker=None):
    for minute in range(count):
        await Health_Service.services_health_check_once(db, now=NOW + timedelta(minutes=minute), checker=checker or failing_checker())


async def all_incidents() -> list[Incident]:
    async with AsyncSessionLocal() as session:
        return (await session.execute(select(Incident).order_by(Incident.i_id))).scalars().all()


async def notification_rows() -> list[tuple[str, str, str]]:
    async with AsyncSessionLocal() as session:
        rows=(await session.execute(select(Notification).order_by(Notification.n_id))).scalars().all()
        return [(row.kind, row.channel, row.status) for row in rows]


# 시나리오 A - 실패 3번 -> 인시던트 -> 알림 -> 재시작이 안 통함 -> 되돌리기 성공 -> 해제, 나쁜 커밋은 다시 배포하지 않는다
@pytest.mark.asyncio
async def test_flow_restart_fails_then_rollback_resolves_and_watch_skips_bad_commit(db, flow, monkeypatch):
    d_id=await setup_deploy(db)

    # 2번 실패까지는 인시던트가 없다
    await run_failures(db, 2)
    await Incident_Service.services_incident_tasks_wait()
    assert await all_incidents() == []

    # 3번째 실패에서 열린다 (처리는 백그라운드 태스크 - 끝나기를 기다린다)
    await run_failures(db, 1)
    await Incident_Service.services_incident_tasks_wait()

    incidents=await all_incidents()
    assert len(incidents) == 1
    i_id=incidents[0].i_id
    assert (incidents[0].d_id, incidents[0].kind) == (d_id, 'unhealthy')

    # 원인 설명이 저장되고, 서비스 상태를 describe 로 확인했다
    assert incidents[0].explain and incidents[0].summary
    assert flow.describes == [("FAKE_SESSION", "arn:aws:ecs:x:1:service/s")]

    # 재시작(실패) -> 되돌리기(성공) 두 번의 자동 조치 - 같은 이미지, 이전 이미지 순서로 갱신했다
    assert await actions_of(i_id) == [('restart', 'failed'), ('rollback', 'ok')]
    assert [update_call[2] for update_call in flow.fakes.updates] == [CUR_IMAGE, PREV_IMAGE]

    resolved=await fresh_incident(i_id)
    assert resolved.status == 'resolved'
    assert resolved.resolved_at is not None

    # 알림 - 열림은 앱 안 + 메일 + 푸시, 복구됨도 세 채널
    rows=await notification_rows()
    assert [row for row in rows if row[0] == 'incident_opened'] == [('incident_opened', 'inapp', 'sent'), ('incident_opened', 'email', 'sent'), ('incident_opened', 'push', 'sent')]
    assert [row for row in rows if row[0] == 'incident_recovered'] == [('incident_recovered', 'inapp', 'sent'), ('incident_recovered', 'email', 'sent'), ('incident_recovered', 'push', 'sent')]
    assert not [row for row in rows if row[0] == 'incident_needs_action']
    assert len(flow.mails) == 2 and len(flow.pushes) == 2

    # 배포 기록이 이전 정상 버전으로 바뀌고 나쁜 커밋을 기억한다
    deploy=await fresh_deploy(d_id)
    assert (deploy.image_uri, deploy.commit_sha, deploy.bad_commit_sha, deploy.status) == (PREV_IMAGE, PREV_SHA, CUR_SHA, 'running')
    assert await release_states(d_id) == [('a', 'current'), ('c', 'failed')]

    # 감시 폴링이 같은 나쁜 커밋을 보고 다시 배포하지 않는다 (자동 재배포가 켜져 있어도)
    assert deploy.auto_redeploy is True
    redeploys=[]

    async def fake_redeploy(db_, redeploy_d_id):
        redeploys.append(redeploy_d_id)

    monkeypatch.setattr(Repo_Service, "services_repo_commit_sha", staticmethod(lambda repo_url, branch, token: CUR_SHA))
    monkeypatch.setattr(Deploy_Service, "services_deploy_redeploy", staticmethod(fake_redeploy))

    await Watch_Service.services_watch_poll_deploy(deploy)
    await Notification_Service.services_notification_tasks_wait()

    assert redeploys == []
    assert (await fresh_deploy(d_id)).watch_commit_sha == CUR_SHA
    assert (await fresh_deploy(d_id)).bad_commit_sha == CUR_SHA

    # 더 새로운 커밋이 오면 막힘이 풀리고 다시 배포한다
    newer="d" * 40
    monkeypatch.setattr(Repo_Service, "services_repo_commit_sha", staticmethod(lambda repo_url, branch, token: newer))
    await Watch_Service.services_watch_poll_deploy(await fresh_deploy(d_id))

    assert redeploys == [d_id]
    assert (await fresh_deploy(d_id)).bad_commit_sha is None

    # 정상으로 돌아온 뒤에는 새 인시던트가 생기지 않는다
    assert len(await all_incidents()) == 1


# 시나리오 B - 자동 복구가 꺼져 있으면 AWS 쓰기(update) 호출 없이 needs_action 으로 알린다 (읽기 전용 describe 는 원인 수집 때문에 한 번 불린다)
@pytest.mark.asyncio
async def test_flow_auto_recover_off_goes_to_needs_action_without_aws_update_calls(db, flow):
    d_id=await setup_deploy(db, auto_recover=False)

    await run_failures(db, 3)
    await Incident_Service.services_incident_tasks_wait()

    incidents=await all_incidents()
    assert len(incidents) == 1
    assert incidents[0].status == 'needs_action'

    assert flow.fakes.updates == []
    assert flow.fakes.waits == []
    assert flow.fakes.sleeps == []
    assert flow.fakes.checked == []
    assert await actions_of(incidents[0].i_id) == []

    rows=await notification_rows()
    assert [row for row in rows if row[0] == 'incident_needs_action'] == [('incident_needs_action', 'inapp', 'sent'), ('incident_needs_action', 'email', 'sent'), ('incident_needs_action', 'push', 'sent')]
    assert not [row for row in rows if row[0] == 'incident_recovered']

    # 배포 기록은 그대로
    deploy=await fresh_deploy(d_id)
    assert (deploy.image_uri, deploy.commit_sha, deploy.bad_commit_sha) == (CUR_IMAGE, CUR_SHA, None)

    # 계속 실패해도 인시던트를 새로 만들지 않는다
    await run_failures(db, 2)
    await Incident_Service.services_incident_tasks_wait()
    assert len(await all_incidents()) == 1


# 시나리오 C - 이전 릴리스가 없으면 재시작만 해 보고(실패) needs_action, 되돌리기는 시도하지 않는다
@pytest.mark.asyncio
async def test_flow_without_previous_release_restarts_then_needs_action(db, flow):
    d_id=await setup_deploy(db, with_previous=False)

    await run_failures(db, 3)
    await Incident_Service.services_incident_tasks_wait()

    incidents=await all_incidents()
    assert len(incidents) == 1
    assert incidents[0].kind == 'unhealthy'
    assert incidents[0].status == 'needs_action'

    assert await actions_of(incidents[0].i_id) == [('restart', 'failed')]
    assert [update_call[2] for update_call in flow.fakes.updates] == [CUR_IMAGE]

    rows=await notification_rows()
    assert [row[:2] for row in rows if row[0] == 'incident_needs_action'] == [('incident_needs_action', 'inapp'), ('incident_needs_action', 'email'), ('incident_needs_action', 'push')]
    assert not [row for row in rows if row[0] == 'incident_recovered']

    deploy=await fresh_deploy(d_id)
    assert (deploy.image_uri, deploy.commit_sha, deploy.bad_commit_sha) == (CUR_IMAGE, CUR_SHA, None)


# 시나리오 D - 점검하는 사이 멈춘 배포는 기록도 인시던트도 남기지 않는다
@pytest.mark.asyncio
async def test_flow_deploy_stopped_mid_check_gets_no_incident(db, flow):
    d_id=await setup_deploy(db)

    await run_failures(db, 2)

    # 세 번째 점검이 진행되는 동안 배포가 멈춘다
    async def stopping_checker(url):
        async with AsyncSessionLocal() as other:
            await other.execute(update(Deploy).where(Deploy.d_id == d_id).values(status='stopped'))
            await other.commit()
        return False, 503, 7, "HTTP 503"

    await Health_Service.services_health_check_once(db, now=NOW + timedelta(minutes=2), checker=stopping_checker)
    await Incident_Service.services_incident_tasks_wait()

    assert await all_incidents() == []
    assert flow.fakes.updates == []
    assert await notification_rows() == []

    async with AsyncSessionLocal() as session:
        checks=(await session.execute(select(Health_Check).where(Health_Check.d_id == d_id))).scalars().all()
        assert len(checks) == 2
