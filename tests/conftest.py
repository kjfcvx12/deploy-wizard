import os
import sys
from pathlib import Path

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
