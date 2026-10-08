from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import declarative_base
from pathlib import Path

from shared.settings import settings

# sqlite 파일 경로의 폴더가 없으면 엔진 생성 전에 만들어 둔다
if settings.db_url.startswith("sqlite") and ":///" in settings.db_url:
    db_file=settings.db_url.split(":///", 1)[1]
    if db_file and db_file != ":memory:":
        Path(db_file).resolve().parent.mkdir(parents=True, exist_ok=True)

#비동기 db연결 생성하는 함수(비동기적으로 db와 연결한다)
async_engine=create_async_engine(settings.db_url, echo=False)
# echo 모든 SQL 쿼리 콘솔 로그 여부

# 비동기 엔진과 연결된 세션사용하려고
AsyncSessionLocal = async_sessionmaker(
    autocommit=False, autoflush=False, bind=async_engine, class_=AsyncSession, expire_on_commit=False
)

# 기본 클래스 설정(Base)
Base=declarative_base()

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session
