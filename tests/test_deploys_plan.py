import asyncio
import contextlib
import pytest
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from shared.settings import settings

from features.deploys.models import Deploy
from features.deploys.crud import Deploy_Crud
from features.deploys.services import Deploy_Service
from features.health.services import Health_Service
from features.notifications.models import Notification, Push_Device
from features.notifications.dispatch import Push_Result
from features.notifications.compose import compose_deploy, compose_hours_text
from features.notifications.services import Notification_Service

from recovery_helpers import db, make_deploy

# 예정 사용 시간 초과 알림 시험 - 알림만 보내고 멈추거나 지우지 않는다. 메일·푸시는 가짜 (진짜 SMTP·Expo 호출 없음)

NOW=datetime(2026, 11, 16, 12, 0, 0)
EXPO_TOKEN="ExponentPushToken[plantokenvalue00001]"


class Fake_Mailer:

    def __init__(self):
        self.calls=[]

    async def __call__(self, subject, body):
        self.calls.append((subject, body))


class Fake_Pusher:

    def __init__(self):
        self.calls=[]

    async def __call__(self, devices, title, body, link):
        self.calls.append((title, body, link))
        return Push_Result(sent=len(devices), failed=0, invalid_tokens=[], error=None)


# 예정 시간과 시작 시각을 정해 배포 만들기
async def make_planned(db, planned_hours=2, running_since=NOW - timedelta(hours=2), status='running', plan_notified_at=None) -> int:
    d_id=await make_deploy(db, status=status)
    await Deploy_Crud.crud_deploy_update(db, d_id, {"planned_hours": planned_hours, "running_since": running_since, "plan_notified_at": plan_notified_at})
    await db.commit()
    return d_id


async def notification_rows(db, **filters) -> list[Notification]:
    query=select(Notification).order_by(Notification.n_id)
    for key, value in filters.items():
        query=query.where(getattr(Notification, key) == value)
    return (await db.execute(query)).scalars().all()


@pytest.mark.asyncio
async def test_plan_check_notifies_once_at_boundary(db):
    on_boundary=await make_planned(db, planned_hours=2, running_since=NOW - timedelta(hours=2))
    just_short=await make_planned(db, planned_hours=2, running_since=NOW - timedelta(hours=1, minutes=59))

    assert await Deploy_Service.services_deploy_plan_check(db, NOW) == [on_boundary]

    db.expire_all()
    assert (await db.get(Deploy, on_boundary)).plan_notified_at == NOW
    assert (await db.get(Deploy, just_short)).plan_notified_at is None

    assert await Deploy_Service.services_deploy_plan_check(db, NOW) == []
    assert await Deploy_Service.services_deploy_plan_check(db, NOW + timedelta(hours=5)) == [just_short]


@pytest.mark.asyncio
async def test_plan_check_supports_fractional_hours(db):
    d_id=await make_planned(db, planned_hours=1.5, running_since=NOW - timedelta(minutes=90))

    assert await Deploy_Service.services_deploy_plan_check(db, NOW - timedelta(seconds=1)) == []
    assert await Deploy_Service.services_deploy_plan_check(db, NOW) == [d_id]


@pytest.mark.asyncio
async def test_plan_check_ignores_not_running_no_plan_no_start(db):
    old=NOW - timedelta(hours=10)
    await make_planned(db, status='stopped', running_since=old)
    await make_planned(db, status='failed', running_since=old)
    await make_planned(db, planned_hours=None, running_since=old)
    await make_planned(db, running_since=None)

    assert await Deploy_Service.services_deploy_plan_check(db, NOW) == []


@pytest.mark.asyncio
async def test_plan_check_does_not_touch_the_deploy(db):
    d_id=await make_planned(db)

    await Deploy_Service.services_deploy_plan_check(db, NOW)

    db.expire_all()
    deploy=await db.get(Deploy, d_id)
    assert deploy.status == 'running' and deploy.service_arn and deploy.running_since == NOW - timedelta(hours=2)


@pytest.mark.asyncio
async def test_plan_resets_when_running_again(db):
    d_id=await make_planned(db, planned_hours=2, running_since=NOW - timedelta(hours=2))
    assert await Deploy_Service.services_deploy_plan_check(db, NOW) == [d_id]

    # 멈추면 running_since 가 비고 (services_deploy_stop), 다시 켜서 running 에 닿으면 새 시각이 채워지고 알림 기록이 비워진다 (pipeline)
    await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "stopped", "running_since": None})
    await db.commit()
    assert await Deploy_Service.services_deploy_plan_check(db, NOW + timedelta(hours=9)) == []

    restarted=NOW + timedelta(hours=10)
    await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "running", "running_since": restarted, "plan_notified_at": None})
    await db.commit()

    assert await Deploy_Service.services_deploy_plan_check(db, restarted + timedelta(hours=1, minutes=59)) == []
    assert await Deploy_Service.services_deploy_plan_check(db, restarted + timedelta(hours=2)) == [d_id]
    assert await Deploy_Service.services_deploy_plan_check(db, restarted + timedelta(hours=3)) == []


@pytest.mark.asyncio
async def test_plan_not_renotified_when_redeploy_keeps_running_since(db):
    d_id=await make_planned(db, planned_hours=2, running_since=NOW - timedelta(hours=2))
    assert await Deploy_Service.services_deploy_plan_check(db, NOW) == [d_id]

    # 살아 있는 서비스의 재배포는 running_since·plan_notified_at 을 그대로 둔다
    await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "deploying"})
    await db.commit()
    await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "running"})
    await db.commit()

    assert await Deploy_Service.services_deploy_plan_check(db, NOW + timedelta(hours=1)) == []


@pytest.mark.asyncio
async def test_plan_check_error_rolls_back_and_raises_500(db, monkeypatch):
    from fastapi import HTTPException

    async def boom(db_):
        raise RuntimeError("db 오류 AKIAABCDEFGHIJKLMNOP")

    monkeypatch.setattr(Deploy_Crud, "crud_deploy_get_plan_candidates", staticmethod(boom))

    with pytest.raises(HTTPException) as caught:
        await Deploy_Service.services_deploy_plan_check(db, NOW)

    assert caught.value.status_code == 500 and "AKIAABCDEFGHIJKLMNOP" not in caught.value.detail


def test_compose_hours_text():
    assert compose_hours_text(4) == "4시간"
    assert compose_hours_text(4.0) == "4시간"
    assert compose_hours_text(1.5) == "1.5시간"
    assert compose_hours_text(0.25) == "0.25시간"
    assert compose_hours_text(2.333333) == "2.33시간"


def test_compose_plan_exceeded_text():
    deploy=Deploy(d_id=7, repo_url="https://github.com/o/r", planned_hours=4)

    composed=compose_deploy('plan_exceeded', "my-api", deploy)
    assert "my-api" in composed.title and "예정한 사용 시간" in composed.title
    assert "my-api" in composed.body and "4시간" in composed.body and "멈추거나 삭제" in composed.body
    assert "요금이 나옵니다" in composed.body
    assert "deploys/7" in composed.body and composed.link.endswith("deploys/7")
    assert "my-api" in composed.push_line and "4시간" in composed.push_line

    fractional=compose_deploy('plan_exceeded', "my-api", Deploy(d_id=7, planned_hours=1.5))
    assert "1.5시간" in fractional.body


@pytest.mark.asyncio
async def test_plan_exceeded_creates_notification_row(db, monkeypatch):
    monkeypatch.setattr(settings, "mail_host", "smtp.test")
    monkeypatch.setattr(settings, "mail_to", "me@test")
    db.add(Push_Device(expo_token=EXPO_TOKEN, platform='ios'))
    d_id=await make_planned(db, planned_hours=4)
    deploy=await db.get(Deploy, d_id)
    deploy.service_name="my-api"
    await db.commit()
    mailer, pusher=Fake_Mailer(), Fake_Pusher()

    Notification_Service.services_notification_deploy_fire(d_id, 'plan_exceeded', mailer=mailer, pusher=pusher)
    await Notification_Service.services_notification_tasks_wait()

    inapp=await notification_rows(db, kind='plan_exceeded', channel='inapp')
    assert len(inapp) == 1 and inapp[0].d_id == d_id and inapp[0].status == 'sent'
    assert "4시간" in inapp[0].body and "멈추거나 삭제" in inapp[0].body
    assert len(await notification_rows(db, kind='plan_exceeded')) == 3
    assert len(mailer.calls) == 1 and mailer.calls[0][0].startswith("[배포 마법사] my-api ")
    assert len(pusher.calls) == 1 and len(pusher.calls[0][1]) <= 120


@pytest.mark.asyncio
async def test_plan_exceeded_is_on_by_default_and_listed(db):
    setting=await Notification_Service.services_notification_setting_get(db)

    assert 'plan_exceeded' in Notification_Service.services_notification_kinds(setting)


# 감시 루프를 잠깐 돌린다 - 헬스 점검은 가짜 (once 가 불린 횟수를 센다)
async def run_loop_briefly(monkeypatch, until, once):
    async def fake_once(db_, now=None, checker=None):
        return await once()

    monkeypatch.setattr(Health_Service, "services_health_check_once", staticmethod(fake_once))
    monkeypatch.setattr(settings, "health_interval_seconds", 0)

    task=asyncio.create_task(Health_Service.services_health_monitor_loop())
    for _ in range(300):
        await asyncio.sleep(0.01)
        if until():
            break
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_monitor_cycle_fires_plan_notification(db, monkeypatch):
    # 시작한 지 3시간이 지난 2시간 예정 배포 하나 - 몇 주기를 돌아도 알림은 한 번
    d_id=await make_planned(db, planned_hours=2, running_since=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=3))
    fired=[]
    passes=[]

    def fake_fire(d_id_, kind, event=None, mailer=None, pusher=None):
        fired.append((d_id_, kind))

    async def once():
        passes.append(1)
        return []

    monkeypatch.setattr(Notification_Service, "services_notification_deploy_fire", staticmethod(fake_fire))
    await run_loop_briefly(monkeypatch, lambda: len(passes) >= 4, once)

    assert len(passes) >= 4
    assert fired == [(d_id, 'plan_exceeded')]


@pytest.mark.asyncio
async def test_monitor_cycle_survives_plan_step_failure(db, monkeypatch):
    health_passes=[]
    plan_calls=[]

    async def boom(db_, now=None):
        plan_calls.append(1)
        raise RuntimeError("점검 실패 AKIAABCDEFGHIJKLMNOP")

    async def once():
        health_passes.append(1)
        return []

    monkeypatch.setattr(Deploy_Service, "services_deploy_plan_check", staticmethod(boom))
    await run_loop_briefly(monkeypatch, lambda: len(health_passes) >= 3 and len(plan_calls) >= 3, once)

    assert len(health_passes) >= 3 and len(plan_calls) >= 3


@pytest.mark.asyncio
async def test_monitor_cycle_plan_notification_survives_health_failure(db, monkeypatch):
    d_id=await make_planned(db, planned_hours=1, running_since=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=2))
    fired=[]

    def fake_fire(d_id_, kind, event=None, mailer=None, pusher=None):
        fired.append((d_id_, kind))

    async def once():
        raise RuntimeError("헬스 점검 실패")

    monkeypatch.setattr(Notification_Service, "services_notification_deploy_fire", staticmethod(fake_fire))
    await run_loop_briefly(monkeypatch, lambda: fired, once)

    assert fired == [(d_id, 'plan_exceeded')]
