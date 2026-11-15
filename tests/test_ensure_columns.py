import sqlite3
import pytest
from sqlalchemy import create_engine, inspect, text

# 모델을 import 해야 Base.metadata 가 deploys 를 안다
from features.accounts import models as account_models
from features.deploys import models as deploy_models
from shared.database import Base, ensure_columns, ENSURE_COLUMNS

NEW_COLUMNS={'auto_recover', 'health_state', 'last_health_at', 'bad_commit_sha'}


# 새 열이 생기기 전의 deploys 표를 가진 옛 DB 파일을 만든다
def make_old_db(path) -> str:
    conn=sqlite3.connect(path)
    conn.execute("CREATE TABLE deploys (d_id INTEGER PRIMARY KEY, repo_url VARCHAR(255) NOT NULL, status VARCHAR(20) NOT NULL)")
    conn.execute("INSERT INTO deploys (repo_url, status) VALUES ('https://github.com/o/r', 'running')")
    conn.commit()
    conn.close()
    return f"sqlite:///{path.as_posix()}"


def test_ensure_columns_adds_missing_columns_once(tmp_path):
    engine=create_engine(make_old_db(tmp_path / "old.db"))

    with engine.begin() as conn:
        assert NEW_COLUMNS.isdisjoint(c["name"] for c in inspect(conn).get_columns("deploys"))
        added=ensure_columns(conn)

    assert set(added) == {f"deploys.{name}" for name in ENSURE_COLUMNS["deploys"]}

    with engine.begin() as conn:
        assert NEW_COLUMNS <= {c["name"] for c in inspect(conn).get_columns("deploys")}

        # 기존 행은 모델의 기본값을 갖는다
        row=conn.execute(text("SELECT auto_recover, health_state, last_health_at, bad_commit_sha FROM deploys")).one()
        assert row[0] == 1 and row[1] == 'unknown' and row[2] is None and row[3] is None

        # 두 번째 호출은 아무것도 바꾸지 않는다
        assert ensure_columns(conn) == []

    engine.dispose()


def test_ensure_columns_is_safe_on_fresh_db(tmp_path):
    engine=create_engine(f"sqlite:///{(tmp_path / 'fresh.db').as_posix()}")

    with engine.begin() as conn:
        # 표가 아직 없으면 건너뛴다
        assert ensure_columns(conn) == []

        Base.metadata.create_all(conn)

        # create_all 이 이미 열을 만들었으므로 할 일이 없다
        assert ensure_columns(conn) == []

    engine.dispose()


def test_ensure_columns_keeps_existing_rows_usable(tmp_path):
    engine=create_engine(make_old_db(tmp_path / "old2.db"))

    with engine.begin() as conn:
        ensure_columns(conn)
        conn.execute(text("INSERT INTO deploys (repo_url, status) VALUES ('https://github.com/o/n', 'queued')"))
        rows=conn.execute(text("SELECT auto_recover, health_state FROM deploys ORDER BY d_id")).all()

    assert [tuple(r) for r in rows] == [(1, 'unknown'), (1, 'unknown')]
    engine.dispose()


# 사양·증설·예정 시간 열 9개가 옛 DB 에도 더해지고, 기존 행은 모두 null
def test_ensure_columns_adds_new_deploy_columns(tmp_path):
    new_columns={'cpu', 'memory', 'min_tasks', 'max_tasks', 'scale_metric', 'scale_target', 'planned_hours', 'running_since', 'plan_notified_at'}
    engine=create_engine(make_old_db(tmp_path / "old3.db"))

    with engine.begin() as conn:
        assert new_columns.isdisjoint(c["name"] for c in inspect(conn).get_columns("deploys"))
        added=ensure_columns(conn)

        assert {f"deploys.{name}" for name in new_columns} <= set(added)
        assert new_columns <= {c["name"] for c in inspect(conn).get_columns("deploys")}

        row=conn.execute(text("SELECT cpu, memory, min_tasks, max_tasks, scale_metric, scale_target, planned_hours, running_since, plan_notified_at FROM deploys")).one()
        assert all(value is None for value in row)

        assert ensure_columns(conn) == []

    engine.dispose()


# 알림 설정 표에 kinds_version 이 더해지고 기존 행은 null(옛 설정)로 남는다
def test_ensure_columns_adds_notification_kinds_version(tmp_path):
    from features.notifications import models as notification_models  # noqa: F401 - Base.metadata 가 notification_settings 를 알게 한다

    path=tmp_path / "old4.db"
    conn=sqlite3.connect(path)
    conn.execute("CREATE TABLE notification_settings (id INTEGER PRIMARY KEY, notify_email BOOLEAN NOT NULL, notify_push BOOLEAN NOT NULL, kinds TEXT NOT NULL)")
    conn.execute("INSERT INTO notification_settings (id, notify_email, notify_push, kinds) VALUES (1, 1, 1, '[\"deploy_failed\"]')")
    conn.commit()
    conn.close()

    engine=create_engine(f"sqlite:///{path.as_posix()}")

    with engine.begin() as conn:
        assert "kinds_version" not in {c["name"] for c in inspect(conn).get_columns("notification_settings")}
        added=ensure_columns(conn)

        assert "notification_settings.kinds_version" in added
        assert conn.execute(text("SELECT kinds_version FROM notification_settings")).scalar() is None
        assert ensure_columns(conn) == []

    engine.dispose()


# 스크립트가 서버처럼 쓰는 시작 도우미 - 옛 DB 에서도 모자란 열을 채운다
def test_bootstrap_schema_upgrades_old_db(tmp_path):
    import asyncio
    from sqlalchemy.ext.asyncio import create_async_engine
    from shared.database import bootstrap_schema

    path=tmp_path / "old5.db"
    make_old_db(path)

    async def run():
        engine=create_async_engine(f"sqlite+aiosqlite:///{path.as_posix()}")
        try:
            first=await bootstrap_schema(engine)
            second=await bootstrap_schema(engine)
        finally:
            await engine.dispose()
        return first, second

    first, second=asyncio.run(run())

    assert "deploys.cpu" in first
    assert second == []

    conn=sqlite3.connect(path)
    assert conn.execute("SELECT cpu, planned_hours FROM deploys").fetchall() == [(None, None)]
    assert conn.execute("SELECT name FROM sqlite_master WHERE name='notification_settings'").fetchone() is not None
    conn.close()
