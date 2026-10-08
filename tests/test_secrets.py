import pytest

from shared.secrets import encrypt_secret, decrypt_secret, Secret_Error
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
