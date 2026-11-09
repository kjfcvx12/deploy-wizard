import asyncio
import contextlib
import pytest
import pytest_asyncio
from datetime import datetime, timedelta

from sqlalchemy import select

from shared.database import Base, async_engine, AsyncSessionLocal
from shared.settings import settings

from features.deploys.models import Deploy, Deploy_Release
from features.health.models import Health_Check
from features.health.crud import Health_Crud
from features.health.services import Health_Service
from features.incidents.services import Incident_Service

NOW=datetime(2026, 11, 10, 12, 0, 0)


@pytest_asyncio.fixture
async def db():
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as session:
        yield session


async def make_deploy(db, status='running', endpoint="https://abc.example.com", path='/health') -> int:
    deploy=Deploy(repo_url="https://github.com/o/r", status=status, endpoint=endpoint, health_check_path=path)
    db.add(deploy)
    await db.flush()
    return deploy.d_id


# 주소별로 정해진 결과를 돌려주는 가짜 점검기 - 실제 네트워크를 쓰지 않는다
def fake_checker(results:dict, calls:list|None=None):
    async def checker(url):
        if calls is not None:
            calls.append(url)
        value=results[url]
        if isinstance(value, Exception):
            raise value
        if callable(value):
            return await value()
        return value
    return checker


@pytest.mark.asyncio
async def test_health_check_once_saves_success_and_failure_rows(db):
    ok_id=await make_deploy(db, endpoint="https://ok.example.com")
    bad_id=await make_deploy(db, endpoint="https://bad.example.com/")
    await db.commit()

    calls=[]
    checker=fake_checker({
        "https://ok.example.com/health": (True, 200, 35, None),
        "https://bad.example.com/health": (False, 503, 80, "HTTP 503"),
    }, calls)

    checked=await Health_Service.services_health_check_once(db, now=NOW, checker=checker)

    assert sorted(checked) == sorted([ok_id, bad_id])
    assert sorted(calls) == ["https://bad.example.com/health", "https://ok.example.com/health"]

    ok_row=(await Health_Crud.crud_health_get_recent(db, ok_id))[0]
    assert (ok_row.ok, ok_row.status_code, ok_row.latency_ms, ok_row.detail, ok_row.checked_at) == (True, 200, 35, None, NOW)
    bad_row=(await Health_Crud.crud_health_get_recent(db, bad_id))[0]
    assert (bad_row.ok, bad_row.status_code, bad_row.detail) == (False, 503, "HTTP 503")

    ok_deploy=await db.get(Deploy, ok_id)
    bad_deploy=await db.get(Deploy, bad_id)
    await db.refresh(ok_deploy)
    await db.refresh(bad_deploy)
    assert (ok_deploy.health_state, ok_deploy.last_health_at) == ('healthy', NOW)
    assert (bad_deploy.health_state, bad_deploy.last_health_at) == ('unhealthy', NOW)


@pytest.mark.asyncio
async def test_health_check_once_skips_non_running_and_endpointless(db):
    running=await make_deploy(db)
    await make_deploy(db, status='stopped')
    await make_deploy(db, status='failed')
    await make_deploy(db, status='deleted')
    await make_deploy(db, endpoint=None)
    await db.commit()

    calls=[]
    checked=await Health_Service.services_health_check_once(db, now=NOW, checker=fake_checker({"https://abc.example.com/health": (True, 200, 10, None)}, calls))

    assert checked == [running]
    assert len(calls) == 1
    total=(await db.execute(select(Health_Check))).scalars().all()
    assert len(total) == 1


@pytest.mark.asyncio
async def test_health_check_once_default_path_is_root(db):
    d_id=await make_deploy(db, path=None, endpoint="https://abc.example.com/")
    await db.commit()

    calls=[]
    await Health_Service.services_health_check_once(db, now=NOW, checker=fake_checker({"https://abc.example.com/": (True, 200, 1, None)}, calls))

    assert calls == ["https://abc.example.com/"]
    assert (await Health_Crud.crud_health_get_recent(db, d_id))[0].ok is True


@pytest.mark.asyncio
async def test_health_check_once_raising_and_slow_checkers_do_not_stop_others(db, monkeypatch):
    good=await make_deploy(db, endpoint="https://good.example.com")
    boom=await make_deploy(db, endpoint="https://boom.example.com")
    slow=await make_deploy(db, endpoint="https://slow.example.com")
    await db.commit()

    monkeypatch.setattr(settings, "health_timeout_seconds", 0)

    async def never():
        await asyncio.sleep(30)
        return (True, 200, 1, None)

    checker=fake_checker({
        "https://good.example.com/health": (True, 200, 20, None),
        "https://boom.example.com/health": RuntimeError("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 exploded"),
        "https://slow.example.com/health": never,
    })

    # 느린 점검기는 시간 제한에 걸려 실패로 기록되고, 나머지는 영향이 없다
    checked=await asyncio.wait_for(Health_Service.services_health_check_once(db, now=NOW, checker=checker), timeout=20)

    assert sorted(checked) == sorted([good, boom, slow])
    assert (await Health_Crud.crud_health_get_recent(db, good))[0].ok is True

    boom_row=(await Health_Crud.crud_health_get_recent(db, boom))[0]
    assert boom_row.ok is False
    assert "ghp_" not in (boom_row.detail or "")

    slow_row=(await Health_Crud.crud_health_get_recent(db, slow))[0]
    assert slow_row.ok is False and slow_row.detail


@pytest.mark.asyncio
async def test_health_check_once_calls_incident_hook_and_survives_its_error(db, monkeypatch):
    first=await make_deploy(db, endpoint="https://one.example.com")
    second=await make_deploy(db, endpoint="https://two.example.com")
    await db.commit()

    seen=[]

    async def hook(db_arg, d_id, ok):
        seen.append((d_id, ok))
        if d_id == first:
            raise RuntimeError("hook exploded")

    monkeypatch.setattr(Incident_Service, "services_incident_on_result", staticmethod(hook))

    checker=fake_checker({
        "https://one.example.com/health": (False, 500, 5, "HTTP 500"),
        "https://two.example.com/health": (True, 200, 5, None),
    })
    checked=await Health_Service.services_health_check_once(db, now=NOW, checker=checker)

    assert sorted(checked) == sorted([first, second])
    assert sorted(seen) == sorted([(first, False), (second, True)])
    # 훅이 실패해도 결과는 이미 저장되어 있다
    assert (await Health_Crud.crud_health_get_recent(db, first))[0].ok is False
    assert (await Health_Crud.crud_health_get_recent(db, second))[0].ok is True


@pytest.mark.asyncio
async def test_incident_on_result_stub_is_noop(db):
    assert await Incident_Service.services_incident_on_result(db, 1, True) is None


@pytest.mark.asyncio
async def test_health_state_flips_between_healthy_and_unhealthy(db):
    d_id=await make_deploy(db)
    await db.commit()
    url="https://abc.example.com/health"

    await Health_Service.services_health_check_once(db, now=NOW, checker=fake_checker({url: (False, 502, 9, "HTTP 502")}))
    assert (await db.get(Deploy, d_id)).health_state == 'unhealthy'

    await Health_Service.services_health_check_once(db, now=NOW + timedelta(minutes=1), checker=fake_checker({url: (True, 200, 9, None)}))
    deploy=await db.get(Deploy, d_id)
    assert deploy.health_state == 'healthy'
    assert deploy.last_health_at == NOW + timedelta(minutes=1)


@pytest.mark.asyncio
async def test_health_detail_is_masked_and_truncated(db):
    d_id=await make_deploy(db)
    await db.commit()
    secret="ghp_abcdefghijklmnopqrstuvwxyz0123456789"

    await Health_Service.services_health_check_once(db, now=NOW, checker=fake_checker({
        "https://abc.example.com/health": (False, None, None, f"token={secret} " + "x" * 400),
    }))

    row=(await Health_Crud.crud_health_get_recent(db, d_id))[0]
    assert secret not in row.detail
    assert len(row.detail) <= 255


@pytest.mark.asyncio
async def test_health_success_sets_healthy_since_once_on_current_release(db):
    d_id=await make_deploy(db)
    db.add_all([Deploy_Release(d_id=d_id, commit_sha="a" * 40, image_uri="x/y:1", state='current'),
                Deploy_Release(d_id=d_id, commit_sha="b" * 40, image_uri="x/y:0", state='previous')])
    await db.commit()
    url="https://abc.example.com/health"

    # 실패하는 동안은 채우지 않는다
    await Health_Service.services_health_check_once(db, now=NOW, checker=fake_checker({url: (False, 500, 1, "HTTP 500")}))
    releases=(await db.execute(select(Deploy_Release).order_by(Deploy_Release.d_r_id))).scalars().all()
    assert [r.healthy_since for r in releases] == [None, None]

    await Health_Service.services_health_check_once(db, now=NOW + timedelta(minutes=1), checker=fake_checker({url: (True, 200, 1, None)}))
    await Health_Service.services_health_check_once(db, now=NOW + timedelta(minutes=2), checker=fake_checker({url: (True, 200, 1, None)}))

    releases=(await db.execute(select(Deploy_Release).order_by(Deploy_Release.d_r_id))).scalars().all()
    current=[r for r in releases if r.state == 'current'][0]
    previous=[r for r in releases if r.state == 'previous'][0]
    # 처음 정상 확인된 시각이 그대로 남는다 (덮어쓰지 않는다), previous 는 건드리지 않는다
    assert current.healthy_since == NOW + timedelta(minutes=1)
    assert previous.healthy_since is None


@pytest.mark.asyncio
async def test_health_consecutive_failures_counts_after_last_success(db):
    d_id=await make_deploy(db)
    other=await make_deploy(db)
    for ok in (False, False, True, False, False, False):
        await Health_Crud.crud_health_create(db, d_id, ok)
    await Health_Crud.crud_health_create(db, other, False)
    await db.commit()

    assert await Health_Service.services_health_consecutive_failures(db, d_id) == 3

    await Health_Crud.crud_health_create(db, d_id, True)
    await db.commit()
    assert await Health_Service.services_health_consecutive_failures(db, d_id) == 0

    # 성공이 한 번도 없으면 전부 센다
    assert await Health_Service.services_health_consecutive_failures(db, other) == 1


@pytest.mark.asyncio
async def test_health_history_window_order_and_scope(db):
    d_id=await make_deploy(db)
    other=await make_deploy(db)
    for minutes in (-60 * 30, -60 * 3, -30, -10):
        await Health_Crud.crud_health_create(db, d_id, True, 200, 1, None, checked_at=NOW + timedelta(minutes=minutes))
    await Health_Crud.crud_health_create(db, other, True, 200, 1, None, checked_at=NOW - timedelta(minutes=5))
    await db.commit()

    rows=await Health_Service.services_health_history(db, d_id, 24, now=NOW)

    assert [r.checked_at for r in rows] == [NOW - timedelta(minutes=180), NOW - timedelta(minutes=30), NOW - timedelta(minutes=10)]
    assert all(r.d_id == d_id for r in rows)
    assert len(await Health_Service.services_health_history(db, d_id, 1, now=NOW)) == 2


@pytest.mark.asyncio
async def test_health_history_returns_newest_1440_oldest_first(db):
    d_id=await make_deploy(db)
    db.add_all([Health_Check(d_id=d_id, ok=True, checked_at=NOW - timedelta(seconds=i)) for i in range(1500)])
    await db.commit()

    rows=await Health_Service.services_health_history(db, d_id, 24, now=NOW)

    assert len(rows) == 1440
    assert rows[0].checked_at < rows[-1].checked_at
    assert rows[-1].checked_at == NOW
    assert rows[0].checked_at == NOW - timedelta(seconds=1439)


@pytest.mark.asyncio
async def test_health_prune_deletes_only_old_rows(db):
    d_id=await make_deploy(db)
    await Health_Crud.crud_health_create(db, d_id, True, checked_at=NOW - timedelta(days=8))
    await Health_Crud.crud_health_create(db, d_id, True, checked_at=NOW - timedelta(days=7, minutes=1))
    keep_a=await Health_Crud.crud_health_create(db, d_id, True, checked_at=NOW - timedelta(days=6, hours=23))
    keep_b=await Health_Crud.crud_health_create(db, d_id, False, checked_at=NOW)
    await db.commit()
    keep_ids={keep_a.h_c_id, keep_b.h_c_id}

    deleted=await Health_Service.services_health_prune(db, now=NOW)

    assert deleted == 2
    left={c.h_c_id for c in (await db.execute(select(Health_Check))).scalars().all()}
    assert left == keep_ids


@pytest.mark.asyncio
async def test_health_monitor_start_respects_enabled_flag(monkeypatch):
    started=[]

    async def fake_loop():
        started.append(True)
        await asyncio.sleep(30)

    monkeypatch.setattr(Health_Service, "services_health_monitor_loop", staticmethod(fake_loop))

    monkeypatch.setattr(settings, "health_monitor_enabled", False)
    assert Health_Service.services_health_monitor_start() is None
    await asyncio.sleep(0)
    assert started == []

    monkeypatch.setattr(settings, "health_monitor_enabled", True)
    task=Health_Service.services_health_monitor_start()
    assert task is not None
    await asyncio.sleep(0)
    assert started == [True]

    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_health_monitor_loop_keeps_running_after_a_failed_pass(monkeypatch):
    passes=[]

    async def flaky_once(db, now=None, checker=None):
        passes.append(1)
        if len(passes) == 1:
            raise RuntimeError("one pass failed")
        return []

    monkeypatch.setattr(Health_Service, "services_health_check_once", staticmethod(flaky_once))
    monkeypatch.setattr(settings, "health_interval_seconds", 0)

    task=asyncio.create_task(Health_Service.services_health_monitor_loop())
    for _ in range(200):
        await asyncio.sleep(0.01)
        if len(passes) >= 3:
            break
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task

    assert len(passes) >= 3


@pytest.mark.asyncio
async def test_health_default_checker_rules(monkeypatch):
    import httpx
    from features.health import services as health_module

    seen=[]

    def handler(request):
        seen.append(str(request.url))
        if request.url.path == "/ok":
            return httpx.Response(200, text="SECRET BODY")
        if request.url.path == "/moved":
            return httpx.Response(302, headers={"location": "/ok"})
        if request.url.path == "/offsite":
            return httpx.Response(302, headers={"location": "https://evil.example.net/steal"})
        return httpx.Response(503, text="boom")

    transport=httpx.MockTransport(handler)
    real_client=httpx.AsyncClient
    monkeypatch.setattr(health_module.httpx, "AsyncClient", lambda **kw: real_client(transport=transport, **kw))

    ok, code, latency, detail=await Health_Service.services_health_default_checker("https://svc.example.com/ok")
    assert (ok, code, detail) == (True, 200, None) and latency >= 0

    ok, code, _, detail=await Health_Service.services_health_default_checker("https://svc.example.com/bad")
    assert (ok, code, detail) == (False, 503, "HTTP 503")

    # 같은 호스트 안의 리다이렉트는 따라가고, 다른 호스트로 가는 것은 따라가지 않는다
    ok, code, _, _=await Health_Service.services_health_default_checker("https://svc.example.com/moved")
    assert (ok, code) == (True, 200)

    seen.clear()
    ok, code, _, _=await Health_Service.services_health_default_checker("https://svc.example.com/offsite")
    assert all("evil.example.net" not in u for u in seen)
    assert ok is True and code == 302


@pytest.mark.asyncio
async def test_health_default_checker_connection_error_has_short_masked_detail(monkeypatch):
    import httpx
    from features.health import services as health_module

    def handler(request):
        raise httpx.ConnectError("connect failed token=ghp_abcdefghijklmnopqrstuvwxyz0123456789")

    transport=httpx.MockTransport(handler)
    real_client=httpx.AsyncClient
    monkeypatch.setattr(health_module.httpx, "AsyncClient", lambda **kw: real_client(transport=transport, **kw))

    ok, code, latency, detail=await Health_Service.services_health_default_checker("https://svc.example.com/x")

    assert ok is False and code is None
    assert detail and "ghp_" not in detail and len(detail) <= 200
