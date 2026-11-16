import json

import pytest
from sqlalchemy import select

from shared.settings import settings
from shared.database import AsyncSessionLocal

from features.deploys.models import Deploy
from features.incidents.models import Incident, Recovery_Action
from features.incidents.scheme import Incident_Explain
from features.notifications.models import Notification, Push_Device, Notification_Setting
from features.notifications.dispatch import Push_Result
from features.notifications.services import Notification_Service

from recovery_helpers import db, make_deploy

# 알림 만들기·보내기 시험 - 메일·푸시는 가짜를 끼워 넣는다 (진짜 SMTP·Expo 호출 없음)

AWS_KEY="AKIAABCDEFGHIJKLMNOP"
GH_TOKEN="ghp_abcdefghijklmnopqrstuvwxyz0123456789"
EXPO_TOKEN="ExponentPushToken[secrettokenvalue1]"


class Fake_Mailer:

    def __init__(self, error=None):
        self.calls=[]
        self.error=error

    async def __call__(self, subject, body):
        self.calls.append((subject, body))
        if self.error is not None:
            raise self.error


class Fake_Pusher:

    def __init__(self, result=None, error=None):
        self.calls=[]
        self.result=result
        self.error=error

    async def __call__(self, devices, title, body, link):
        self.calls.append(([device.expo_token for device in devices], title, body, link))
        if self.error is not None:
            raise self.error
        return self.result or Push_Result(sent=len(devices), failed=0, invalid_tokens=[], error=None)


@pytest.fixture
def mail_on(monkeypatch):
    monkeypatch.setattr(settings, "mail_host", "smtp.test")
    monkeypatch.setattr(settings, "mail_to", "me@test")


async def add_device(db, token=EXPO_TOKEN, platform='android'):
    device=Push_Device(expo_token=token, platform=platform)
    db.add(device)
    await db.commit()
    return device.p_d_id


async def make_open_incident(db, d_id, kind='unhealthy', status='open', explain=None) -> Incident:
    explain=explain or Incident_Explain(summary="앱이 요청을 받지 못하고 있습니다.", cause="연결이 거부되었습니다.",
                                        fix_where="레포의 서버 시작 코드에서 듣는 포트를 확인합니다.", actions=["다시 배포"], source="rule")
    incident=Incident(d_id=d_id, kind=kind, status=status, summary=explain.summary, explain=explain.model_dump_json(), evidence="증거")
    db.add(incident)
    await db.commit()
    await db.refresh(incident)
    return incident


async def rows(db, **filters) -> list[Notification]:
    query=select(Notification).order_by(Notification.n_id)
    for key, value in filters.items():
        query=query.where(getattr(Notification, key) == value)
    return (await db.execute(query)).scalars().all()


async def by_channel(db) -> dict[str, Notification]:
    return {row.channel: row for row in await rows(db)}


@pytest.mark.asyncio
async def test_notification_incident_opened_writes_three_channels(db, mail_on):
    d_id=await make_deploy(db)
    deploy=await db.get(Deploy, d_id)
    deploy.service_name="my-api"
    await db.commit()
    await add_device(db)
    incident=await make_open_incident(db, d_id)
    mailer, pusher=Fake_Mailer(), Fake_Pusher()

    await Notification_Service.services_notification_send_incident(db, incident, 'incident_opened', mailer=mailer, pusher=pusher)

    channels=await by_channel(db)
    assert set(channels) == {'inapp', 'email', 'push'}
    assert all(row.kind == 'incident_opened' and row.i_id == incident.i_id and row.d_id == d_id for row in channels.values())
    assert channels['inapp'].status == 'sent' and channels['email'].status == 'sent' and channels['push'].status == 'sent'
    assert channels['inapp'].read_at is None and channels['email'].sent_at is not None

    body=channels['inapp'].body
    # ① 무슨 일 ② 왜 ③ 어디를 고치나 ⑤ 링크 순서
    assert body.index("앱이 요청을 받지 못하고 있습니다.") < body.index("연결이 거부되었습니다.") < body.index("서버 시작 코드") < body.index("deploywizard://incidents/")
    assert f"deploywizard://incidents/{incident.i_id}" in body

    subject, mail_body=mailer.calls[0]
    assert subject == f"[배포 마법사] my-api {channels['inapp'].title}"
    assert mail_body == body

    tokens, push_title, push_body, link=pusher.calls[0]
    assert tokens == [EXPO_TOKEN] and push_title == channels['inapp'].title
    assert len(push_body) <= 120 and "my-api" in push_body
    assert link == f"deploywizard://incidents/{incident.i_id}"


@pytest.mark.asyncio
async def test_notification_body_reports_automatic_actions_and_results(db, mail_on):
    d_id=await make_deploy(db)
    incident=await make_open_incident(db, d_id, status='resolved')
    db.add(Recovery_Action(i_id=incident.i_id, action='restart', result='failed', detail="업데이트 실패"))
    db.add(Recovery_Action(i_id=incident.i_id, action='rollback', result='ok'))
    await db.commit()

    await Notification_Service.services_notification_send_incident(db, incident, 'incident_recovered', mailer=Fake_Mailer(), pusher=Fake_Pusher())

    inapp=(await by_channel(db))['inapp']
    assert "자동으로 한 일" in inapp.body
    assert "다시 시작" in inapp.body and "실패" in inapp.body
    assert "이전 정상 버전으로 되돌림" in inapp.body and "성공" in inapp.body
    assert "되돌려" in inapp.title


@pytest.mark.asyncio
async def test_notification_body_without_automatic_actions_says_so(db):
    d_id=await make_deploy(db)
    incident=await make_open_incident(db, d_id, status='needs_action')

    await Notification_Service.services_notification_send_incident(db, incident, 'incident_needs_action', mailer=Fake_Mailer(), pusher=Fake_Pusher())

    assert "자동으로 한 일: 없음" in (await by_channel(db))['inapp'].body


@pytest.mark.asyncio
async def test_notification_masks_secrets_in_all_three_channels(db, mail_on):
    d_id=await make_deploy(db)
    await add_device(db)
    explain=Incident_Explain(summary=f"키 {AWS_KEY} 가 보입니다", cause=f"토큰 {GH_TOKEN} 이 로그에 있습니다",
                             fix_where=f"설정 파일의 PASSWORD=hunter2 와 {AWS_KEY} 를 지웁니다", actions=[], source="rule")
    incident=await make_open_incident(db, d_id, explain=explain)
    db.add(Recovery_Action(i_id=incident.i_id, action='restart', result='failed', detail=f"실패 {GH_TOKEN} {EXPO_TOKEN}"))
    await db.commit()
    mailer, pusher=Fake_Mailer(), Fake_Pusher()

    await Notification_Service.services_notification_send_incident(db, incident, 'incident_opened', mailer=mailer, pusher=pusher)

    stored="\n".join(row.title + row.body + (row.error or "") for row in await rows(db))
    sent="\n".join(subject + body for subject, body in mailer.calls) + "\n".join(f"{title}{body}{link}" for _, title, body, link in pusher.calls)
    for text in (stored, sent):
        assert AWS_KEY not in text and GH_TOKEN not in text and "hunter2" not in text
        assert "secrettokenvalue1" not in text


@pytest.mark.asyncio
async def test_notification_settings_gates(db, mail_on):
    d_id=await make_deploy(db)
    await add_device(db)
    incident=await make_open_incident(db, d_id)

    setting=await Notification_Service.services_notification_setting_get(db)
    setting.notify_push=False
    await db.commit()
    mailer, pusher=Fake_Mailer(), Fake_Pusher()
    await Notification_Service.services_notification_send_incident(db, incident, 'incident_opened', mailer=mailer, pusher=pusher)
    assert set(await by_channel(db)) == {'inapp', 'email'} and pusher.calls == [] and len(mailer.calls) == 1

    setting.notify_push=True
    setting.notify_email=False
    await db.commit()
    mailer, pusher=Fake_Mailer(), Fake_Pusher()
    await Notification_Service.services_notification_send_incident(db, incident, 'incident_needs_action', mailer=mailer, pusher=pusher)
    needs=[row.channel for row in await rows(db, kind='incident_needs_action')]
    assert needs == ['inapp', 'push'] and mailer.calls == [] and len(pusher.calls) == 1


@pytest.mark.asyncio
async def test_notification_kind_off_sends_nothing(db, mail_on):
    d_id=await make_deploy(db)
    await add_device(db)
    incident=await make_open_incident(db, d_id)
    setting=await Notification_Service.services_notification_setting_get(db)
    setting.kinds=json.dumps(['deploy_failed'])
    await db.commit()
    mailer, pusher=Fake_Mailer(), Fake_Pusher()

    await Notification_Service.services_notification_send_incident(db, incident, 'incident_opened', mailer=mailer, pusher=pusher)

    assert await rows(db) == [] and mailer.calls == [] and pusher.calls == []


@pytest.mark.asyncio
async def test_notification_duplicate_incident_kind_is_suppressed(db, mail_on):
    d_id=await make_deploy(db)
    await add_device(db)
    incident=await make_open_incident(db, d_id)
    mailer, pusher=Fake_Mailer(), Fake_Pusher()

    for _ in range(2):
        await Notification_Service.services_notification_send_incident(db, incident, 'incident_opened', mailer=mailer, pusher=pusher)

    assert len(await rows(db)) == 3 and len(mailer.calls) == 1 and len(pusher.calls) == 1

    await Notification_Service.services_notification_send_incident(db, incident, 'incident_needs_action', mailer=mailer, pusher=pusher)
    assert len(await rows(db)) == 6


@pytest.mark.asyncio
async def test_notification_mail_unconfigured_skips_silently(db):
    d_id=await make_deploy(db)
    incident=await make_open_incident(db, d_id)

    await Notification_Service.services_notification_send_incident(db, incident, 'incident_opened')

    assert [row.channel for row in await rows(db)] == ['inapp']


@pytest.mark.asyncio
async def test_notification_mail_failure_is_recorded_masked_and_does_not_raise(db, mail_on):
    d_id=await make_deploy(db)
    incident=await make_open_incident(db, d_id)
    mailer=Fake_Mailer(error=RuntimeError(f"SMTP 접속 실패 {AWS_KEY}"))

    await Notification_Service.services_notification_send_incident(db, incident, 'incident_opened', mailer=mailer, pusher=Fake_Pusher())

    channels=await by_channel(db)
    assert channels['inapp'].status == 'sent'
    assert channels['email'].status == 'failed' and "SMTP 접속 실패" in channels['email'].error and AWS_KEY not in channels['email'].error


@pytest.mark.asyncio
async def test_notification_push_exception_and_error_result_become_failed_rows(db):
    d_id=await make_deploy(db)
    await add_device(db)
    incident=await make_open_incident(db, d_id)

    await Notification_Service.services_notification_send_incident(db, incident, 'incident_opened', pusher=Fake_Pusher(error=RuntimeError("Expo 연결 끊김")))
    push=(await rows(db, kind='incident_opened', channel='push'))[0]
    assert push.status == 'failed' and "Expo 연결 끊김" in push.error

    await Notification_Service.services_notification_send_incident(
        db, incident, 'incident_needs_action',
        pusher=Fake_Pusher(result=Push_Result(sent=0, failed=1, invalid_tokens=[], error="Expo 응답 오류 HTTP 500")))
    push=(await rows(db, kind='incident_needs_action', channel='push'))[0]
    assert push.status == 'failed' and "HTTP 500" in push.error
    assert (await by_channel(db))['inapp'].status == 'sent'


@pytest.mark.asyncio
async def test_notification_unregistered_device_is_removed_only(db):
    d_id=await make_deploy(db)
    keep=await add_device(db, "ExponentPushToken[keepkeepkeep]")
    gone=await add_device(db, "ExponentPushToken[gonegonegone]", 'android')
    incident=await make_open_incident(db, d_id)
    pusher=Fake_Pusher(result=Push_Result(sent=1, failed=1, invalid_tokens=["ExponentPushToken[gonegonegone]"], error=None))

    await Notification_Service.services_notification_send_incident(db, incident, 'incident_opened', pusher=pusher)

    left=(await db.execute(select(Push_Device.p_d_id))).scalars().all()
    assert left == [keep] and gone not in left
    assert (await rows(db, channel='push'))[0].status == 'sent'


@pytest.mark.asyncio
async def test_notification_push_without_devices_writes_no_row(db):
    d_id=await make_deploy(db)
    incident=await make_open_incident(db, d_id)
    pusher=Fake_Pusher()

    await Notification_Service.services_notification_send_incident(db, incident, 'incident_opened', pusher=pusher)

    assert [row.channel for row in await rows(db)] == ['inapp'] and pusher.calls == []


@pytest.mark.asyncio
async def test_notification_settings_row_is_created_on_first_read(db):
    assert (await db.execute(select(Notification_Setting))).scalars().all() == []

    setting=await Notification_Service.services_notification_setting_get(db)

    assert setting.id == 1 and setting.notify_email is True and setting.notify_push is True
    assert len((await db.execute(select(Notification_Setting))).scalars().all()) == 1


@pytest.mark.asyncio
async def test_notification_deploy_succeeded_failed_and_new_commit(db, mail_on):
    d_id=await make_deploy(db)
    deploy=await db.get(Deploy, d_id)
    deploy.service_name="my-api"
    deploy.endpoint="https://abc.example.com"
    deploy.error_step="building"
    deploy.error_msg=f"빌드 실패 {AWS_KEY}"
    deploy.explain=json.dumps({"summary": "빌드가 실패했습니다.", "cause": "의존성 설치 오류", "actions": ["requirements.txt 를 확인합니다."], "source": "rule", "cached": False})
    await db.commit()
    mailer, pusher=Fake_Mailer(), Fake_Pusher()

    await Notification_Service.services_notification_send_deploy(db, deploy, 'deploy_succeeded', mailer=mailer, pusher=pusher)
    await Notification_Service.services_notification_send_deploy(db, deploy, 'deploy_failed', mailer=mailer, pusher=pusher)
    await Notification_Service.services_notification_send_deploy(db, deploy, 'new_commit', mailer=mailer, pusher=pusher, event="abcdef1234567890")

    succeeded=(await rows(db, kind='deploy_succeeded', channel='inapp'))[0]
    assert succeeded.d_id == d_id and succeeded.i_id is None
    assert "https://abc.example.com" in succeeded.body and f"deploywizard://deploys/{d_id}" in succeeded.body

    failed=(await rows(db, kind='deploy_failed', channel='inapp'))[0]
    assert "빌드가 실패했습니다." in failed.body and "의존성 설치 오류" in failed.body and AWS_KEY not in failed.body

    commit=(await rows(db, kind='new_commit', channel='inapp'))[0]
    assert "abcdef1" in commit.title and "abcdef1234567890" not in commit.body
    assert len(mailer.calls) == 3 and mailer.calls[0][0].startswith("[배포 마법사] my-api ")
    assert all(len(call[2]) <= 120 for call in pusher.calls) or not pusher.calls


@pytest.mark.asyncio
async def test_notification_new_commit_is_suppressed_per_commit(db):
    d_id=await make_deploy(db)
    deploy=await db.get(Deploy, d_id)

    for sha in ("a" * 40, "a" * 40, "b" * 40):
        await Notification_Service.services_notification_send_deploy(db, deploy, 'new_commit', event=sha)

    assert len(await rows(db, kind='new_commit', channel='inapp')) == 2


@pytest.mark.asyncio
async def test_notification_deploy_fire_runs_in_background_and_never_raises(db, monkeypatch):
    d_id=await make_deploy(db)

    task=Notification_Service.services_notification_deploy_fire(d_id, 'deploy_succeeded')
    assert task is not None
    await Notification_Service.services_notification_tasks_wait()
    assert len(await rows(db, kind='deploy_succeeded')) == 1

    async def boom(db_, deploy_, kind_, **kwargs):
        raise RuntimeError(f"내부 오류 {AWS_KEY}")

    monkeypatch.setattr(Notification_Service, "services_notification_send_deploy", staticmethod(boom))
    Notification_Service.services_notification_deploy_fire(d_id, 'deploy_failed')
    await Notification_Service.services_notification_tasks_wait()
    assert await rows(db, kind='deploy_failed') == []


@pytest.mark.asyncio
async def test_notification_deploy_fire_for_missing_deploy_is_quiet(db):
    Notification_Service.services_notification_deploy_fire(9999, 'deploy_failed')
    await Notification_Service.services_notification_tasks_wait()

    assert await rows(db) == []


@pytest.mark.asyncio
async def test_notification_default_pusher_expo_http_error_becomes_failed_row(db, monkeypatch):
    import httpx
    from features.notifications import dispatch

    monkeypatch.setattr(dispatch, "PUSH_TRANSPORT", httpx.MockTransport(lambda request: httpx.Response(503, json={"errors": [{"code": "X", "message": "다운"}]})))
    d_id=await make_deploy(db)
    await add_device(db)
    incident=await make_open_incident(db, d_id)

    await Notification_Service.services_notification_send_incident(db, incident, 'incident_opened')

    channels=await by_channel(db)
    assert channels['inapp'].status == 'sent'
    assert channels['push'].status == 'failed' and "HTTP 503" in channels['push'].error
    assert len((await db.execute(select(Push_Device))).scalars().all()) == 1


@pytest.mark.asyncio
async def test_notification_mail_subject_has_no_line_breaks(db, mail_on):
    d_id=await make_deploy(db)
    deploy=await db.get(Deploy, d_id)
    deploy.service_name="my-api\r\nBcc: evil@test"
    await db.commit()
    incident=await make_open_incident(db, d_id)
    mailer=Fake_Mailer()

    await Notification_Service.services_notification_send_incident(db, incident, 'incident_opened', mailer=mailer, pusher=Fake_Pusher())

    subject=mailer.calls[0][0]
    assert "\r" not in subject and "\n" not in subject and subject.startswith("[배포 마법사] my-api")
