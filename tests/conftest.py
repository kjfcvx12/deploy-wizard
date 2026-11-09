import asyncio
import os
import sys
from pathlib import Path

import pytest

# 테스트는 실제 DB·LLM·AWS를 건드리지 않는다
TEST_DATA=Path(__file__).resolve().parent / ".data"
TEST_DATA.mkdir(exist_ok=True)

# 프로세스마다 따로 둔 DB 파일 - pytest 를 동시에 두 번 돌려도 서로의 표를 지우지 않는다 (끝나면 지운다)
TEST_DB=TEST_DATA / f"test-{os.getpid()}.db"
# timeout=30 - 앞선 시험이 남긴 백그라운드 작업이 잠깐 쓰기 잠금을 쥐고 있어도 다음 시험의 표 만들기가 "database is locked" 로 바로 죽지 않게 기다린다
os.environ["DB_URL"]=f"sqlite+aiosqlite:///{TEST_DB.as_posix()}?timeout=30"
os.environ["LLM_ENABLED"]="false"
os.environ["WORK_DIR"]=str(TEST_DATA / "work")
os.environ["CACHE_DIR"]=str(TEST_DATA / "cache")
# shared/secrets.py 테스트용 고정 키 - 실제 운영 키가 아니다
os.environ["SECRET_KEY"]="beHhcE1V0jAvZWL3WoF7jmPUJgEMzSGZXGDt7_O_X5w="

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


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
