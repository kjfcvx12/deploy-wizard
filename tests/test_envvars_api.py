import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

from shared.database import Base, async_engine, AsyncSessionLocal

# create_all 이 모든 표를 알도록 모델을 불러 둔다
from features.accounts import models as account_models
from features.envvars import models as envvar_models
from features.deploys.models import Deploy
from features.deploys.crud import Deploy_Crud
from features.deploys.pipeline import Deploy_Pipeline, Deploy_Log_Buffer
from features.envvars.scheme import Env_Found
from features.envvars.services import Env_Service


@pytest_asyncio.fixture
async def client(monkeypatch):
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    # API 테스트에서는 파이프라인을 실제로 돌리지 않는다
    started=[]
    start_steps=[]

    def fake_start(d_id, start_step=None):
        started.append(d_id)
        start_steps.append(start_step)
        return True

    monkeypatch.setattr(Deploy_Pipeline, "pipeline_start", staticmethod(fake_start))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.started=started
        c.start_steps=start_steps
        yield c


# 배포 한 건을 만들고 d_id 를 돌려준다
async def make_deploy(client) -> int:
    response=await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})
    return response.json()["d_id"]


# 배포의 열(상태·service_arn 등)을 직접 바꾼다
async def set_deploy(d_id:int, **update_data):
    async with AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d_id, update_data)
        await db.commit()


# 스캔 결과를 저장한다
async def save_found(d_id:int, *found:Env_Found) -> int:
    async with AsyncSessionLocal() as db:
        return await Env_Service.services_env_save_found(db, d_id, list(found))


# 테스트용 발견 결과를 만든다
def make_found(name:str, required:bool=True, kind:str='unknown') -> Env_Found:
    return Env_Found(name=name, required=required, has_default=not required, kind=kind, source='code', source_hint='app.py:1')


@pytest.mark.asyncio
async def test_env_list_empty_then_after_save_found(client):
    d_id=await make_deploy(client)

    assert (await client.get(f"/api/deploys/{d_id}/env")).json() == []

    assert await save_found(d_id, make_found("B_VAR"), make_found("A_VAR")) == 2

    body=(await client.get(f"/api/deploys/{d_id}/env")).json()
    assert [e["name"] for e in body] == ["A_VAR", "B_VAR"]
    assert body[0]["status"] == "detected"
    assert body[0]["has_value"] is False

    assert (await client.get("/api/deploys/999/env")).status_code == 404


@pytest.mark.asyncio
async def test_env_put_config_value_has_value_true_and_no_value_key(client):
    d_id=await make_deploy(client)
    await save_found(d_id, make_found("LOG_LEVEL", kind='config'))

    response=await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"value": "super-secret-literal"})

    assert response.status_code == 200
    body=response.json()
    assert body["has_value"] is True
    assert body["status"] == "set"
    assert "value" not in body
    assert "super-secret-literal" not in response.text
    assert "super-secret-literal" not in (await client.get(f"/api/deploys/{d_id}/env")).text


@pytest.mark.asyncio
async def test_env_put_secret_kind_returns_501(client):
    d_id=await make_deploy(client)
    await save_found(d_id, make_found("DATABASE_URL", kind='database'))

    response=await client.put(f"/api/deploys/{d_id}/env/DATABASE_URL", json={"value": "postgres://u:pw@h/db"})

    assert response.status_code == 501
    assert response.json()["detail"] == "시크릿 값 저장은 아직 지원하지 않습니다 (사용자 AWS 보안 저장소 검증 후 지원)"
    assert "postgres://" not in response.text
    assert (await client.get(f"/api/deploys/{d_id}/env")).json()[0]["has_value"] is False


@pytest.mark.asyncio
async def test_env_put_unknown_kind_with_value_returns_400(client):
    d_id=await make_deploy(client)
    await save_found(d_id, make_found("MY_THING"))

    response=await client.put(f"/api/deploys/{d_id}/env/MY_THING", json={"value": "x"})

    assert response.status_code == 400
    assert response.json()["detail"] == "종류를 먼저 골라 주세요"

    # 종류를 같이 보내면 통과한다
    response=await client.put(f"/api/deploys/{d_id}/env/MY_THING", json={"value": "x", "kind": "config"})
    assert response.status_code == 200
    assert response.json()["kind"] == "config"
    assert response.json()["has_value"] is True


@pytest.mark.asyncio
async def test_env_put_bad_kind_and_too_long_value_return_400(client):
    d_id=await make_deploy(client)
    await save_found(d_id, make_found("LOG_LEVEL", kind='config'))

    assert (await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"kind": "bogus"})).status_code == 400
    assert (await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"value": "x" * 2001})).status_code == 400


@pytest.mark.asyncio
async def test_env_put_bad_name_returns_400(client):
    d_id=await make_deploy(client)

    for name in ["1ABC", "A-B", "A" * 101]:
        response=await client.put(f"/api/deploys/{d_id}/env/{name}", json={"kind": "config"})
        assert response.status_code == 400
        assert response.json()["detail"] == "환경변수 이름이 올바르지 않습니다"


@pytest.mark.asyncio
async def test_env_put_new_name_source_user(client):
    d_id=await make_deploy(client)

    response=await client.put(f"/api/deploys/{d_id}/env/MY_FLAG", json={"kind": "config", "value": "on"})

    assert response.status_code == 200
    body=response.json()
    assert body["source"] == "user"
    assert body["required"] is True
    assert body["has_value"] is True


@pytest.mark.asyncio
async def test_env_put_skip(client):
    d_id=await make_deploy(client)
    await save_found(d_id, make_found("OPTIONAL_THING"))

    response=await client.put(f"/api/deploys/{d_id}/env/OPTIONAL_THING", json={"skip": True})

    assert response.status_code == 200
    assert response.json()["status"] == "skipped"
    assert response.json()["has_value"] is False


@pytest.mark.asyncio
async def test_env_delete_value_clears(client):
    d_id=await make_deploy(client)
    await save_found(d_id, make_found("LOG_LEVEL", kind='config'))
    await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"value": "debug"})

    response=await client.delete(f"/api/deploys/{d_id}/env/LOG_LEVEL/value")

    assert response.status_code == 200
    assert response.json()["has_value"] is False
    assert response.json()["status"] == "detected"

    assert (await client.delete(f"/api/deploys/{d_id}/env/NOPE/value")).status_code == 404


@pytest.mark.asyncio
async def test_env_needs_redeploy_only_when_service_is_up(client):
    d_id=await make_deploy(client)
    await save_found(d_id, make_found("LOG_LEVEL", kind='config'))

    assert (await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"value": "a"})).json()["needs_redeploy"] is False

    await set_deploy(d_id, status='running', service_arn="arn:aws:ecs:x")

    assert (await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"value": "b"})).json()["needs_redeploy"] is True
    assert (await client.delete(f"/api/deploys/{d_id}/env/LOG_LEVEL/value")).json()["needs_redeploy"] is True


@pytest.mark.asyncio
async def test_env_runtime_dict_only_set_plain(client):
    d_id=await make_deploy(client)
    await save_found(d_id, make_found("LOG_LEVEL", kind='config'), make_found("APP_NAME", kind='config'),
                     make_found("SKIPPED_ONE", kind='config'), make_found("NO_VALUE"))
    await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"value": "debug"})
    await client.put(f"/api/deploys/{d_id}/env/APP_NAME", json={"value": "demo"})
    await client.delete(f"/api/deploys/{d_id}/env/APP_NAME/value")
    await client.put(f"/api/deploys/{d_id}/env/SKIPPED_ONE", json={"skip": True})

    async with AsyncSessionLocal() as db:
        runtime=await Env_Service.services_env_runtime_dict(db, d_id)

    assert runtime == {"LOG_LEVEL": "debug"}


@pytest.mark.asyncio
async def test_env_continue_409_when_not_needs_input(client):
    d_id=await make_deploy(client)

    response=await client.post(f"/api/deploys/{d_id}/env/continue")

    assert response.status_code == 409
    assert response.json()["detail"] == "입력이 필요한 상태의 배포만 이어서 배포할 수 있습니다"
    assert client.start_steps == [None]  # 생성 때 한 번뿐


@pytest.mark.asyncio
async def test_env_continue_409_lists_missing_names(client):
    d_id=await make_deploy(client)
    await set_deploy(d_id, status='needs_input')
    await save_found(d_id, make_found("B_NEEDED"), make_found("A_NEEDED"), make_found("OPT", required=False))
    await client.put(f"/api/deploys/{d_id}/env/B_NEEDED", json={"kind": "config", "value": "hidden-value"})

    response=await client.post(f"/api/deploys/{d_id}/env/continue")

    assert response.status_code == 409
    assert response.json()["detail"] == "필수 환경변수에 값이 없습니다 :A_NEEDED"
    assert "hidden-value" not in response.text
    assert len(client.start_steps) == 1


@pytest.mark.asyncio
async def test_env_continue_starts_pipeline_at_deploying(client):
    d_id=await make_deploy(client)
    await set_deploy(d_id, status='needs_input')
    await save_found(d_id, make_found("LOG_LEVEL", kind='config'))
    await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"value": "debug"})

    response=await client.post(f"/api/deploys/{d_id}/env/continue")

    assert response.status_code == 200
    assert response.json()["status"] == "queued"
    assert response.json()["env_pending"] == 0
    assert client.start_steps == [None, 'deploying']
    assert client.started == [d_id, d_id]


@pytest.mark.asyncio
async def test_deploy_get_includes_env_pending(client):
    d_id=await make_deploy(client)
    other=await make_deploy(client)

    assert (await client.get(f"/api/deploys/{d_id}")).json()["env_pending"] == 0

    await save_found(d_id, make_found("A_VAR"), make_found("B_VAR"), make_found("OPT", required=False))

    assert (await client.get(f"/api/deploys/{d_id}")).json()["env_pending"] == 2

    listing={d["d_id"]: d["env_pending"] for d in (await client.get("/api/deploys")).json()}
    assert listing == {d_id: 2, other: 0}


# 일반 값이 저장된 뒤 시크릿 종류로 바꾸면 그 값은 남기지 않는다
@pytest.mark.asyncio
async def test_env_put_kind_to_secret_drops_stored_plain_value(client):
    d_id=await make_deploy(client)
    await save_found(d_id, make_found("API_TOKEN", kind='config'))
    await client.put(f"/api/deploys/{d_id}/env/API_TOKEN", json={"value": "tok-123"})

    response=await client.put(f"/api/deploys/{d_id}/env/API_TOKEN", json={"kind": "secret"})

    assert response.status_code == 200
    assert response.json()["has_value"] is False
    assert response.json()["status"] == "detected"

    async with AsyncSessionLocal() as db:
        assert await Env_Service.services_env_runtime_dict(db, d_id) == {}


# 에러 글에서 환경변수 이름만 뽑는다 - 규칙에 맞는 대문자 이름만, 중복 없이, 10개까지
@pytest.mark.parametrize("text,expected", [
    ("Traceback...\nKeyError: 'DATABASE_URL'", ['DATABASE_URL']),
    ("Error: Missing required environment variable STRIPE_KEY", ['STRIPE_KEY']),
    ("ReferenceError: API_BASE is not defined", ['API_BASE']),
    ("ReferenceError: x is not defined", []),
    ("KeyError: 'db_url'", []),
    ("KeyError: 'AB'", []),
    ("KeyError: 'FOO_URL'\nKeyError: 'FOO_URL'\nBAR_KEY is not defined", ['FOO_URL', 'BAR_KEY']),
    ("\n".join(f"KeyError: 'VAR_{i:02d}'" for i in range(12)), [f"VAR_{i:02d}" for i in range(10)]),
])
def test_env_names_from_error(text, expected):
    assert Env_Service.services_env_names_from_error(text) == expected


# 실패한 배포의 에러 글에 있는 변수 이름은 runtime_error 로 저장된다 (값은 없다)
@pytest.mark.asyncio
async def test_pipeline_fail_records_runtime_error_names(client):
    d_id=await make_deploy(client)

    await Deploy_Pipeline.pipeline_fail(d_id, Deploy_Log_Buffer(d_id), Exception("KeyError: 'FOO_URL'"))

    rows=(await client.get(f"/api/deploys/{d_id}/env")).json()
    assert [(r["name"], r["source"], r["required"], r["kind"], r["status"], r["has_value"]) for r in rows] == [
        ("FOO_URL", "runtime_error", True, "unknown", "detected", False)]


# 이미 값이 입력된 변수는 실패 해설이 다시 와도 값과 상태를 잃지 않는다
@pytest.mark.asyncio
async def test_pipeline_fail_keeps_existing_env_value(client):
    d_id=await make_deploy(client)
    await save_found(d_id, make_found("FOO_URL", kind='config'))
    await client.put(f"/api/deploys/{d_id}/env/FOO_URL", json={"value": "http://x"})

    await Deploy_Pipeline.pipeline_fail(d_id, Deploy_Log_Buffer(d_id), Exception("KeyError: 'FOO_URL'"))

    row=(await client.get(f"/api/deploys/{d_id}/env")).json()[0]
    assert (row["status"], row["kind"], row["has_value"]) == ("set", "config", True)


# 환경변수 저장이 깨져도 실패 처리는 끝까지 간다
@pytest.mark.asyncio
async def test_pipeline_fail_survives_env_hook_error(client, monkeypatch):
    d_id=await make_deploy(client)

    async def boom(*_a, **_kw):
        raise RuntimeError("db down")

    monkeypatch.setattr(Env_Service, "services_env_save_found", staticmethod(boom))

    await Deploy_Pipeline.pipeline_fail(d_id, Deploy_Log_Buffer(d_id), Exception("KeyError: 'FOO_URL'"))

    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "failed"


# 이전 작업이 아직 정리 중이라 시작하지 못하면 needs_input 으로 되돌리고 409 - 다시 누르면 이어진다
@pytest.mark.asyncio
async def test_env_continue_start_refused_rolls_back_to_needs_input(client, monkeypatch):
    d_id=await make_deploy(client)
    await set_deploy(d_id, status='needs_input')
    await save_found(d_id, make_found("LOG_LEVEL", kind='config'))
    await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"value": "debug"})
    results=[False]
    calls=[]

    def fake_start(d, start_step=None):
        calls.append(start_step)
        return results[0]

    monkeypatch.setattr(Deploy_Pipeline, "pipeline_start", staticmethod(fake_start))

    response=await client.post(f"/api/deploys/{d_id}/env/continue")

    assert response.status_code == 409
    assert response.json()["detail"] == "잠시 후 다시 눌러 주세요 (이전 작업을 정리하는 중입니다)"
    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "needs_input"
    assert calls == ['deploying']

    results[0]=True
    again=await client.post(f"/api/deploys/{d_id}/env/continue")

    assert again.status_code == 200
    assert again.json()["status"] == "queued"
    assert calls == ['deploying', 'deploying']


# 건너뛰기·건너뛰기 취소가 컨테이너에 들어가는 값을 바꾸면 다시 배포가 필요하다
@pytest.mark.asyncio
async def test_env_needs_redeploy_when_skip_flips_injected_value(client):
    d_id=await make_deploy(client)
    await save_found(d_id, make_found("LOG_LEVEL", kind='config'), make_found("EMPTY_ONE", kind='config'))
    await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"value": "debug"})
    await set_deploy(d_id, status='running', service_arn="arn:aws:ecs:x")

    skipped=await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"skip": True})
    assert skipped.json()["status"] == "skipped"
    assert skipped.json()["needs_redeploy"] is True

    restored=await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"skip": False})
    assert restored.json()["status"] == "set"
    assert restored.json()["needs_redeploy"] is True

    # 저장된 값이 없던 변수의 건너뛰기는 컨테이너에 영향이 없다
    empty=await client.put(f"/api/deploys/{d_id}/env/EMPTY_ONE", json={"skip": True})
    assert empty.json()["needs_redeploy"] is False
    unskipped=await client.put(f"/api/deploys/{d_id}/env/EMPTY_ONE", json={"skip": False})
    assert unskipped.json()["needs_redeploy"] is False


# 서비스가 아직 없으면 건너뛰어도 다시 배포는 필요 없다
@pytest.mark.asyncio
async def test_env_skip_flip_without_service_needs_no_redeploy(client):
    d_id=await make_deploy(client)
    await save_found(d_id, make_found("LOG_LEVEL", kind='config'))
    await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"value": "debug"})

    response=await client.put(f"/api/deploys/{d_id}/env/LOG_LEVEL", json={"skip": True})

    assert response.json()["needs_redeploy"] is False


# 환경변수 이름 기록이 깨지면 경고 한 줄(예외 종류만)을 남기고 실패 처리는 계속된다
@pytest.mark.asyncio
async def test_pipeline_fail_env_hook_error_logs_warn_without_message(client, monkeypatch):
    d_id=await make_deploy(client)

    async def boom(*_a, **_kw):
        raise RuntimeError("db down password=hunter2")

    monkeypatch.setattr(Env_Service, "services_env_save_found", staticmethod(boom))
    buffer=Deploy_Log_Buffer(d_id)

    await Deploy_Pipeline.pipeline_fail(d_id, buffer, Exception("KeyError: 'FOO_URL'"))
    await buffer.buffer_flush()

    assert (await client.get(f"/api/deploys/{d_id}")).json()["status"] == "failed"
    async with AsyncSessionLocal() as db:
        logs=await Deploy_Crud.crud_deploy_log_get_after(db, d_id, 0)
    warns=[l.message for l in logs if l.level == "warn"]
    assert warns == ["환경변수 이름 기록을 건너뜁니다 (RuntimeError)"]
    assert not any("hunter2" in l.message or "db down" in l.message for l in logs)
