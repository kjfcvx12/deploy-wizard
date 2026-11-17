import asyncio
import os
import sys
from pathlib import Path

import pytest
import pytest_asyncio

# 테스트는 실제 DB·LLM·AWS를 건드리지 않는다
TEST_DATA=Path(__file__).resolve().parent / ".data"
TEST_DATA.mkdir(exist_ok=True)

# 프로세스마다 따로 둔 DB 파일 - pytest 를 동시에 두 번 돌려도 서로의 표를 지우지 않는다 (끝나면 지운다)
TEST_DB=TEST_DATA / f"test-{os.getpid()}.db"
# timeout=10 - 앞선 시험이 남긴 백그라운드 작업이 잠깐 쓰기 잠금을 쥐고 있어도 다음 시험의 표 만들기가 "database is locked" 로 바로 죽지 않게 기다린다
os.environ["DB_URL"]=f"sqlite+aiosqlite:///{TEST_DB.as_posix()}?timeout=10"
os.environ["LLM_ENABLED"]="false"
os.environ["WORK_DIR"]=str(TEST_DATA / "work")
os.environ["CACHE_DIR"]=str(TEST_DATA / "cache")
# shared/secrets.py 테스트용 고정 키 - 실제 운영 키가 아니다
os.environ["SECRET_KEY"]="beHhcE1V0jAvZWL3WoF7jmPUJgEMzSGZXGDt7_O_X5w="
# 블라인드 인덱스·액세스 토큰 서명용 테스트 키 - 실제 운영 키가 아니다
os.environ["BLIND_INDEX_KEY"]="test-blind-index-key-not-a-real-key"
os.environ["AUTH_JWT_KEY"]="test-auth-jwt-key-not-a-real-key-0123456789"

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# deploys.u_id 등의 FK 가 users 를 가리켜, 시험 파일이 main 없이 create_all 해도 users 표를 알게 한다 (환경변수를 정한 뒤 불러온다)
from features.auth import models as auth_models  # noqa: E402,F401
# 알림 시험이 배포 조회에서 deploy_env_vars 를 읽는다 - 단독 실행에서도 표가 만들어지게 (Task 5 이전부터 있던 단독 실행 실패)
from features.envvars import models as envvar_models  # noqa: E402,F401


# 시험이 끝나면 이 프로세스의 DB 파일을 지운다 - 연결을 닫고 지우며, 못 지우면 남겨 둬도 다음 실행에 영향이 없다
def pytest_sessionfinish(session, exitstatus):
    try:
        from shared.database import async_engine

        asyncio.run(async_engine.dispose())
    except Exception:
        pass

    for suffix in ("", "-wal", "-shm", "-journal"):
        try:
            Path(str(TEST_DB) + suffix).unlink()
        except OSError:
            pass


# 알림 - 실제 .env 의 메일·푸시 설정이 시험에 새어 들어가 진짜 발송이 일어나지 않게 매 시험마다 비워 둔다
@pytest.fixture(autouse=True)
def notification_settings_isolated(monkeypatch):
    from shared.settings import settings

    for name in ("mail_host", "mail_to", "mail_user", "mail_password", "mail_from"):
        monkeypatch.setattr(settings, name, None)

    monkeypatch.setattr(settings, "expo_push_url", "http://expo.invalid/push/send")
    monkeypatch.setattr(settings, "app_link_base", "deploywizard://")


# 가격 - 앞선 시험의 갱신 실패 기록·잠금이 남지 않게 하고, 실제 .env 의 ECS_CPU/ECS_MEMORY 가 기본 사양 시험에 새어 들어가지 않게 매 시험마다 비워 둔다
@pytest.fixture(autouse=True)
def pricing_state_isolated(monkeypatch):
    from shared.settings import settings
    from features.pricing import services as pricing_services

    pricing_services.REFRESH_FAILED_AT.clear()
    pricing_services.REFRESH_LOCKS.clear()
    monkeypatch.setattr(settings, "ecs_cpu", None)
    monkeypatch.setattr(settings, "ecs_memory", None)


# 시험이 끝나면 그 시험이 띄운 백그라운드 작업이 남지 않게 한다 - 인시던트·알림 작업은 끝나기를 기다리고, 배포 파이프라인 작업은 취소한 뒤 기다린다
# (다음 시험의 표 만들기와 겹쳐 "database is locked" 가 나는 것을 막는다.) 다른 이벤트 루프(모듈 단위 루프)의 작업은 여기서 건드리지 않는다
@pytest_asyncio.fixture(autouse=True)
async def background_tasks_finished():
    yield

    from features.deploys.pipeline import Deploy_Pipeline
    from features.incidents.services import INCIDENT_TASKS
    from features.notifications.services import NOTIFICATION_TASKS

    loop=asyncio.get_running_loop()

    for task in [task for task in list(Deploy_Pipeline.tasks.values()) if task.get_loop() is loop and not task.done()]:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    for tasks in (INCIDENT_TASKS, NOTIFICATION_TASKS):
        own=[task for task in list(tasks) if task.get_loop() is loop]
        if own:
            _, pending=await asyncio.wait(own, timeout=15)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
