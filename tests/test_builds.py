import base64
import json
import os

import pytest

import features.builds.services as builds_module
from features.builds.services import Build_Service
from shared.proc import Proc_Error


class Fake_Ecr:
    def get_authorization_token(self):
        token=base64.b64encode(b"AWS:secret-pw").decode()
        return {"authorizationData": [{"authorizationToken": token, "proxyEndpoint": "https://123.dkr.ecr.ap-northeast-2.amazonaws.com"}]}

    def describe_repositories(self, repositoryNames):
        return {"repositories": [{"repositoryUri": "123.dkr.ecr.ap-northeast-2.amazonaws.com/r"}]}


class Fake_Session:
    def client(self, name):
        return Fake_Ecr()


# 전용 설정 폴더를 임시 폴더로 돌리고 docker 호출을 기록한다
@pytest.fixture
def docker_calls(monkeypatch, tmp_path):
    monkeypatch.setattr(builds_module.settings, "docker_auth_dir", str(tmp_path / "docker-auth"))
    monkeypatch.delenv("DOCKER_HOST", raising=False)
    calls=[]

    def fake_proc_run(args, cwd=None, timeout=600, on_line=None, stdin_text=None, env=None):
        calls.append({"args": args, "stdin": stdin_text, "env": env})
        if args[:3] == ["docker", "context", "inspect"]:
            return "npipe:////./pipe/dockerDesktopLinuxEngine"
        return ""

    monkeypatch.setattr(builds_module, "proc_run", fake_proc_run)
    return calls


# 전용 설정 폴더에는 자격 증명 저장소(credsStore)가 없고, 엔진 주소가 넘어간다
def test_build_docker_env_isolates_config_and_keeps_host(docker_calls):
    env=Build_Service.services_build_docker_env()

    config=json.loads((builds_module.settings.docker_auth_path / "config.json").read_text(encoding="utf-8"))
    assert "credsStore" not in config
    assert env["DOCKER_CONFIG"] == str(builds_module.settings.docker_auth_path)
    assert env["DOCKER_HOST"] == "npipe:////./pipe/dockerDesktopLinuxEngine"


# 자격 증명 도우미가 든 폴더는 PATH 에서 빠지고, 나머지 폴더는 그대로다
def test_build_docker_env_drops_credential_helper_dirs(docker_calls, monkeypatch, tmp_path):
    helper_dir=tmp_path / "helpers"
    other_dir=tmp_path / "other"
    helper_dir.mkdir()
    other_dir.mkdir()
    (helper_dir / "docker-credential-wincred.exe").write_text("x")
    monkeypatch.setenv("PATH", os.pathsep.join([str(helper_dir), str(other_dir)]))

    env=Build_Service.services_build_docker_env()

    assert env["PATH"] == str(other_dir)


# DOCKER_HOST 를 이미 정했으면 그 값을 존중한다
def test_build_docker_env_respects_existing_host(docker_calls, monkeypatch):
    monkeypatch.setenv("DOCKER_HOST", "tcp://example:2375")

    env=Build_Service.services_build_docker_env()

    assert env["DOCKER_HOST"] == "tcp://example:2375"
    assert not any(c["args"][:3] == ["docker", "context", "inspect"] for c in docker_calls)


# 푸시는 로그인·태그·푸시 모두 같은 전용 환경으로, 비밀번호는 인자가 아니라 stdin 으로
def test_build_push_uses_isolated_env_and_stdin_password(docker_calls):
    uri=Build_Service.services_build_push(Fake_Session(), "img:1", "r", "v1")

    assert uri.endswith("/r:v1")
    docker_only=[c for c in docker_calls if c["args"][:2] != ["docker", "context"]]
    assert [c["args"][1] for c in docker_only] == ["login", "tag", "push"]
    assert all(c["env"]["DOCKER_CONFIG"] == str(builds_module.settings.docker_auth_path) for c in docker_only)
    assert docker_only[0]["stdin"] == "secret-pw"
    assert all("secret-pw" not in " ".join(c["args"]) for c in docker_calls)


# 로그인이 실패하면 docker 가 남긴 이유가 메시지에 들어간다
def test_build_login_failure_keeps_reason(monkeypatch):
    def fail(args, **kw):
        raise Proc_Error("명령 실패 (exit 1) :docker login --username", "error saving credentials: stub received bad data")

    monkeypatch.setattr(builds_module, "proc_run", fail)

    with pytest.raises(Proc_Error) as info:
        Build_Service.services_build_login(Fake_Session())

    assert "stub received bad data" in str(info.value)
