import os
import json

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

from shared.database import Base, async_engine
from shared.settings import settings

from features.advice.services import Advice_Service
from features.advice import services as advice_module
from features.envvars.scheme import Env_Found
from features.envvars.services import Env_Service
from features.repos.services import Repo_Service


# 레포 하나를 tmp_path 에 만든다 - 파일 이름과 내용 묶음
def make_repo(tmp_path, files:dict[str, str]):
    for name, content in files.items():
        path=tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    return tmp_path


# 분석 한 번 - 판별, 신호, 조립까지
def advise(tmp_path, envs=None, commit_sha="abc1234"):
    detect=Repo_Service.services_repo_detect(tmp_path)
    app_path=tmp_path if detect.app_dir == "." else tmp_path / detect.app_dir
    envs=envs or []
    signals=Advice_Service.services_advice_signals(app_path, detect, envs)
    return Advice_Service.services_advice_build(signals, detect, envs, commit_sha)


def need_kinds(advice):
    return {n.kind: n for n in advice.needs}


def test_tier_large_for_heavy_libs(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "flask==3.0\ntorch==2.2\n", "app.py": "print(1)\n"})

    advice=advise(tmp_path)

    assert advice.tier == "large"
    assert any("torch" in r for r in advice.reasons)


def test_tier_medium_for_db_lib_and_need_database_unsupported(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "flask\npsycopg2-binary>=2.9\n", "app.py": "print(1)\n"})

    advice=advise(tmp_path)

    assert advice.tier == "medium"
    database=need_kinds(advice)["database"]
    assert database.supported is False
    assert database.message == "마법사가 아직 만들어 주지 못합니다"


def test_tier_small_for_plain_flask_high_confidence(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "flask==3.0\n", "app.py": "print(1)\n"})

    advice=advise(tmp_path)

    assert advice.tier == "small"
    assert advice.confidence == "high"
    assert advice.language == "python"
    assert advice.support_level == "official"
    assert advice.commit_sha == "abc1234"
    assert advice.needs == []


def test_tier_medium_for_many_dependencies(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "\n".join(f"pkg{i}" for i in range(41)) + "\n"})

    assert advise(tmp_path).tier == "medium"


def test_node_heavy_and_cache_libs(tmp_path):
    make_repo(tmp_path, {"package.json": json.dumps({"scripts": {"start": "node index.js"},
                                                     "dependencies": {"express": "4", "puppeteer": "22"}})})
    assert advise(tmp_path).tier == "large"

    other=tmp_path / "other"
    other.mkdir()
    make_repo(other, {"package.json": json.dumps({"scripts": {"start": "node index.js"},
                                                  "dependencies": {"express": "4", "ioredis": "5", "bullmq": "5"}})})
    advice=advise(other)
    assert advice.tier == "medium"
    kinds=need_kinds(advice)
    assert kinds["cache"].supported is False
    assert kinds["worker"].supported is False


def test_static_site_detected_for_vite_build_only(tmp_path):
    make_repo(tmp_path, {"package.json": json.dumps({"scripts": {"build": "vite build", "dev": "vite"},
                                                     "devDependencies": {"vite": "5"},
                                                     "dependencies": {"react": "18"}})})

    advice=advise(tmp_path)

    assert advice.tier == "small"
    assert "static_site" in need_kinds(advice)


def test_node_with_start_script_is_not_static(tmp_path):
    make_repo(tmp_path, {"package.json": json.dumps({"scripts": {"build": "vite build", "start": "node server.js"},
                                                     "devDependencies": {"vite": "5"}})})

    assert "static_site" not in need_kinds(advise(tmp_path))


def test_confidence_low_without_dependency_file(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "flask\n"})
    detect=Repo_Service.services_repo_detect(tmp_path)
    (tmp_path / "requirements.txt").unlink()

    signals=Advice_Service.services_advice_signals(tmp_path, detect, [])
    advice=Advice_Service.services_advice_build(signals, detect, [], "abc1234")

    assert advice.confidence == "low"


def test_confidence_medium_for_experimental_language(tmp_path):
    make_repo(tmp_path, {"go.mod": "module example.com/x\n\ngo 1.22\n"})

    advice=advise(tmp_path)

    assert advice.support_level == "experimental"
    assert advice.confidence == "medium"


def test_unknown_env_listed_in_unknowns(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "flask\n"})
    one=[Env_Found(name="MY_THING_URL", required=True, has_default=False, kind="unknown", source="code")]

    advice=advise(tmp_path, envs=one)
    assert advice.unknowns == ["환경변수 MY_THING_URL의 종류를 알 수 없습니다"]
    assert advice.confidence == "medium"

    two=one + [Env_Found(name="OTHER", required=True, has_default=False, kind="unknown", source="code"),
               Env_Found(name="DB_URL", required=True, has_default=False, kind="database", source="code")]
    advice=advise(tmp_path, envs=two)
    assert len(advice.unknowns) == 2
    assert advice.confidence == "low"
    env_need=need_kinds(advice)["env_vars"]
    assert env_need.supported is True
    assert env_need.count == 3


def test_cost_and_resources_are_none(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "torch\n"})

    advice=advise(tmp_path)

    assert advice.cpu is None
    assert advice.memory is None
    assert advice.cost.monthly_min is None
    assert advice.cost.monthly_max is None
    assert advice.cost.basis_date is None
    assert advice.cost.currency == "USD"


def test_disk_write_need(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "flask\n",
                         "app.py": 'with open("out.txt", "w") as f:\n    f.write("x")\n'})

    disk=need_kinds(advise(tmp_path))["disk_write"]
    assert disk.supported is False
    assert disk.message == "디스크에 쓴 파일은 서비스가 다시 시작되면 사라집니다"

    other=tmp_path / "n"
    other.mkdir()
    make_repo(other, {"package.json": json.dumps({"scripts": {"start": "node i.js"}}),
                      "i.js": "const fs=require('fs'); fs.writeFile('a.txt', 'x', () => {});\n"})
    assert "disk_write" in need_kinds(advise(other))


def test_read_only_open_is_not_disk_write(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "flask\n", "app.py": 'open("in.txt")\nopen("b", "r")\n'})

    assert "disk_write" not in need_kinds(advise(tmp_path))


def test_nested_call_and_window_open_are_not_disk_write(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "flask\n",
                         "app.py": 'import os\nopen(os.path.join(BASE, "data.txt"))\n'})
    assert "disk_write" not in need_kinds(advise(tmp_path))

    other=tmp_path / "n"
    other.mkdir()
    make_repo(other, {"package.json": json.dumps({"scripts": {"start": "node i.js"}}),
                      "i.js": 'window.open(u, "_blank");\nconst x=a.open(b, "w");\n'})
    assert "disk_write" not in need_kinds(advise(other))


def test_open_write_modes_are_disk_write(tmp_path):
    for index, line in enumerate(['open(p, "w")', 'open(p, mode="a")', "open(p, 'r+')"]):
        repo=tmp_path / f"r{index}"
        repo.mkdir()
        make_repo(repo, {"requirements.txt": "flask\n", "app.py": line + "\n"})
        assert "disk_write" in need_kinds(advise(repo)), line


def test_write_only_in_test_files_is_not_disk_write(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "flask\n", "app.py": "print(1)\n",
                         "test_x.py": 'open(p, "w")\n', "y_test.py": 'open(p, "w")\n',
                         "z.test.js": "fs.writeFile(a, b, c);\n", "z.spec.js": "fs.writeFileSync(a, b);\n"})

    assert "disk_write" not in need_kinds(advise(tmp_path))


def test_disk_write_scan_ignores_symlinks(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "flask\n", "app.py": "print(1)\n"})
    outside=tmp_path.parent / f"{tmp_path.name}_outside"
    outside.mkdir()
    (outside / "w.py").write_text('open(p, "w")\n', encoding="utf-8")
    try:
        os.symlink(outside, tmp_path / "linked", target_is_directory=True)
        os.symlink(tmp_path / "missing_target.py", tmp_path / "x.py")
        os.symlink(tmp_path, tmp_path / "loop", target_is_directory=True)
    except OSError:
        pytest.skip("심볼릭 링크를 만들 권한이 없다")

    assert "disk_write" not in need_kinds(advise(tmp_path))


def test_disk_write_scan_survives_pathological_python(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "flask\n", "app.py": "print(1)\n",
                         "big.py": "x = " + "+".join(["1"] * 60000) + "\n",
                         "deep.py": "x = " + "-" * 60000 + "1\n"})

    assert "disk_write" not in need_kinds(advise(tmp_path))


def test_disk_write_scan_skips_undecodable_file(tmp_path):
    make_repo(tmp_path, {"requirements.txt": "flask\n", "app.py": "print(1)\n"})
    (tmp_path / "bad.py").write_bytes(b"\xff\xfe" + b"a\x00b\x00c")

    assert "disk_write" not in need_kinds(advise(tmp_path))


# ---- 엔드포인트 ----

@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    Advice_Service.ADVICE_CACHE.clear()

    # AWS 세션을 만들면 테스트가 실패한다 - 이 엔드포인트는 AWS를 부르지 않는다
    def fail_session(*args, **kwargs):
        pytest.fail("advice 가 AWS 세션을 만들었다")

    from shared import aws_session
    monkeypatch.setattr(aws_session, "get_aws_session", fail_session)
    monkeypatch.setattr(aws_session, "get_assumed_session", fail_session)

    calls={"clone": [], "dests": []}

    def fake_sha(repo_url, branch, token=None):
        return "sha_one"

    def fake_clone(repo_url, branch, dest, on_line=None, token=None):
        calls["clone"].append(repo_url)
        calls["dests"].append(dest)
        dest.mkdir(parents=True)
        (dest / "requirements.txt").write_text("flask\n", encoding="utf-8")
        (dest / "app.py").write_text("print(1)\n", encoding="utf-8")
        return "sha_one"

    monkeypatch.setattr(Repo_Service, "services_repo_commit_sha", staticmethod(fake_sha))
    monkeypatch.setattr(Repo_Service, "services_repo_clone", staticmethod(fake_clone))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.calls=calls
        yield c


@pytest.mark.asyncio
async def test_advice_endpoint_creates_no_deploy_and_cleans_temp_dir(client):
    response=await client.post("/api/deploys/advice", json={"repo_url": "https://github.com/o/r"})

    assert response.status_code == 200
    body=response.json()
    assert body["tier"] == "small"
    assert body["cpu"] is None
    assert body["cost"]["monthly_min"] is None
    assert body["commit_sha"] == "sha_one"

    assert (await client.get("/api/deploys")).json() == []
    assert len(client.calls["dests"]) == 1
    dest=client.calls["dests"][0]
    assert dest.parent == settings.work_path
    assert dest.name.startswith("advice_")
    assert not dest.exists()


@pytest.mark.asyncio
async def test_advice_endpoint_cache_hit_skips_clone(client):
    first=await client.post("/api/deploys/advice", json={"repo_url": "https://github.com/o/r"})
    second=await client.post("/api/deploys/advice", json={"repo_url": "https://github.com/o/r"})

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert len(client.calls["clone"]) == 1


@pytest.mark.asyncio
async def test_advice_endpoint_bad_url_400(client):
    response=await client.post("/api/deploys/advice", json={"repo_url": "https://evil.com/o/r"})
    assert response.status_code == 400

    response=await client.post("/api/deploys/advice", json={"repo_url": "https://github.com/o/r", "branch": "--upload-pack=x"})
    assert response.status_code == 400

    assert client.calls["clone"] == []


@pytest.mark.asyncio
async def test_advice_cleans_temp_dir_when_analysis_raises(client, monkeypatch):
    async def boom(app_path):
        raise RuntimeError("분석 중 터짐")

    monkeypatch.setattr(Env_Service, "services_env_analyze", staticmethod(boom))

    response=await client.post("/api/deploys/advice", json={"repo_url": "https://github.com/o/r"})

    assert response.status_code == 500
    assert len(client.calls["dests"]) == 1
    assert not client.calls["dests"][0].exists()
    assert Advice_Service.ADVICE_CACHE == {}


@pytest.mark.asyncio
async def test_advice_cleanup_failure_does_not_mask_result(client, monkeypatch):
    def broken_remove(path):
        raise PermissionError("지우기 실패")

    monkeypatch.setattr(Repo_Service, "services_repo_remove", staticmethod(broken_remove))

    response=await client.post("/api/deploys/advice", json={"repo_url": "https://github.com/o/r"})

    assert response.status_code == 200
    assert response.json()["tier"] == "small"


@pytest.mark.asyncio
async def test_advice_cleanup_failure_keeps_original_400(client, monkeypatch):
    def empty_clone(repo_url, branch, dest, on_line=None, token=None):
        dest.mkdir(parents=True)
        return "sha_one"

    def broken_remove(path):
        raise PermissionError("지우기 실패")

    monkeypatch.setattr(Repo_Service, "services_repo_clone", staticmethod(empty_clone))
    monkeypatch.setattr(Repo_Service, "services_repo_remove", staticmethod(broken_remove))

    response=await client.post("/api/deploys/advice", json={"repo_url": "https://github.com/o/r"})

    assert response.status_code == 400
