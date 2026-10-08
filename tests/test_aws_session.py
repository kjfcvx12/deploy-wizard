import json
import pytest
from datetime import datetime, timedelta, timezone

from botocore.exceptions import LoginRefreshRequired, LoginInsufficientPermissions, LoginTokenLoadError
from botocore.utils import generate_login_cache_key

from shared import aws_session as aws_session_module
from shared.aws_session import get_aws_session, get_credential_method, get_profile_region

from features.explains.services import Explain_Service

# aws login 프로파일 - 설정 파일과 토큰 캐시를 임시 폴더에 만들어 읽기만 본다. 네트워크는 타지 않는다

LOGIN_SESSION="arn:aws:iam::123456789012:user/tester"


# 임시 ~/.aws 를 만든다 - logged_in=False 면 프로파일만 있고 토큰은 없다
def make_login_profile(tmp_path, monkeypatch, profile:str|None, logged_in:bool=True, region:str="ap-northeast-2"):
    header="[default]" if profile is None else f"[profile {profile}]"
    config=tmp_path / "config"
    config.write_text(f"{header}\nlogin_session = {LOGIN_SESSION}\nregion = {region}\n", encoding="utf-8")

    cache_dir=tmp_path / "cache"
    cache_dir.mkdir()

    if logged_in:
        expires_at=datetime.now(timezone.utc) + timedelta(hours=1)
        token={
            "accessToken": {
                "accessKeyId": "ASIATESTTESTTESTTEST",
                "secretAccessKey": "test-secret",
                "sessionToken": "test-session-token",
                "accountId": "123456789012",
                "expiresAt": expires_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
            "refreshToken": "test-refresh",
            "dpopKey": "unused",
            "clientId": "arn:aws:signin:::devtools/same-device",
        }
        (cache_dir / f"{generate_login_cache_key(LOGIN_SESSION)}.json").write_text(json.dumps(token), encoding="utf-8")

    monkeypatch.setenv("AWS_CONFIG_FILE", str(config))
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(tmp_path / "credentials"))
    monkeypatch.setenv("AWS_LOGIN_CACHE_DIRECTORY", str(cache_dir))
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    for name in ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_DEFAULT_REGION", "AWS_REGION"]:
        monkeypatch.delenv(name, raising=False)

    monkeypatch.setattr(aws_session_module.settings, "aws_profile", profile)


@pytest.mark.parametrize("profile", [None, "dw-login"])
def test_aws_session_reads_login_profile(tmp_path, monkeypatch, profile):
    make_login_profile(tmp_path, monkeypatch, profile)

    session=get_aws_session()
    creds=session.get_credentials().get_frozen_credentials()

    assert get_credential_method(session) == "login"
    assert creds.access_key == "ASIATESTTESTTESTTEST"
    assert creds.token == "test-session-token"


# 프로파일은 있는데 aws login 을 안 했으면 -> 한국어 안내로 이어진다
def test_aws_session_login_profile_without_token(tmp_path, monkeypatch):
    make_login_profile(tmp_path, monkeypatch, "dw-login", logged_in=False)

    with pytest.raises(LoginTokenLoadError) as e:
        get_aws_session().get_credentials()

    result=Explain_Service.services_explain_by_rule(str(e.value))
    assert result is not None
    assert "aws login" in result.summary


def test_aws_session_no_credentials_method_none(tmp_path, monkeypatch):
    make_login_profile(tmp_path, monkeypatch, None, logged_in=False)
    (tmp_path / "config").write_text("[default]\nregion = ap-northeast-2\n", encoding="utf-8")

    assert get_credential_method(get_aws_session()) is None


def test_aws_session_profile_region(tmp_path, monkeypatch):
    make_login_profile(tmp_path, monkeypatch, "dw-login", region="us-east-1")

    assert get_profile_region() == "us-east-1"


# botocore 가 실제로 내는 문구가 규칙에 걸리는지 - 문구가 바뀌면 여기서 먼저 깨진다
@pytest.mark.parametrize("message, keyword", [
    (str(LoginRefreshRequired()), "aws login"),
    (str(LoginInsufficientPermissions()), "aws login"),
    ('Using the login credential provider requires an additional dependency. You will need to pip install "botocore[crt]" before proceeding.', "패키지"),
    ("The config profile (dw-login) could not be found", "자격증명"),
])
def test_explain_login_errors_by_rule(message, keyword):
    result=Explain_Service.services_explain_by_rule(message)

    assert result is not None
    assert keyword in result.summary
