import json
import pytest
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from features.deploys.crud import Deploy_Crud
from features.deploys.scheme import Deploy_Settings_Update
from features.deploys.services import Deploy_Service
from features.health.services import Health_Service
from features.notifications.models import Notification, Notification_Setting, NOTIFICATION_KINDS
from features.notifications.inbox import Notification_Inbox_Service
from features.notifications.scheme import Notification_Setting_Update
from features.notifications.services import Notification_Service

from recovery_helpers import db, make_deploy

# 알림 설정 마이그레이션 시험 - plan_exceeded 가 생기기 전의 옛 설정(여섯 가지)이 알림 한 건도 못 받는 채로 남지 않게 한다

LEGACY=['incident_opened', 'incident_recovered', 'incident_needs_action', 'deploy_succeeded', 'deploy_failed', 'new_commit']


# 옛 설정 한 줄을 직접 넣는다 - 버전 열이 비어 있으면(None) 옛 DB 에서 온 것
async def seed_setting(db, kinds, version=None):
    db.add(Notification_Setting(id=1, kinds=json.dumps(kinds), kinds_version=version))
    await db.commit()


async def stored(db) -> tuple[list[str], int | None]:
    setting=await db.get(Notification_Setting, 1)
    await db.refresh(setting)
    return json.loads(setting.kinds), setting.kinds_version


@pytest.mark.asyncio
async def test_legacy_six_kinds_gain_plan_exceeded_once(db):
    await seed_setting(db, LEGACY)

    setting=await Notification_Service.services_notification_setting_get(db)
    kinds=Notification_Service.services_notification_kinds(setting)
    assert set(kinds) == set(NOTIFICATION_KINDS) and 'plan_exceeded' in kinds
    assert await stored(db) == (LEGACY + ['plan_exceeded'], 2)

    # 두 번째 읽기는 아무것도 바꾸지 않는다
    await Notification_Service.services_notification_setting_get(db)
    assert await stored(db) == (LEGACY + ['plan_exceeded'], 2)


@pytest.mark.asyncio
async def test_legacy_partial_list_keeps_choice_and_gets_version(db):
    partial=['deploy_failed', 'incident_opened']
    await seed_setting(db, partial)

    setting=await Notification_Service.services_notification_setting_get(db)
    assert Notification_Service.services_notification_kinds(setting) == partial
    assert await stored(db) == (partial, 2)


@pytest.mark.asyncio
async def test_legacy_six_in_other_order_still_counts_as_default(db):
    await seed_setting(db, list(reversed(LEGACY)))

    setting=await Notification_Service.services_notification_setting_get(db)
    assert 'plan_exceeded' in Notification_Service.services_notification_kinds(setting)


@pytest.mark.asyncio
async def test_version_two_with_six_kinds_is_an_explicit_mute(db):
    await seed_setting(db, LEGACY, version=2)

    setting=await Notification_Service.services_notification_setting_get(db)
    assert 'plan_exceeded' not in Notification_Service.services_notification_kinds(setting)
    assert await stored(db) == (LEGACY, 2)


@pytest.mark.asyncio
async def test_patch_with_six_kinds_after_migration_stays_muted(db):
    await seed_setting(db, LEGACY)

    patched=await Notification_Inbox_Service.services_notification_setting_update(db, Notification_Setting_Update(kinds=LEGACY))
    assert patched.kinds == LEGACY
    assert await stored(db) == (LEGACY, 2)

    # 나중에 읽어도 다시 켜지지 않는다
    again=await Notification_Inbox_Service.services_notification_setting_read(db)
    assert again.kinds == LEGACY


@pytest.mark.asyncio
async def test_patch_without_kinds_keeps_migrated_list(db):
    await seed_setting(db, LEGACY)

    patched=await Notification_Inbox_Service.services_notification_setting_update(db, Notification_Setting_Update(notify_push=False))
    assert 'plan_exceeded' in patched.kinds
    assert await stored(db) == (LEGACY + ['plan_exceeded'], 2)


@pytest.mark.asyncio
async def test_fresh_setting_has_all_seven_and_version_two(db):
    setting=await Notification_Service.services_notification_setting_get(db)

    assert set(Notification_Service.services_notification_kinds(setting)) == set(NOTIFICATION_KINDS)
    assert (await stored(db))[1] == 2


@pytest.mark.asyncio
async def test_unreadable_legacy_kinds_gets_version_without_error(db):
    db.add(Notification_Setting(id=1, kinds="깨진 값", kinds_version=None))
    await db.commit()

    setting=await Notification_Service.services_notification_setting_get(db)
    assert set(Notification_Service.services_notification_kinds(setting)) == set(NOTIFICATION_KINDS)
    assert setting.kinds_version == 2


async def plan_rows(db) -> list[Notification]:
    return (await db.execute(select(Notification).where(Notification.kind == 'plan_exceeded').order_by(Notification.n_id))).scalars().all()


# 옛 여섯 가지 설정에서도 시간이 지난 배포는 알림 줄을 정확히 하나 만들고, 예정 시간을 바꾸면 한 번 더 만든다
@pytest.mark.asyncio
async def test_due_plan_on_legacy_setting_notifies_once_and_rearms(db):
    await seed_setting(db, LEGACY)
    d_id=await make_deploy(db)
    started=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=3)
    await Deploy_Crud.crud_deploy_update(db, d_id, {"planned_hours": 2, "running_since": started, "plan_notified_at": None})
    await db.commit()

    assert await Health_Service.services_health_plan_notify() == [d_id]
    await Notification_Service.services_notification_tasks_wait()
    assert len(await plan_rows(db)) == 1

    # 알림 기록이 남아 있어 다시 돌려도 늘지 않는다
    assert await Health_Service.services_health_plan_notify() == []
    await Notification_Service.services_notification_tasks_wait()
    assert len(await plan_rows(db)) == 1

    # 예정 시간을 바꾸면 알림이 다시 켜지고 한 번 더 온다
    await Deploy_Service.services_deploy_settings_update(db, d_id, Deploy_Settings_Update(planned_hours=1))
    assert await Health_Service.services_health_plan_notify() == [d_id]
    await Notification_Service.services_notification_tasks_wait()
    assert len(await plan_rows(db)) == 2
