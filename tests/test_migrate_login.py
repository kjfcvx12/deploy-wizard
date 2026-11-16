import importlib.util
import sqlite3
from datetime import datetime
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import Session

# 모델을 import 해야 Base.metadata 가 암호화 열·u_id 열을 안다
from features.accounts import models as account_models
from features.auth import models as auth_models
from features.deploys import models as deploy_models
from features.envvars import models as envvar_models
from features.health import models as health_models
from features.incidents import models as incident_models
from features.notifications import models as notification_models

from features.accounts.models import Aws_Account, Github_Installation
from features.notifications.models import Push_Device
from shared.database import Base
from shared.secrets import encrypt_secret, blind_index
from shared.settings import settings
from shared.migrate import (migrate_backup, migrate_bootstrap, migrate_encrypted_columns, migrate_plaintext_count,
                            migrate_encrypt_plaintext, migrate_rotate, migrate_assign_owner, migrate_check_startup,
                            migrate_scrub, migrate_connection_owner_mismatch)

# 로그인 이전 시험 - 실제 data/wizard.db 는 절대 열지 않는다. tmp_path 에 옛 모양의 DB 를 만들어 쓴다

ROOT=Path(__file__).resolve().parent.parent
OLD_ROLE_ARN="arn:aws:iam::123456789012:role/old-migrate-role"
OLD_ACCOUNT_ID="123456789012"
OLD_LOGIN="old-migrate-login-name"
OLD_TOKEN="ExponentPushToken[old-migrate-device]"


# 옛 모양의 DB - u_id 없는 deploys·connections·accounts, 평문 role_arn·계정 ID·로그인 이름·기기 토큰, notification_settings id=1
def make_old_db(path:Path) -> Path:
    conn=sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE deploys (d_id INTEGER PRIMARY KEY, repo_url VARCHAR(255) NOT NULL, status VARCHAR(20) NOT NULL,
                              aws_account_id INTEGER, github_installation_id INTEGER);
        CREATE TABLE aws_accounts (a_id INTEGER PRIMARY KEY, label VARCHAR(100) NOT NULL, role_arn TEXT, aws_account_id TEXT,
                                   external_id_encrypted TEXT NOT NULL, region VARCHAR(30), status VARCHAR(20) NOT NULL,
                                   last_verified_at TIMESTAMP, last_error TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE github_installations (g_id INTEGER PRIMARY KEY, installation_id INTEGER NOT NULL UNIQUE, account_login TEXT NOT NULL,
                                           account_type VARCHAR(20), repository_selection VARCHAR(20), status VARCHAR(20) NOT NULL,
                                           suspended_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE connections (c_id INTEGER PRIMARY KEY, label VARCHAR(100) NOT NULL, aws_account_id INTEGER, github_installation_id INTEGER,
                                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE notifications (n_id INTEGER PRIMARY KEY, u_id INTEGER, d_id INTEGER, i_id INTEGER, kind VARCHAR(30) NOT NULL,
                                    channel VARCHAR(10) NOT NULL, title VARCHAR(200) NOT NULL, body TEXT NOT NULL, status VARCHAR(10) NOT NULL,
                                    error TEXT, read_at TIMESTAMP, sent_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE push_devices (p_d_id INTEGER PRIMARY KEY, u_id INTEGER, expo_token VARCHAR(255) NOT NULL UNIQUE, platform VARCHAR(10) NOT NULL,
                                   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE notification_settings (id INTEGER PRIMARY KEY, notify_email BOOLEAN NOT NULL, notify_push BOOLEAN NOT NULL,
                                            kinds TEXT NOT NULL, kinds_version INTEGER);
    """)
    conn.execute("INSERT INTO deploys (repo_url, status, aws_account_id, github_installation_id) VALUES ('https://github.com/o/r', 'running', 1, 1)")
    conn.execute("INSERT INTO aws_accounts (label, role_arn, aws_account_id, external_id_encrypted, status) VALUES ('old', ?, ?, ?, 'verified')",
                 (OLD_ROLE_ARN, OLD_ACCOUNT_ID, encrypt_secret("external-id-value")))
    conn.execute("INSERT INTO github_installations (installation_id, account_login, status) VALUES (777, ?, 'active')", (OLD_LOGIN,))
    conn.execute("INSERT INTO connections (label, aws_account_id, github_installation_id) VALUES ('block', 1, 1)")
    conn.execute("INSERT INTO notifications (kind, channel, title, body, status) VALUES ('deploy_failed', 'inapp', 't', 'b', 'sent')")
    conn.execute("INSERT INTO push_devices (expo_token, platform, created_at) VALUES (?, 'android', '2026-01-01 00:00:00')", (OLD_TOKEN,))
    conn.execute("INSERT INTO notification_settings (id, notify_email, notify_push, kinds) VALUES (1, 1, 1, '[]')")
    conn.commit()
    conn.close()
    return path


def sync_engine(path:Path):
    return create_engine(f"sqlite:///{path.as_posix()}")


# 사용자 한 명을 만든다 (ORM - 개인 정보는 암호화되어 저장된다)
def add_user(engine, email:str, sub:str) -> int:
    with Session(engine) as session:
        user=auth_models.User(google_sub=sub, google_sub_bidx=blind_index("google_sub", sub), email=email, email_bidx=blind_index("email", email))
        session.add(user)
        session.commit()
        return user.u_id


# scripts/*.py 를 모듈로 불러온다 (scripts 는 패키지가 아니다)
def load_script(name:str):
    spec=importlib.util.spec_from_file_location(f"script_{name}", ROOT / "scripts" / f"{name}.py")
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migrate_backup_is_openable(tmp_path):
    db_path=make_old_db(tmp_path / "wizard.db")

    backup=migrate_backup(db_path, tmp_path / "backups", now=datetime(2026, 11, 17, 9, 30, 5))

    assert backup.name == "wizard-20261117-093005.db" and backup.is_file()
    copy=sqlite3.connect(backup)
    original=sqlite3.connect(db_path)
    try:
        assert copy.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        for table in ("deploys", "aws_accounts", "github_installations", "connections", "notifications", "push_devices", "notification_settings"):
            assert copy.execute(f"SELECT COUNT(*) FROM {table}").fetchone() == original.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
    finally:
        copy.close()
        original.close()

    # 같은 초에 또 만들어도 덮어쓰지 않는다
    again=migrate_backup(db_path, tmp_path / "backups", now=datetime(2026, 11, 17, 9, 30, 5))
    assert again != backup and again.is_file()

    with pytest.raises(FileNotFoundError):
        migrate_backup(tmp_path / "none.db", tmp_path / "backups")
    assert not (tmp_path / "none.db").exists()


def test_migrate_encrypted_columns_lists_models():
    columns=set(migrate_encrypted_columns())

    assert {("aws_accounts", "role_arn"), ("aws_accounts", "aws_account_id"), ("github_installations", "account_login"),
            ("push_devices", "expo_token"), ("users", "email"), ("users", "google_sub")} <= columns
    assert ("aws_accounts", "external_id_encrypted") not in columns


def test_migrate_full_flow_on_old_db(tmp_path):
    db_path=make_old_db(tmp_path / "wizard.db")
    engine=sync_engine(db_path)

    with engine.begin() as conn:
        added=migrate_bootstrap(conn)
        assert "deploys.u_id" in added and "connections.u_id" in added and "push_devices.expo_token_bidx" in added

        counts=migrate_plaintext_count(conn)
        assert counts["aws_accounts.role_arn"] == 1 and counts["aws_accounts.aws_account_id"] == 1
        assert counts["github_installations.account_login"] == 1 and counts["push_devices.expo_token"] == 1
        assert sum(counts.values()) == 4

        # 보기만 - 아무것도 바꾸지 않는다
        planned=migrate_encrypt_plaintext(conn, dry_run=True)
        assert planned["aws_accounts.role_arn"] == 1 and planned["push_devices.expo_token_bidx"] == 1
        assert sum(migrate_plaintext_count(conn).values()) == 4
        assert conn.execute(text("SELECT expo_token_bidx FROM push_devices")).scalar() is None

        done=migrate_encrypt_plaintext(conn, dry_run=False)
        assert done["aws_accounts.role_arn"] == 1 and done["github_installations.account_login"] == 1
        assert done["push_devices.expo_token"] == 1 and done["push_devices.expo_token_bidx"] == 1
        assert sum(migrate_plaintext_count(conn).values()) == 0

    engine.dispose()
    migrate_scrub(db_path)

    # ORM 으로 원래 값이 읽힌다
    engine=sync_engine(db_path)
    with Session(engine) as session:
        account=session.get(Aws_Account, 1)
        assert account.role_arn == OLD_ROLE_ARN and account.aws_account_id == OLD_ACCOUNT_ID
        assert session.get(Github_Installation, 1).account_login == OLD_LOGIN
        device=session.get(Push_Device, 1)
        assert device.expo_token == OLD_TOKEN and device.expo_token_bidx == blind_index("expo_token", OLD_TOKEN)

    # 두 번째 encrypt 는 아무것도 하지 않는다 (이중 암호화 없음)
    with engine.begin() as conn:
        before=conn.execute(text("SELECT role_arn FROM aws_accounts")).scalar()
        again=migrate_encrypt_plaintext(conn, dry_run=False)
        assert sum(n for key, n in again.items() if not key.endswith(".skipped")) == 0
        assert conn.execute(text("SELECT role_arn FROM aws_accounts")).scalar() == before
    engine.dispose()

    # 파일 바이트에 원래 값이 없다
    raw=db_path.read_bytes()
    for plain in (OLD_ROLE_ARN, OLD_LOGIN, OLD_TOKEN):
        assert plain.encode("utf-8") not in raw


def test_migrate_push_devices_dedupe_and_unreadable(tmp_path):
    db_path=make_old_db(tmp_path / "wizard.db")
    engine=sync_engine(db_path)
    owner_token="ExponentPushToken[shared-device]"

    with engine.begin() as conn:
        migrate_bootstrap(conn)
        conn.execute(text("INSERT INTO users (u_id, google_sub, google_sub_bidx, email, email_bidx, status) VALUES (7, :s, 'b1', :e, 'b2', 'active')"),
                     {"s": encrypt_secret("sub"), "e": encrypt_secret("e@x")})
        # 옛 줄(평문, 주인 없음)과 새로 등록한 줄(암호문, 주인 있음)이 같은 토큰
        conn.execute(text("INSERT INTO push_devices (expo_token, platform, created_at) VALUES (:t, 'android', '2026-01-02 00:00:00')"), {"t": owner_token})
        conn.execute(text("INSERT INTO push_devices (u_id, expo_token, expo_token_bidx, platform, created_at) VALUES (7, :t, :b, 'android', '2025-12-01 00:00:00')"),
                     {"t": encrypt_secret(owner_token), "b": blind_index("expo_token", owner_token)})
        # 키가 달라 못 읽는 줄 - 지우지도 고치지도 않는다
        conn.execute(text("INSERT INTO push_devices (expo_token, platform) VALUES (:t, 'android')"),
                     {"t": Fernet(Fernet.generate_key()).encrypt(b"other-key-token").decode()})

        result=migrate_encrypt_plaintext(conn, dry_run=False)
        assert result["push_devices.duplicates"] == 1
        assert result["push_devices.skipped"] == 1

        rows=conn.execute(text("SELECT p_d_id, u_id, expo_token_bidx FROM push_devices ORDER BY p_d_id")).all()
        assert len(rows) == 3
        kept=[row for row in rows if row.expo_token_bidx == blind_index("expo_token", owner_token)]
        assert len(kept) == 1 and kept[0].u_id == 7
        assert any(row.expo_token_bidx is None for row in rows)
    engine.dispose()


def test_migrate_assign_owner_only_nulls(tmp_path):
    db_path=make_old_db(tmp_path / "wizard.db")
    engine=sync_engine(db_path)

    with engine.begin() as conn:
        migrate_bootstrap(conn)
        migrate_encrypt_plaintext(conn, dry_run=False)
    owner=add_user(engine, "owner@example.com", "sub-a")
    other=add_user(engine, "other@example.com", "sub-b")

    with engine.begin() as conn:
        # 미리 B 가 주인인 행
        conn.execute(text("INSERT INTO deploys (repo_url, status, u_id) VALUES ('https://github.com/o/b', 'running', :u)"), {"u": other})
        conn.execute(text("INSERT INTO notifications (u_id, kind, channel, title, body, status) VALUES (:u, 'deploy_failed', 'inapp', 't', 'b', 'sent')"), {"u": other})

        planned=migrate_assign_owner(conn, owner, dry_run=True)
        assert planned["deploys"] == 1
        assert conn.execute(text("SELECT COUNT(*) FROM deploys WHERE u_id IS NULL")).scalar() == 1

        done=migrate_assign_owner(conn, owner, dry_run=False)
        for table in ("deploys", "aws_accounts", "github_installations", "connections", "notifications", "push_devices", "notification_settings"):
            assert done[table] == 1, table
            assert conn.execute(text(f"SELECT COUNT(*) FROM {table} WHERE u_id IS NULL")).scalar() == 0, table
        assert "users" not in done and "refresh_tokens" not in done and "api_tokens" not in done
        assert conn.execute(text("SELECT u_id FROM notification_settings WHERE id=1")).scalar() == owner

        # B 의 것은 그대로
        assert conn.execute(text("SELECT COUNT(*) FROM deploys WHERE u_id=:u"), {"u": other}).scalar() == 1
        assert conn.execute(text("SELECT COUNT(*) FROM notifications WHERE u_id=:u"), {"u": other}).scalar() == 1

        # 다시 불러도 바꿀 것이 없다
        assert sum(n for key, n in migrate_assign_owner(conn, owner, dry_run=False).items() if not key.endswith(".skipped")) == 0
        assert migrate_connection_owner_mismatch(conn) == {"aws_accounts": 0, "github_installations": 0}

        # 블록이 남의 계정을 가리키면 보고만 한다
        conn.execute(text("UPDATE aws_accounts SET u_id=:u"), {"u": other})
        assert migrate_connection_owner_mismatch(conn)["aws_accounts"] == 1

        with pytest.raises(ValueError):
            migrate_assign_owner(conn, 999, dry_run=True)
    engine.dispose()


def test_migrate_assign_owner_keeps_existing_setting(tmp_path):
    db_path=make_old_db(tmp_path / "wizard.db")
    engine=sync_engine(db_path)

    with engine.begin() as conn:
        migrate_bootstrap(conn)
        migrate_encrypt_plaintext(conn, dry_run=False)
    owner=add_user(engine, "owner@example.com", "sub-a")

    with engine.begin() as conn:
        # 로그인 뒤 이미 자기 설정 줄이 생겼으면 id=1 줄은 그대로 두고 건너뛴다 (u_id 는 유일)
        conn.execute(text("INSERT INTO notification_settings (id, u_id, notify_email, notify_push, kinds) VALUES (2, :u, 1, 1, '[]')"), {"u": owner})
        done=migrate_assign_owner(conn, owner, dry_run=False)
        assert done["notification_settings"] == 0 and done["notification_settings.skipped"] == 1
        assert conn.execute(text("SELECT u_id FROM notification_settings WHERE id=1")).scalar() is None
    engine.dispose()


def test_migrate_rotate_keys(tmp_path, monkeypatch):
    key_a=Fernet.generate_key().decode()
    key_b=Fernet.generate_key().decode()
    monkeypatch.setattr(settings, "secret_key", key_a)
    monkeypatch.setattr(settings, "secret_keys_old", None)

    db_path=make_old_db(tmp_path / "wizard.db")
    engine=sync_engine(db_path)
    with engine.begin() as conn:
        migrate_bootstrap(conn)
        migrate_encrypt_plaintext(conn, dry_run=False)

    monkeypatch.setattr(settings, "secret_key", key_b)
    monkeypatch.setattr(settings, "secret_keys_old", key_a)
    with engine.begin() as conn:
        planned=migrate_rotate(conn, dry_run=True)
        assert planned["aws_accounts.role_arn"] == 1 and planned["aws_accounts.external_id_encrypted"] == 1
        done=migrate_rotate(conn, dry_run=False)
        assert done["aws_accounts.role_arn"] == 1 and done["github_installations.account_login"] == 1 and done["push_devices.expo_token"] == 1

    # 옛 키 없이도 읽힌다 (external_id 도 새 키로)
    monkeypatch.setattr(settings, "secret_keys_old", None)
    with Session(engine) as session:
        account=session.get(Aws_Account, 1)
        assert account.role_arn == OLD_ROLE_ARN
        from shared.secrets import decrypt_secret
        assert decrypt_secret(account.external_id_encrypted) == "external-id-value"
        assert session.get(Github_Installation, 1).account_login == OLD_LOGIN
    engine.dispose()


def test_startup_refuses_plaintext(tmp_path):
    db_path=make_old_db(tmp_path / "wizard.db")
    engine=sync_engine(db_path)

    with engine.begin() as conn:
        migrate_bootstrap(conn)
        with pytest.raises(RuntimeError) as error:
            migrate_check_startup(conn)
        assert "암호화 전 값이 4건" in str(error.value) and "migrate_login.py backup" in str(error.value)
        assert OLD_ROLE_ARN not in str(error.value)

        migrate_encrypt_plaintext(conn, dry_run=False)
        assert migrate_check_startup(conn) is None
    engine.dispose()

    # 새 DB (표 없음 / 빈 표) 는 통과
    fresh=sync_engine(tmp_path / "fresh.db")
    with fresh.begin() as conn:
        assert migrate_check_startup(conn) is None
        Base.metadata.create_all(conn)
        assert migrate_check_startup(conn) is None
    fresh.dispose()


@pytest.mark.asyncio
async def test_startup_check_through_async_engine(tmp_path):
    engine=create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'fresh.db').as_posix()}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        # main.py lifespan 과 같은 방식
        async with engine.connect() as conn:
            await conn.run_sync(migrate_check_startup)
    finally:
        await engine.dispose()


def test_migrate_script_requires_yes(tmp_path, monkeypatch, capsys):
    script=load_script("migrate_login")
    monkeypatch.setattr(script, "port_in_use", lambda port=8081: False)
    db_path=make_old_db(tmp_path / "wizard.db")
    backups=tmp_path / "backups"
    args=["--db", str(db_path), "--backup-dir", str(backups)]
    original=db_path.read_bytes()

    # 보기만 - 바뀌지 않고 백업도 만들지 않는다
    assert script.main(["encrypt"] + args) == 0
    assert db_path.read_bytes() == original and not backups.exists()
    assert script.main(["status"] + args) == 0
    assert db_path.read_bytes() == original

    # --yes 면 백업부터 만들고 암호화한다
    assert script.main(["encrypt", "--yes"] + args) == 0
    assert len(list(backups.glob("wizard-*.db"))) == 1
    assert OLD_ROLE_ARN.encode() not in db_path.read_bytes()

    # 두 번째 encrypt --yes 는 할 일이 없다 (백업도 더 만들지 않는다)
    assert script.main(["encrypt", "--yes"] + args) == 0
    assert len(list(backups.glob("wizard-*.db"))) == 1

    # 주인 지정 - 없는 이메일이면 먼저 로그인하라고 한다
    assert script.main(["assign-owner", "--email", "nobody@example.com", "--yes"] + args) == 1
    engine=sync_engine(db_path)
    owner=add_user(engine, "Owner@Example.com", "sub-a")
    engine.dispose()

    encrypted=db_path.read_bytes()
    assert script.main(["assign-owner", "--email", "owner@example.com"] + args) == 0
    assert db_path.read_bytes() == encrypted

    assert script.main(["assign-owner", "--email", "owner@example.com", "--yes"] + args) == 0
    check=sqlite3.connect(db_path)
    try:
        assert check.execute("SELECT u_id FROM deploys").fetchone()[0] == owner
    finally:
        check.close()
    assert len(list(backups.glob("wizard-*.db"))) == 2

    # 출력에 값 원문·이메일이 없다
    out=capsys.readouterr().out
    for secret in (OLD_ROLE_ARN, OLD_LOGIN, OLD_TOKEN, "owner@example.com", "nobody@example.com", settings.secret_key):
        assert secret not in out


def test_migrate_script_refuses_while_server_runs(tmp_path, monkeypatch):
    script=load_script("migrate_login")
    db_path=make_old_db(tmp_path / "wizard.db")
    backups=tmp_path / "backups"
    args=["--db", str(db_path), "--backup-dir", str(backups)]
    first=migrate_backup(db_path, backups)
    original=db_path.read_bytes()

    monkeypatch.setattr(script, "port_in_use", lambda port=8081: True)
    assert script.main(["restore", "--from", str(first), "--yes"] + args) == 1
    assert script.main(["encrypt", "--yes"] + args) == 1
    assert script.main(["rotate-keys", "--yes"] + args) == 1
    assert db_path.read_bytes() == original

    # 서버가 꺼져 있으면 되돌린다 - 지금 파일도 먼저 백업한다
    monkeypatch.setattr(script, "port_in_use", lambda port=8081: False)
    assert script.main(["encrypt", "--yes"] + args) == 0
    assert OLD_ROLE_ARN.encode() not in db_path.read_bytes()
    count=len(list(backups.glob("wizard-*.db")))

    assert script.main(["restore", "--from", str(first)] + args) == 0
    assert OLD_ROLE_ARN.encode() not in db_path.read_bytes()

    assert script.main(["restore", "--from", str(first), "--yes"] + args) == 0
    assert len(list(backups.glob("wizard-*.db"))) == count + 1
    check=sqlite3.connect(db_path)
    try:
        assert check.execute("SELECT role_arn FROM aws_accounts").fetchone()[0] == OLD_ROLE_ARN
    finally:
        check.close()


# 이전 전 DB 를 흉내 낸 비동기 엔진 - 연결 계정 하나(평문 role_arn, verified)
async def make_unmigrated_async(tmp_path):
    db_path=tmp_path / "unmigrated.db"
    engine=create_async_engine(f"sqlite+aiosqlite:///{db_path.as_posix()}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(text("INSERT INTO aws_accounts (label, role_arn, external_id_encrypted, status) VALUES ('linked', :r, :e, 'verified')"),
                           {"r": OLD_ROLE_ARN, "e": encrypt_secret("external-id-value")})
    return db_path, engine


@pytest.mark.asyncio
async def test_session_end_warns_on_unmigrated_accounts(tmp_path, monkeypatch, capsys):
    script=load_script("session_end")
    db_path, engine=await make_unmigrated_async(tmp_path)

    async def fake_bootstrap():
        return []

    # 개발 계정은 평소처럼 점검한다
    async def fake_build_session(db, a_id):
        return object()

    def fake_list_managed(session):
        from types import SimpleNamespace
        return [SimpleNamespace(kind="ecs_service", arn="arn:aws:ecs:dev-service", name="dev")]

    monkeypatch.setattr(script, "AsyncSessionLocal", async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False))
    monkeypatch.setattr(script, "bootstrap_schema", fake_bootstrap)
    monkeypatch.setattr(settings, "db_url", f"sqlite+aiosqlite:///{db_path.as_posix()}")
    monkeypatch.setattr(script.Aws_Account_Service, "services_aws_account_build_session", staticmethod(fake_build_session))
    monkeypatch.setattr(script.Express_Service, "services_express_list_managed", staticmethod(fake_list_managed))

    try:
        code=await script.run(dry_run=True, keep_images=False)
    finally:
        await engine.dispose()

    out=capsys.readouterr().out
    assert code != 0
    assert "arn:aws:ecs:dev-service" in out
    # 계정 목록 읽기에서 죽지 않고 못 읽었다고 적는다
    assert "확인 못 함  연결한 AWS 계정 전체" in out
    assert "python scripts/migrate_login.py backup" in out and "encrypt --yes" in out
    assert OLD_ROLE_ARN not in out


def test_cleanup_warns_on_unmigrated_accounts(tmp_path, monkeypatch, capsys):
    script=load_script("cleanup")
    db_path=make_old_db(tmp_path / "wizard.db")

    monkeypatch.setattr(settings, "db_url", f"sqlite+aiosqlite:///{db_path.as_posix()}")
    monkeypatch.setattr(script, "get_aws_session", lambda: object())
    monkeypatch.setattr(script.Express_Service, "services_express_list_managed", staticmethod(lambda session: []))
    monkeypatch.setattr("sys.argv", ["cleanup.py"])
    original=db_path.read_bytes()

    with pytest.raises(SystemExit) as exited:
        script.main()

    out=capsys.readouterr().out
    assert exited.value.code != 0
    assert "python scripts/migrate_login.py backup" in out and "encrypt --yes" in out
    assert OLD_ROLE_ARN not in out
    # 읽기만 한다
    assert db_path.read_bytes() == original
