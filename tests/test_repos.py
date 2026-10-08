import json
import stat
import pytest

from features.repos.services import Repo_Service
from features.repos import services as repos_module


# 주소 검증 - github https 만
@pytest.mark.parametrize("url", [
    "https://github.com/kjfcvx12/middle_project_4",
    "https://github.com/AI-X-16-1/CARD-N.git",
    "https://github.com/owner/repo/",
])
def test_repo_check_url_ok(url):
    assert Repo_Service.services_repo_check_url(url).startswith("https://github.com/")


@pytest.mark.parametrize("url", [
    "http://github.com/owner/repo",
    "https://gitlab.com/owner/repo",
    "https://github.com/owner",
    "https://github.com/owner/repo/tree/main",
    "https://github.com/owner/repo; rm -rf /",
    "--upload-pack=touch /tmp/x",
    "file:///etc/passwd",
])
def test_repo_check_url_reject(url):
    with pytest.raises(ValueError):
        Repo_Service.services_repo_check_url(url)


@pytest.mark.parametrize("branch", ["-x", "a..b", "a b", "x" * 101])
def test_repo_check_branch_reject(branch):
    with pytest.raises(ValueError):
        Repo_Service.services_repo_check_branch(branch)


def test_repo_slug():
    assert Repo_Service.services_repo_slug("https://github.com/kjfcvx12/middle_project_4") == "middle-project-4"
    assert Repo_Service.services_repo_slug("https://github.com/AI-X-16-1/CARD-N.git") == "card-n"


# M6 - GitHub 설치 토큰이 있으면 클론 주소에 심는다
def test_repo_auth_url():
    assert Repo_Service.services_repo_auth_url("https://github.com/o/r", None) == "https://github.com/o/r"
    assert Repo_Service.services_repo_auth_url("https://github.com/o/r", "ghs_xyz") == "https://x-access-token:ghs_xyz@github.com/o/r"


# M6 - 클론이 실제로 토큰 박힌 주소로 git을 부르는지 (원문 주소는 실제 명령에 안 쓰인다)
def test_repo_clone_uses_token_in_url(tmp_path, monkeypatch):
    dest=tmp_path / "d"
    calls=[]

    def fake_proc_run(args, cwd=None, timeout=600, on_line=None, stdin_text=None):
        calls.append(args)
        return "abc1234\n" if args[:2] == ["git", "rev-parse"] else ""

    monkeypatch.setattr(repos_module, "proc_run", fake_proc_run)

    Repo_Service.services_repo_clone("https://github.com/o/r", None, dest, token="ghs_xyz")

    clone_args=calls[0]
    assert "https://x-access-token:ghs_xyz@github.com/o/r" in clone_args
    assert "https://github.com/o/r" not in clone_args

    # 클론 뒤에는 토큰 없는 주소로 되돌린다 - .git/config 에 토큰이 남으면 빌드 때 이미지에 딸려 들어갈 수 있다
    assert calls[1] == ["git", "remote", "set-url", "origin", "https://github.com/o/r"]

    # 토큰 없이 클론하면 되돌릴 것이 없다
    calls.clear()
    Repo_Service.services_repo_clone("https://github.com/o/r", None, dest)
    assert not any(args[:3] == ["git", "remote", "set-url"] for args in calls)


# M6 - 브랜치 목록 조회도 같은 방식으로 토큰을 쓴다 (private 레포 드롭다운)
def test_repo_remote_uses_token(monkeypatch):
    calls=[]

    def fake_proc_run(args, cwd=None, timeout=600, on_line=None, stdin_text=None):
        calls.append(args)
        return "ref: refs/heads/main\tHEAD\n" if "--symref" in args else "abc\trefs/heads/main\n"

    monkeypatch.setattr(repos_module, "proc_run", fake_proc_run)

    Repo_Service.services_repo_remote("https://github.com/o/r", token="ghs_xyz")

    assert all("https://x-access-token:ghs_xyz@github.com/o/r" in c for c in calls)


# Windows에서 git의 읽기 전용 pack 파일 때문에 이전 클론 폴더가 안 지워지고 남는 문제 - 재현 + 수정 확인
def test_repo_clone_removes_stale_readonly_dir(tmp_path, monkeypatch):
    dest=tmp_path / "deploy_1"
    dest.mkdir()
    stale_file=dest / "objects.pack"
    stale_file.write_text("stale")
    stale_file.chmod(stat.S_IREAD)

    def fake_proc_run(args, cwd=None, timeout=600, on_line=None, stdin_text=None):
        if args[:2] == ["git", "rev-parse"]:
            return "abc1234\n"
        return ""

    monkeypatch.setattr(repos_module, "proc_run", fake_proc_run)

    commit=Repo_Service.services_repo_clone("https://github.com/o/r", None, dest)

    assert not stale_file.exists()
    assert commit == "abc1234"


# 루트의 빈 package.json 보다 backend/requirements.txt 가 우선
def test_repo_detect_prefers_real_backend(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({"dependencies": {"axios": "1"}}), encoding="utf-8")
    (tmp_path / "backend").mkdir()
    (tmp_path / "backend" / "requirements.txt").write_text("fastapi\n", encoding="utf-8")
    (tmp_path / "frontend").mkdir()
    (tmp_path / "frontend" / "package.json").write_text(json.dumps({"scripts": {"build": "vite build"}}), encoding="utf-8")
    (tmp_path / "node_modules" / "x").mkdir(parents=True)
    (tmp_path / "node_modules" / "x" / "package.json").write_text("{}", encoding="utf-8")

    detect=Repo_Service.services_repo_detect(tmp_path)

    assert detect.language == "python"
    assert detect.support_level == "official"
    assert detect.app_dir == "backend"
    assert [app.app_dir for app in detect.other_apps] == ["frontend"]


def test_repo_detect_experimental(tmp_path):
    (tmp_path / "go.mod").write_text("module x\n", encoding="utf-8")

    detect=Repo_Service.services_repo_detect(tmp_path)

    assert detect.language == "go"
    assert detect.support_level == "experimental"
    assert detect.app_dir == "."


def test_repo_detect_none(tmp_path):
    (tmp_path / "README.md").write_text("x", encoding="utf-8")

    with pytest.raises(ValueError):
        Repo_Service.services_repo_detect(tmp_path)


def test_repo_detect_existing_dockerfile(tmp_path):
    (tmp_path / "requirements.txt").write_text("flask\n", encoding="utf-8")
    (tmp_path / "Dockerfile").write_text("FROM python:3.12\n", encoding="utf-8")

    assert Repo_Service.services_repo_detect(tmp_path).has_dockerfile is True


# PowerShell pip freeze > requirements.txt 는 UTF-16 이 된다
def test_repo_normalize_utf16_requirements(tmp_path):
    (tmp_path / "requirements.txt").write_bytes("fastapi==0.116.0\r\nuvicorn==0.42.0\r\n".encode("utf-16"))

    notes=Repo_Service.services_repo_normalize(tmp_path)

    assert notes
    assert (tmp_path / "requirements.txt").read_bytes() == b"fastapi==0.116.0\nuvicorn==0.42.0\n"


# .env·키 파일·node_modules 는 LLM에 보내는 요약에 절대 들어가지 않는다
def test_repo_collect_excludes_secrets(tmp_path):
    (tmp_path / "requirements.txt").write_text("fastapi\n", encoding="utf-8")
    (tmp_path / "main.py").write_text("from fastapi import FastAPI\napp = FastAPI()\n", encoding="utf-8")
    (tmp_path / ".env").write_text("SECRET_KEY=abc\n", encoding="utf-8")
    (tmp_path / ".env.production").write_text("DB_PASSWORD=abc\n", encoding="utf-8")
    (tmp_path / "server.pem").write_text("-----BEGIN PRIVATE KEY-----\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / ".git").mkdir()

    detect=Repo_Service.services_repo_detect(tmp_path)
    collect=Repo_Service.services_repo_collect(tmp_path, detect)
    dumped=collect.model_dump_json()

    assert "main.py" in collect.tree
    assert [entry.path for entry in collect.entry_files] == ["main.py"]
    for forbidden in [".env", "server.pem", "node_modules", ".git", "SECRET_KEY", "PRIVATE KEY"]:
        assert forbidden not in dumped
