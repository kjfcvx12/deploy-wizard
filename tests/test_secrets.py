import pytest

from shared.secrets import encrypt_secret, decrypt_secret, secret_rotate, secret_is_encrypted, blind_index, Secret_Error
from shared import secrets as secrets_module


# 암호화한 값은 원문을 그대로 복원한다
def test_secrets_roundtrip():
    token=encrypt_secret("my-external-id")

    assert token != "my-external-id"
    assert decrypt_secret(token) == "my-external-id"


# 키가 바뀌면 복호화가 명확한 한국어 에러로 끝난다
def test_secrets_decrypt_wrong_key(monkeypatch):
    token=encrypt_secret("my-external-id")

    monkeypatch.setattr(secrets_module.settings, "secret_key", "kX8nQvT2ZbA5wP1sJhY7mR3cL9dF6uE0gN4iB2oV8xk=")

    with pytest.raises(Secret_Error):
        decrypt_secret(token)


# SECRET_KEY가 없으면 즉시 알 수 있게 실패한다
def test_secrets_missing_key(monkeypatch):
    monkeypatch.setattr(secrets_module.settings, "secret_key", None)

    with pytest.raises(Secret_Error):
        encrypt_secret("x")


# 키를 돌려도 옛 키로 암호화한 값을 읽고, 회전하면 새 키만으로 읽힌다
def test_secret_rotation_reads_old_key(monkeypatch):
    key_a="kX8nQvT2ZbA5wP1sJhY7mR3cL9dF6uE0gN4iB2oV8xk="
    key_b="beHhcE1V0jAvZWL3WoF7jmPUJgEMzSGZXGDt7_O_X5w="

    monkeypatch.setattr(secrets_module.settings, "secret_key", key_a)
    monkeypatch.setattr(secrets_module.settings, "secret_keys_old", None)
    token=encrypt_secret("owner@example.com")

    monkeypatch.setattr(secrets_module.settings, "secret_key", key_b)
    monkeypatch.setattr(secrets_module.settings, "secret_keys_old", key_a)
    assert decrypt_secret(token) == "owner@example.com"

    rotated=secret_rotate(token)
    assert rotated != token

    monkeypatch.setattr(secrets_module.settings, "secret_keys_old", None)
    assert decrypt_secret(rotated) == "owner@example.com"

    with pytest.raises(Secret_Error) as exc:
        decrypt_secret(token)
    assert "SECRET_KEY" in str(exc.value)

    with pytest.raises(Secret_Error):
        secret_rotate(token)


# 블라인드 인덱스는 정규화되어 안정적이고, 종류·키가 다르면 값이 다르다
def test_blind_index_stable_and_normalized(monkeypatch):
    monkeypatch.setattr(secrets_module.settings, "blind_index_key", "blind-key-for-tests-only")

    first=blind_index("email", " Me@Example.com ")
    assert first == blind_index("email", "me@example.com")
    assert len(first) == 64
    assert first != blind_index("other", "me@example.com")
    assert blind_index("other", "Me@Example.com") != blind_index("other", "me@example.com")

    monkeypatch.setattr(secrets_module.settings, "blind_index_key", "another-blind-key")
    assert blind_index("email", "me@example.com") != first

    monkeypatch.setattr(secrets_module.settings, "blind_index_key", None)
    with pytest.raises(Secret_Error) as exc:
        blind_index("email", "me@example.com")
    assert "BLIND_INDEX_KEY" in str(exc.value)


# 암호화 열은 ORM 에서는 평문, 저장된 원본(raw SQL·파일 바이트)에서는 암호문이다
def test_encrypted_text_roundtrip_and_raw_bytes(tmp_path):
    from sqlalchemy import Column, Integer, MetaData, Table, create_engine, select, text
    from shared.crypto_types import Encrypted_Text

    db_path=tmp_path / "enc.db"
    engine=create_engine(f"sqlite:///{db_path.as_posix()}")
    table=Table("samples", MetaData(), Column("id", Integer, primary_key=True), Column("email", Encrypted_Text))
    table.metadata.create_all(engine)

    with engine.begin() as conn:
        conn.execute(table.insert().values(id=1, email="owner@example.com"))
        conn.execute(table.insert().values(id=2, email=None))

    with engine.connect() as conn:
        rows=dict(conn.execute(select(table.c.id, table.c.email)).all())
        raw=conn.execute(text("SELECT email FROM samples WHERE id = 1")).scalar()

    engine.dispose()

    assert rows == {1: "owner@example.com", 2: None}
    assert raw.startswith("gAAAAA")
    assert b"owner@example.com" not in db_path.read_bytes()


# 암호문인지 아닌지 예외 없이 판별한다
def test_secret_is_encrypted():
    assert secret_is_encrypted(encrypt_secret("hello")) is True
    assert secret_is_encrypted("arn:aws:iam::123456789012:role/x") is False
