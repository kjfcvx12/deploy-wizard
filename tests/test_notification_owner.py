import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select, text

from shared.database import Base, async_engine, AsyncSessionLocal
from shared.settings import settings
from shared.secrets import blind_index

from features.notifications.dispatch import Push_Result

from auth_helpers import make_user, auth_header


# 로그인 계획 Task 7 - 알림·기기·설정의 사용자별 수신 (남의 것은 404, 주인 없는 배포는 지금처럼)

TOKEN_A="ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]"
TOKEN_B="ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]"
TOKEN_NONE="ExponentPushToken[nnnnnnnnnnnnnnnnnnnnnn]"
EMAIL_A="a@example.com"
EMAIL_B="b@example.com"


@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app

    monkeypatch.setattr(settings, "auth_enabled", False)

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


class Fake_Mailer:

    def __init__(self, error=None):
        self.calls=[]
        self.error=error

    async def __call__(self, subject, body, to=None):
        self.calls.append(to)
        if self.error is not None:
            raise self.error


class Fake_Pusher:

    def __init__(self):
        self.calls=[]

    async def __call__(self, devices, title, body, link):
        self.calls.append(sorted(device.expo_token for device in devices))
        return Push_Result(sent=len(devices), failed=0, invalid_tokens=[], error=None)


# 사용자 A·B 를 만들고 켬 모드로 바꾼다 - 반환: (A, B)
async def users_on(monkeypatch) -> tuple[int, int]:
    async with AsyncSessionLocal() as db:
        a=await make_user(db, EMAIL_A)
        b=await make_user(db, EMAIL_B)

    monkeypatch.setattr(settings, "auth_enabled", True)
    return a, b


# 배포 행을 바로 만든다 - 반환: d_id
async def deploy_make(u_id:int|None) -> int:
    from features.deploys.models import Deploy

    async with AsyncSessionLocal() as db:
        db_deploy=Deploy(repo_url="https://github.com/o/r", status="running", u_id=u_id, service_name="svc")
        db.add(db_deploy)
        await db.commit()
        return db_deploy.d_id


# 배포 알림을 백그라운드로 보내고 끝나기를 기다린다
async def fire(d_id:int, kind:str, mailer, pusher) -> None:
    from features.notifications.services import Notification_Service

    Notification_Service.services_notification_deploy_fire(d_id, kind, mailer=mailer, pusher=pusher)
    await Notification_Service.services_notification_tasks_wait()


# 알림 줄 전부
async def notification_rows() -> list:
    from features.notifications.models import Notification

    async with AsyncSessionLocal() as db:
        return list((await db.execute(select(Notification).order_by(Notification.n_id))).scalars().all())


# 앱 안 알림 목록·수는 그 배포 주인에게만, 남의 n_id 읽음은 404
@pytest.mark.asyncio
async def test_notification_inbox_isolated(client, monkeypatch):
    a, b=await users_on(monkeypatch)
    d_a=await deploy_make(a)

    await fire(d_a, 'deploy_failed', Fake_Mailer(), Fake_Pusher())
    inapp=[row for row in await notification_rows() if row.channel == 'inapp']
    assert len(inapp) == 1 and inapp[0].u_id == a
    n_id=inapp[0].n_id

    assert [row["n_id"] for row in (await client.get("/api/notifications", headers=auth_header(a))).json()] == [n_id]
    assert (await client.get("/api/notifications", headers=auth_header(b))).json() == []
    assert (await client.get("/api/notifications/unread-count", headers=auth_header(a))).json() == {"count": 1}
    assert (await client.get("/api/notifications/unread-count", headers=auth_header(b))).json() == {"count": 0}

    assert (await client.post(f"/api/notifications/{n_id}/read", headers=auth_header(b))).status_code == 404
    assert (await client.post("/api/notifications/read-all", headers=auth_header(b))).json() == {"updated": 0}
    assert (await client.get("/api/notifications/unread-count", headers=auth_header(a))).json() == {"count": 1}

    assert (await client.post(f"/api/notifications/{n_id}/read", headers=auth_header(a))).status_code == 200
    assert (await client.get("/api/notifications/unread-count", headers=auth_header(a))).json() == {"count": 0}


# 설정은 사용자마다 따로, 끔 모드는 id=1 줄
@pytest.mark.asyncio
async def test_notification_settings_per_user(client, monkeypatch):
    from features.notifications.models import Notification_Setting

    a, b=await users_on(monkeypatch)

    patched=await client.patch("/api/notifications/settings", json={"kinds": ["deploy_failed"], "notify_push": False}, headers=auth_header(a))
    assert patched.status_code == 200 and patched.json()["kinds"] == ["deploy_failed"]

    theirs=(await client.get("/api/notifications/settings", headers=auth_header(b))).json()
    assert theirs["notify_push"] is True and len(theirs["kinds"]) == 7
    assert (await client.get("/api/notifications/settings", headers=auth_header(a))).json() == patched.json()

    monkeypatch.setattr(settings, "auth_enabled", False)
    off=(await client.get("/api/notifications/settings")).json()
    assert off["notify_push"] is True and len(off["kinds"]) == 7

    async with AsyncSessionLocal() as db:
        by_owner={row.u_id: row.id for row in (await db.execute(select(Notification_Setting))).scalars().all()}
    assert by_owner[None] == 1 and set(by_owner) == {None, a, b}


# 발송은 배포 주인의 이메일·기기로만, 주인 없는 배포는 MAIL_TO·전체 기기
@pytest.mark.asyncio
async def test_notification_fire_targets_owner(client, monkeypatch):
    from features.incidents.crud import Incident_Crud
    from features.notifications.services import Notification_Service

    a, b=await users_on(monkeypatch)
    monkeypatch.setattr(settings, "mail_host", "smtp.test")
    monkeypatch.setattr(settings, "mail_to", "ops@test")

    assert (await client.post("/api/devices", json={"expo_token": TOKEN_A, "platform": "android"}, headers=auth_header(a))).status_code == 201
    assert (await client.post("/api/devices", json={"expo_token": TOKEN_B, "platform": "android"}, headers=auth_header(b))).status_code == 201

    d_a=await deploy_make(a)
    mailer, pusher=Fake_Mailer(), Fake_Pusher()
    await fire(d_a, 'deploy_failed', mailer, pusher)
    assert mailer.calls == [EMAIL_A] and pusher.calls == [[TOKEN_A]]
    assert {row.u_id for row in await notification_rows()} == {a}

    # 인시던트 알림도 배포 주인에게
    async with AsyncSessionLocal() as db:
        incident=await Incident_Crud.crud_incident_create(db, d_a, "unhealthy", "요약")
        await db.commit()
        mailer, pusher=Fake_Mailer(), Fake_Pusher()
        await Notification_Service.services_notification_send_incident(db, incident, 'incident_opened', mailer=mailer, pusher=pusher)
    assert mailer.calls == [EMAIL_A] and pusher.calls == [[TOKEN_A]]
    assert {row.u_id for row in await notification_rows()} == {a}

    # 주인 없는 배포 (인증 켬) - 받는 사람을 넘기지 않고(MAIL_TO), 푸시는 주인 없는 기기에만 (A·B 기기에는 가지 않는다)
    from features.notifications.models import Push_Device
    async with AsyncSessionLocal() as db:
        db.add(Push_Device(expo_token=TOKEN_NONE, platform='android'))
        await db.commit()

    d_none=await deploy_make(None)
    mailer, pusher=Fake_Mailer(), Fake_Pusher()
    await fire(d_none, 'deploy_failed', mailer, pusher)
    assert mailer.calls == [None] and pusher.calls == [[TOKEN_NONE]]

    # 인증 끔 - 지금처럼 전체 기기
    monkeypatch.setattr(settings, "auth_enabled", False)
    mailer, pusher=Fake_Mailer(), Fake_Pusher()
    await fire(d_none, 'deploy_succeeded', mailer, pusher)
    assert mailer.calls == [None] and pusher.calls == [sorted([TOKEN_A, TOKEN_B, TOKEN_NONE])]
    monkeypatch.setattr(settings, "auth_enabled", True)

    # 메일 실패 문장에 받는 사람 주소가 남지 않는다
    mailer=Fake_Mailer(error=RuntimeError(f"수신 거부 <{EMAIL_A}>"))
    await fire(d_a, 'deploy_succeeded', mailer, Fake_Pusher())
    failed=[row for row in await notification_rows() if row.channel == 'email' and row.status == 'failed']
    assert len(failed) == 1 and "수신 거부" in failed[0].error and EMAIL_A not in failed[0].error


# 기기 토큰은 암호문으로 저장, 같은 토큰 재등록은 갱신, 무효 토큰 정리는 bidx 로
@pytest.mark.asyncio
async def test_device_token_encrypted_and_lookup(client, monkeypatch):
    from features.notifications.crud import Notification_Crud

    a, b=await users_on(monkeypatch)

    first=await client.post("/api/devices", json={"expo_token": TOKEN_A, "platform": "android"}, headers=auth_header(a))
    again=await client.post("/api/devices", json={"expo_token": TOKEN_A, "platform": "android"}, headers=auth_header(a))
    assert first.status_code == again.status_code == 201
    assert first.json()["p_d_id"] == again.json()["p_d_id"] and first.json()["token_tail"] == TOKEN_A[-6:]

    async with AsyncSessionLocal() as db:
        raw=(await db.execute(text("SELECT expo_token, expo_token_bidx, u_id FROM push_devices"))).all()
        assert len(raw) == 1
        assert raw[0][0].startswith("gAAAAA") and TOKEN_A not in raw[0][0]
        assert raw[0][1] == blind_index("expo_token", TOKEN_A) and raw[0][2] == a

        assert await Notification_Crud.crud_notification_device_delete_by_tokens(db, [TOKEN_A]) == 1
        await db.commit()
        assert (await db.execute(text("SELECT COUNT(*) FROM push_devices"))).scalar_one() == 0

    # 남의 기기 삭제는 404
    p_d_id=(await client.post("/api/devices", json={"expo_token": TOKEN_A, "platform": "android"}, headers=auth_header(a))).json()["p_d_id"]
    assert (await client.delete(f"/api/devices/{p_d_id}", headers=auth_header(b))).status_code == 404
    assert (await client.delete(f"/api/devices/{p_d_id}", headers=auth_header(a))).status_code == 200


# A 가 등록한 토큰을 B 가 등록하면 B 의 기기가 된다 (행 1개)
@pytest.mark.asyncio
async def test_device_moves_to_new_user(client, monkeypatch):
    from features.notifications.models import Push_Device

    a, b=await users_on(monkeypatch)

    first=await client.post("/api/devices", json={"expo_token": TOKEN_A, "platform": "android"}, headers=auth_header(a))
    moved=await client.post("/api/devices", json={"expo_token": TOKEN_A, "platform": "android"}, headers=auth_header(b))
    assert moved.status_code == 201 and moved.json()["p_d_id"] == first.json()["p_d_id"]

    async with AsyncSessionLocal() as db:
        devices=(await db.execute(select(Push_Device))).scalars().all()
    assert len(devices) == 1 and devices[0].u_id == b


# 이전 전 평문 토큰이 남은 기기 하나 때문에 다른 기기로의 발송이 멈추지 않는다
@pytest.mark.asyncio
async def test_device_legacy_plaintext_row_is_skipped(client, monkeypatch):
    monkeypatch.setattr(settings, "mail_host", None)

    assert (await client.post("/api/devices", json={"expo_token": TOKEN_A, "platform": "android"})).status_code == 201
    async with AsyncSessionLocal() as db:
        await db.execute(text("INSERT INTO push_devices (expo_token, platform) VALUES ('ExponentPushToken[legacyplain]', 'android')"))
        await db.commit()

    d_none=await deploy_make(None)
    pusher=Fake_Pusher()
    await fire(d_none, 'deploy_failed', Fake_Mailer(), pusher)
    assert pusher.calls == [[TOKEN_A]]
    assert [row.status for row in await notification_rows() if row.channel == 'push'] == ['sent']

# 무효 토큰 정리가 실패해도(BLIND_INDEX_KEY 없음 등) 발송 줄은 실제 상태(sent)로 남고 백그라운드 작업은 오류 없이 끝난다
@pytest.mark.asyncio
async def test_push_cleanup_failure_keeps_status(client, monkeypatch):
    from shared.secrets import Secret_Error
    from features.notifications.crud import Notification_Crud

    assert (await client.post("/api/devices", json={"expo_token": TOKEN_A, "platform": "android"})).status_code == 201

    async def boom(db, tokens):
        raise Secret_Error("BLIND_INDEX_KEY가 설정되지 않았습니다 (.env 확인)")

    monkeypatch.setattr(Notification_Crud, "crud_notification_device_delete_by_tokens", staticmethod(boom))

    class Invalid_Pusher(Fake_Pusher):
        async def __call__(self, devices, title, body, link):
            self.calls.append(sorted(device.expo_token for device in devices))
            return Push_Result(sent=1, failed=1, invalid_tokens=[TOKEN_B], error=None)

    d_none=await deploy_make(None)
    pusher=Invalid_Pusher()
    await fire(d_none, 'deploy_failed', Fake_Mailer(), pusher)

    assert pusher.calls == [[TOKEN_A]]
    assert [row.status for row in await notification_rows() if row.channel == 'push'] == ['sent']


# 옛 DB - push_devices 에 expo_token_bidx, notification_settings 에 u_id 열과 유일 인덱스가 생기고 기존 줄은 그대로 (두 번째는 아무것도 안 한다)
def test_notification_ensure_columns_on_old_db(tmp_path):
    import asyncio
    import sqlite3
    from sqlalchemy.ext.asyncio import create_async_engine
    from shared.database import bootstrap_schema
    from features.notifications import models  # noqa: F401 - 표를 Base.metadata 에 올린다

    path=tmp_path / "old-notify.db"
    conn=sqlite3.connect(path)
    conn.execute("CREATE TABLE push_devices (p_d_id INTEGER PRIMARY KEY, u_id INTEGER, expo_token VARCHAR(255) NOT NULL UNIQUE, platform VARCHAR(10) NOT NULL)")
    conn.execute("CREATE TABLE notification_settings (id INTEGER PRIMARY KEY, notify_email BOOLEAN NOT NULL, notify_push BOOLEAN NOT NULL, kinds TEXT NOT NULL)")
    conn.execute("INSERT INTO push_devices (expo_token, platform) VALUES ('ExponentPushToken[old]', 'android')")
    conn.execute("INSERT INTO notification_settings (id, notify_email, notify_push, kinds) VALUES (1, 1, 1, '[]')")
    conn.commit()
    conn.close()

    async def run():
        engine=create_async_engine(f"sqlite+aiosqlite:///{path.as_posix()}")
        try:
            return await bootstrap_schema(engine), await bootstrap_schema(engine)
        finally:
            await engine.dispose()

    first, second=asyncio.run(run())

    assert {"push_devices.expo_token_bidx", "notification_settings.u_id", "ix_push_devices_expo_token_bidx",
            "ix_push_devices_u_id", "ix_notification_settings_u_id"} <= set(first)
    assert second == []

    conn=sqlite3.connect(path)
    assert conn.execute("SELECT expo_token, expo_token_bidx FROM push_devices").fetchall() == [("ExponentPushToken[old]", None)]
    assert conn.execute("SELECT id, u_id FROM notification_settings").fetchall() == [(1, None)]
    unique={row[1]: row[2] for row in conn.execute("PRAGMA index_list('notification_settings')")}
    assert unique["ix_notification_settings_u_id"] == 1
    conn.close()
