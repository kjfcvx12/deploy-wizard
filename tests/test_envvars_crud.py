import pytest
import pytest_asyncio

from shared.database import Base, async_engine, AsyncSessionLocal

# Deploy 의 FK 대상 표(aws_accounts 등)도 create_all 이 알아야 한다
from features.accounts import models as account_models
from features.deploys.models import Deploy
from features.envvars.crud import Env_Crud
from features.envvars.scheme import Env_Found


@pytest_asyncio.fixture
async def db():
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as session:
        yield session


# 테스트용 배포 한 건을 넣고 d_id 를 돌려준다
async def make_deploy(db) -> int:
    deploy=Deploy(repo_url="https://github.com/o/r", status='queued')
    db.add(deploy)
    await db.flush()
    return deploy.d_id


# 테스트용 발견 결과를 만든다
def make_found(name:str, required:bool=True, kind:str='unknown') -> Env_Found:
    return Env_Found(name=name, required=required, has_default=not required, kind=kind, source='code', source_hint='app.py:1')


@pytest.mark.asyncio
async def test_env_upsert_inserts_then_updates_not_duplicates(db):
    d_id=await make_deploy(db)

    first=await Env_Crud.crud_env_upsert_found(db, d_id, make_found("DATABASE_URL"))
    second=await Env_Crud.crud_env_upsert_found(db, d_id, make_found("DATABASE_URL", required=False))

    rows=await Env_Crud.crud_env_get_by_d_id(db, d_id)
    assert len(rows) == 1
    assert first.d_e_id == second.d_e_id
    assert rows[0].required is False
    assert rows[0].status == 'detected'
    assert rows[0].storage == 'none'


@pytest.mark.asyncio
async def test_env_upsert_keeps_user_state(db):
    d_id=await make_deploy(db)
    await Env_Crud.crud_env_upsert_found(db, d_id, make_found("APP_MODE"))
    await Env_Crud.crud_env_update(db, d_id, "APP_MODE", {"status": "set", "kind": "config", "storage": "plain", "plain_value": "x"})

    row=await Env_Crud.crud_env_upsert_found(db, d_id, make_found("APP_MODE", kind='unknown'))
    assert (row.status, row.kind, row.storage, row.plain_value) == ("set", "config", "plain", "x")

    # 저장된 kind 가 unknown 일 때만 재스캔이 kind 를 채운다
    await Env_Crud.crud_env_upsert_found(db, d_id, make_found("API_KEY"))
    row=await Env_Crud.crud_env_upsert_found(db, d_id, make_found("API_KEY", kind='external_api'))
    assert row.kind == 'external_api'
    row=await Env_Crud.crud_env_upsert_found(db, d_id, make_found("API_KEY", kind='secret'))
    assert row.kind == 'external_api'


@pytest.mark.asyncio
async def test_env_count_pending_counts_required_detected_only(db):
    d1=await make_deploy(db)
    d2=await make_deploy(db)
    d3=await make_deploy(db)

    for name in ("A", "B", "C", "D", "OPTIONAL"):
        await Env_Crud.crud_env_upsert_found(db, d1, make_found(name, required=(name != "OPTIONAL")))
    await Env_Crud.crud_env_update(db, d1, "B", {"status": "set"})
    await Env_Crud.crud_env_update(db, d1, "C", {"status": "skipped"})
    await Env_Crud.crud_env_upsert_found(db, d2, make_found("X"))

    assert await Env_Crud.crud_env_count_pending(db, d1) == 2
    assert await Env_Crud.crud_env_count_pending(db, d3) == 0
    assert await Env_Crud.crud_env_count_pending_many(db, [d1, d2, d3]) == {d1: 2, d2: 1, d3: 0}
    assert await Env_Crud.crud_env_count_pending_many(db, []) == {}
