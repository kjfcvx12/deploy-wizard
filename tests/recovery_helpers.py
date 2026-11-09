import pytest
import pytest_asyncio
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from shared.database import Base, async_engine, AsyncSessionLocal

from features.deploys.models import Deploy, Deploy_Release
from features.incidents.models import Incident, Recovery_Action
from features.accounts.services import Aws_Account_Service
from features.notifications.services import Notification_Service

# 자동 복구 시험 공통 도구 - 실제 AWS·네트워크는 부르지 않고 updater/waiter/sleeper/checker 를 가짜로 끼운다

def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


CUR_SHA="c" * 40
PREV_SHA="a" * 40
CUR_IMAGE="111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/x:ccccccc"
PREV_IMAGE="111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/x:aaaaaaa"
TOKEN="ghp_abcdefghijklmnopqrstuvwxyz0123456789"


@pytest_asyncio.fixture
async def db():
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as session:
        yield session


@pytest.fixture
def notified(monkeypatch):
    sent=[]

    async def fake_send(db, incident, kind):
        sent.append((incident.i_id, kind))

    monkeypatch.setattr(Notification_Service, "services_notification_send_incident", staticmethod(fake_send))
    return sent


@pytest.fixture
def aws_session(monkeypatch):
    async def fake_build(db, aws_account_id):
        return "FAKE_SESSION"

    monkeypatch.setattr(Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_build))


# AWS 호출 기록 - 블로킹 함수라 to_thread 안에서 불린다
class Fakes:

    def __init__(self, fail_update=None, healthy_images=None, ok_sequence=None):
        self.updates=[]
        self.waits=[]
        self.sleeps=[]
        self.checked=[]
        self.fail_update=fail_update
        # 이 이미지로 갱신한 뒤에만 정상으로 답한다 (None 이면 ok_sequence 를 쓴다)
        self.healthy_images=healthy_images
        self.ok_sequence=list(ok_sequence) if ok_sequence is not None else None

    def updater(self, session, service_arn, image_uri, port, health_check_path="/", environment=None):
        self.updates.append((session, service_arn, image_uri, port, health_check_path, environment))
        if self.fail_update is not None:
            raise self.fail_update

    def waiter(self, session, service_arn, on_progress=None):
        self.waits.append(service_arn)

    async def sleeper(self, seconds):
        self.sleeps.append(seconds)

    async def checker(self, url):
        self.checked.append(url)

        if self.ok_sequence is not None:
            ok=self.ok_sequence.pop(0) if self.ok_sequence else False
        else:
            ok=bool(self.updates) and self.updates[-1][2] in (self.healthy_images or ())

        return (ok, 200 if ok else 503, 5, None if ok else "HTTP 503")

    def kwargs(self):
        return dict(updater=self.updater, waiter=self.waiter, sleeper=self.sleeper, checker=self.checker)


# 떠 있는 배포 + (선택) 이전·현재 릴리스. previous_healthy=None 이면 이전 릴리스 없음
async def make_deploy(db, status='running', auto_recover=True, service_arn="arn:aws:ecs:x:1:service/s", previous_healthy=True,
                      previous_image=PREV_IMAGE, with_previous=True, endpoint="https://abc.example.com") -> int:
    deploy=Deploy(repo_url="https://github.com/o/r", status=status, endpoint=endpoint, health_check_path='/health',
                  auto_recover=auto_recover, service_arn=service_arn, port=8000,
                  image_uri=CUR_IMAGE, commit_sha=CUR_SHA)
    db.add(deploy)
    await db.flush()

    if with_previous:
        db.add(Deploy_Release(d_id=deploy.d_id, commit_sha=PREV_SHA, image_uri=previous_image, state='previous',
                              healthy_since=datetime(2026, 11, 1) if previous_healthy else None))
    db.add(Deploy_Release(d_id=deploy.d_id, commit_sha=CUR_SHA, image_uri=CUR_IMAGE, state='current'))
    await db.commit()
    return deploy.d_id


async def make_incident(db, d_id, kind='unhealthy', status='open') -> int:
    incident=Incident(d_id=d_id, kind=kind, status=status, summary="문제")
    db.add(incident)
    await db.commit()
    return incident.i_id


async def add_action(db, i_id, action='restart', result='failed', started_at=None):
    db.add(Recovery_Action(i_id=i_id, action=action, result=result, started_at=started_at or _now()))
    await db.commit()


# 저장된 값을 새 세션으로 읽는다
async def fresh_incident(i_id) -> Incident:
    async with AsyncSessionLocal() as session:
        return await session.get(Incident, i_id)


async def fresh_deploy(d_id) -> Deploy:
    async with AsyncSessionLocal() as session:
        return await session.get(Deploy, d_id)


async def actions_of(i_id) -> list[tuple[str, str]]:
    async with AsyncSessionLocal() as session:
        rows=(await session.execute(select(Recovery_Action).where(Recovery_Action.i_id == i_id).order_by(Recovery_Action.r_a_id))).scalars().all()
        return [(row.action, row.result) for row in rows]


async def action_rows(i_id) -> list[Recovery_Action]:
    async with AsyncSessionLocal() as session:
        return (await session.execute(select(Recovery_Action).where(Recovery_Action.i_id == i_id).order_by(Recovery_Action.r_a_id))).scalars().all()


async def release_states(d_id) -> list[tuple[str, str]]:
    async with AsyncSessionLocal() as session:
        rows=(await session.execute(select(Deploy_Release).where(Deploy_Release.d_id == d_id).order_by(Deploy_Release.d_r_id))).scalars().all()
        return [(row.commit_sha[0], row.state) for row in rows]
