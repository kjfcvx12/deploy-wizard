import os
import sys
from pathlib import Path

import pytest

# 테스트는 실제 DB·LLM·AWS를 건드리지 않는다
TEST_DATA=Path(__file__).resolve().parent / ".data"
TEST_DATA.mkdir(exist_ok=True)

os.environ["DB_URL"]=f"sqlite+aiosqlite:///{(TEST_DATA / 'test.db').as_posix()}"
os.environ["LLM_ENABLED"]="false"
os.environ["WORK_DIR"]=str(TEST_DATA / "work")
os.environ["CACHE_DIR"]=str(TEST_DATA / "cache")
# shared/secrets.py 테스트용 고정 키 - 실제 운영 키가 아니다
os.environ["SECRET_KEY"]="beHhcE1V0jAvZWL3WoF7jmPUJgEMzSGZXGDt7_O_X5w="

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


# 알림 - 실제 .env 의 메일·푸시 설정이 시험에 새어 들어가 진짜 발송이 일어나지 않게 매 시험마다 비워 둔다
@pytest.fixture(autouse=True)
def notification_settings_isolated(monkeypatch):
    from shared.settings import settings

    for name in ("mail_host", "mail_to", "mail_user", "mail_password", "mail_from"):
        monkeypatch.setattr(settings, name, None)

    monkeypatch.setattr(settings, "expo_push_url", "http://expo.invalid/push/send")
    monkeypatch.setattr(settings, "app_link_base", "deploywizard://")
