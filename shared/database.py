from sqlalchemy import inspect
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


# 기존 표에 뒤늦게 늘어난 열 - create_all 은 이미 있는 표에 열을 더하지 않는다 (SQLite). 모델의 열 정의가 기준이다
ENSURE_COLUMNS={
    "notification_settings": ["kinds_version", "u_id"],
    "push_devices": ["expo_token_bidx"],
    "deploys": ["auto_recover", "health_state", "last_health_at", "bad_commit_sha",
                "cpu", "memory", "min_tasks", "max_tasks", "scale_metric", "scale_target", "planned_hours", "running_since", "plan_notified_at",
                "u_id"],
    "aws_accounts": ["u_id"],
    "github_installations": ["u_id"],
    "connections": ["u_id"],
}

# 기존 표에 뒤늦게 늘어난 인덱스 - 표 이름 -> [(인덱스 이름, 열들, unique)]. 이름은 create_all 이 index=True 로 짓는 것과 같게 (ix_<표>_<열>)
ENSURE_INDEXES: dict[str, list[tuple[str, list[str], bool]]]={
    "deploys": [("ix_deploys_u_id", ["u_id"], False)],
    "aws_accounts": [("ix_aws_accounts_u_id", ["u_id"], False)],
    "github_installations": [("ix_github_installations_u_id", ["u_id"], False)],
    "connections": [("ix_connections_u_id", ["u_id"], False)],
    "notification_settings": [("ix_notification_settings_u_id", ["u_id"], True)],
    "push_devices": [("ix_push_devices_expo_token_bidx", ["expo_token_bidx"], True),
                     ("ix_push_devices_u_id", ["u_id"], False)],
}


# 서버 시작과 같은 DB 준비 - 없는 표를 만들고(create_all) 옛 표에 모자란 열·인덱스를 더한다. 반환: 이번에 더한 "표.열"·인덱스 이름 목록
# 모델은 부르는 쪽이 미리 import 해 둬야 create_all 이 표를 안다 (main.py · scripts/*.py 가 같이 쓴다)
async def bootstrap_schema(engine=None) -> list[str]:
    async with (engine or async_engine).begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        added=await conn.run_sync(ensure_columns)
        return added + await conn.run_sync(ensure_indexes)


# 열 기본값을 DDL 상수로 - 모델의 파이썬 기본값(bool/숫자/문자열)만 다룬다
def column_default_sql(column) -> str:
    default=column.default.arg if column.default is not None and column.default.is_scalar else None

    if default is None:
        return ""
    if isinstance(default, bool):
        return f" DEFAULT {int(default)}"
    if isinstance(default, (int, float)):
        return f" DEFAULT {default}"

    return " DEFAULT '" + str(default).replace("'", "''") + "'"


# 옛 DB 보정 - 모델에는 있는데 실제 표에 없는 열만 ALTER TABLE ADD COLUMN 으로 더한다. 여러 번 불러도 안전하다
# 반환: 이번에 더한 "표.열" 목록. 표 자체가 없으면(새 DB) 건너뛴다. conn 은 동기 연결 (run_sync 로 넘긴다)
def ensure_columns(conn) -> list[str]:
    inspector=inspect(conn)
    existing_tables=set(inspector.get_table_names())
    added=[]

    for table_name, column_names in ENSURE_COLUMNS.items():
        table=Base.metadata.tables.get(table_name)
        if table is None or table_name not in existing_tables:
            continue

        present={c["name"] for c in inspector.get_columns(table_name)}

        for name in column_names:
            if name in present:
                continue

            column=table.columns[name]
            column_type=column.type.compile(dialect=conn.dialect)
            not_null=" NOT NULL" if not column.nullable else ""
            default_sql=column_default_sql(column)

            # NOT NULL 열은 기본값이 있어야 기존 행이 채워진다
            if not_null and not default_sql:
                raise RuntimeError(f"{table_name}.{name} : NOT NULL 열에 기본값이 없어 추가할 수 없습니다")

            conn.exec_driver_sql(f'ALTER TABLE {table_name} ADD COLUMN {name} {column_type}{not_null}{default_sql}')
            added.append(f"{table_name}.{name}")

    return added


# 옛 DB 보정 - ENSURE_INDEXES 중 실제 표에 없는 인덱스만 CREATE [UNIQUE] INDEX IF NOT EXISTS 로 만든다. 여러 번 불러도 안전하다
# 반환: 이번에 만든 인덱스 이름 목록. 표나 열이 없으면 건너뛴다 (ensure_columns 뒤에 부른다). conn 은 동기 연결
def ensure_indexes(conn) -> list[str]:
    inspector=inspect(conn)
    existing_tables=set(inspector.get_table_names())
    created=[]

    for table_name, indexes in ENSURE_INDEXES.items():
        if table_name not in existing_tables:
            continue

        present={index["name"] for index in inspector.get_indexes(table_name)}
        columns={c["name"] for c in inspector.get_columns(table_name)}

        for name, column_names, unique in indexes:
            if name in present or not set(column_names) <= columns:
                continue

            unique_sql="UNIQUE " if unique else ""
            conn.exec_driver_sql(f'CREATE {unique_sql}INDEX IF NOT EXISTS {name} ON {table_name} ({", ".join(column_names)})')
            created.append(name)

    return created
