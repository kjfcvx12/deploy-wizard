import hmac
import hashlib
import json
import types
import asyncio
import contextlib
import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import AsyncClient, ASGITransport

from shared.database import Base, async_engine, AsyncSessionLocal

from features.deploys.crud import Deploy_Crud
from features.watches.services import Watch_Service
from features.watches import services as watches_module

# 코드 변경 감지 - 폴링 + 웹훅 (M6)

# 이 파일은 asyncio.Task(디바운스 타이머)를 실제로 띄운다 - 테스트마다 새 이벤트 루프를 쓰면
# 공유 async_engine의 커넥션 풀이 다른 루프에 묶여 "database is locked"가 난다.
# 파일 전체가 이벤트 루프 하나를 공유하게 한다 (실제 서버도 루프 하나로 계속 도는 것과 같은 모양)
pytestmark=pytest.mark.asyncio(loop_scope="module")


def sign(secret:str, body:bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


# debounce_tasks는 클래스 변수라 테스트 사이에 남으면 다음 테스트의 이벤트 루프가 닫힐 때 죽는다 - 매번 비운다
@pytest_asyncio.fixture(autouse=True, loop_scope="module")
async def clear_debounce_tasks():
    Watch_Service.debounce_tasks.clear()
    yield
    tasks=list(Watch_Service.debounce_tasks.values())
    for task in tasks:
        task.cancel()
    for task in tasks:
        with contextlib.suppress(asyncio.CancelledError):
            await task
    Watch_Service.debounce_tasks.clear()


@pytest_asyncio.fixture(loop_scope="module")
async def client():
    from main import app

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def fake_deploy(**overrides):
    base=dict(d_id=1, repo_url="https://github.com/o/r", branch=None, commit_sha="a" * 40,
             auto_redeploy=True, github_installation_id=None)
    base.update(overrides)
    return types.SimpleNamespace(**base)


async def never_called(*_a, **_kw):
    raise AssertionError("불렸으면 안 된다")


# 원격 커밋이 그대로면 아무것도 안 한다
async def test_watch_poll_deploy_no_change(monkeypatch):
    monkeypatch.setattr(watches_module.Repo_Service, "services_repo_commit_sha", staticmethod(lambda url, branch, token: "a" * 40))
    monkeypatch.setattr(watches_module.Deploy_Service, "services_deploy_redeploy", staticmethod(never_called))
    monkeypatch.setattr(watches_module.Deploy_Service, "services_deploy_mark_new_commit", staticmethod(never_called))

    await Watch_Service.services_watch_poll_deploy(fake_deploy(commit_sha="a" * 40))


# 새 커밋 + auto_redeploy 켜짐 -> 다시 배포
async def test_watch_poll_deploy_redeploys_when_auto_redeploy_on(monkeypatch):
    monkeypatch.setattr(watches_module.Repo_Service, "services_repo_commit_sha", staticmethod(lambda url, branch, token: "b" * 40))

    seen=[]
    async def fake_redeploy(db, d_id):
        seen.append(d_id)
    monkeypatch.setattr(watches_module.Deploy_Service, "services_deploy_redeploy", staticmethod(fake_redeploy))

    await Watch_Service.services_watch_poll_deploy(fake_deploy(d_id=7, commit_sha="a" * 40, auto_redeploy=True))

    assert seen == [7]


# 새 커밋 + auto_redeploy 꺼짐 -> 표시만 하고 재배포하지 않는다
async def test_watch_poll_deploy_marks_when_auto_redeploy_off(monkeypatch):
    monkeypatch.setattr(watches_module.Repo_Service, "services_repo_commit_sha", staticmethod(lambda url, branch, token: "b" * 40))
    monkeypatch.setattr(watches_module.Deploy_Service, "services_deploy_redeploy", staticmethod(never_called))

    seen=[]
    async def fake_mark(db, d_id, commit_sha):
        seen.append((d_id, commit_sha))
    monkeypatch.setattr(watches_module.Deploy_Service, "services_deploy_mark_new_commit", staticmethod(fake_mark))

    await Watch_Service.services_watch_poll_deploy(fake_deploy(d_id=8, commit_sha="a" * 40, auto_redeploy=False))

    assert seen == [(8, "b" * 40)]


# GitHub 연결이 있으면 그 설치 토큰으로 원격 커밋을 조회한다
async def test_watch_poll_deploy_uses_github_token(monkeypatch):
    seen_tokens=[]
    async def fake_token(db, g_id):
        return "ghs_xyz"
    def fake_commit_sha(url, branch, token):
        seen_tokens.append(token)
        return "a" * 40  # 변화 없음으로 처리해 재배포까지는 안 가도록

    monkeypatch.setattr(watches_module.Github_Service, "services_github_token_by_g_id", staticmethod(fake_token))
    monkeypatch.setattr(watches_module.Repo_Service, "services_repo_commit_sha", staticmethod(fake_commit_sha))

    await Watch_Service.services_watch_poll_deploy(fake_deploy(github_installation_id=3, commit_sha="a" * 40))

    assert seen_tokens == ["ghs_xyz"]


# 폴링 대상 하나가 실패해도 나머지는 계속 확인한다
async def test_watch_poll_once_continues_on_error(client, monkeypatch):
    d1=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/bad"})).json()["d_id"]
    d2=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/good"})).json()["d_id"]

    async with AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d1, {"status": "running", "commit_sha": "a" * 40})
        await Deploy_Crud.crud_deploy_update(db, d2, {"status": "running", "commit_sha": "a" * 40})
        await db.commit()

    def fake_commit_sha(url, branch, token):
        if "bad" in url:
            raise RuntimeError("네트워크 오류")
        return "a" * 40  # 저장된 값과 같음 - 변화 없음, 재배포로 안 이어진다

    monkeypatch.setattr(watches_module.Repo_Service, "services_repo_commit_sha", staticmethod(fake_commit_sha))

    checked=await Watch_Service.services_watch_poll_once()

    assert checked == 1


# --- 웹훅 ---

def push_payload(repo_url="https://github.com/o/r", branch="main", commit_sha="b" * 40, default_branch="main"):
    return json.dumps({
        "ref": f"refs/heads/{branch}",
        "after": commit_sha,
        "repository": {"html_url": repo_url, "default_branch": default_branch},
    }).encode()


# 서명이 맞으면 통과, 시크릿 없으면(기본 테스트 환경) 있는 서명도 거부 - fail closed
async def test_watch_verify_signature(monkeypatch):
    body=push_payload()

    with pytest.raises(HTTPException):
        Watch_Service.services_watch_verify_signature(body, sign("some-secret", body))

    monkeypatch.setattr(watches_module.settings, "github_webhook_secret", "some-secret")
    Watch_Service.services_watch_verify_signature(body, sign("some-secret", body))  # 예외 없이 통과

    with pytest.raises(HTTPException):
        Watch_Service.services_watch_verify_signature(body, sign("wrong-secret", body))

    with pytest.raises(HTTPException):
        Watch_Service.services_watch_verify_signature(body, None)


# push가 아닌 이벤트는 서명만 확인하고 무시한다
async def test_watch_receive_ignores_non_push_event(monkeypatch):
    monkeypatch.setattr(watches_module.settings, "github_webhook_secret", "some-secret")
    body=push_payload()

    ack=await Watch_Service.services_watch_receive(None, body, sign("some-secret", body), "ping")

    assert ack.matched == 0 and ack.debounced == 0


# auto_redeploy 켜진 배포가 매칭되면 디바운스로 예약한다 (바로 재배포하지 않는다)
# 실제 타이머는 test_watch_debounce_* 에서 따로 검증 - 여기서는 "예약했는지"만 스파이로 본다 (진짜 태스크를 안 만든다)
async def test_watch_handle_push_debounces_when_auto_redeploy_on(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r", "branch": "main"})).json()["d_id"]

    scheduled=[]
    monkeypatch.setattr(watches_module.Watch_Service, "services_watch_debounce_schedule", staticmethod(lambda d: scheduled.append(d)))

    async with AsyncSessionLocal() as db:
        ack=await Watch_Service.services_watch_handle_push(db, "https://github.com/o/r", "main", "b" * 40, "main")

    assert ack.matched == 1
    assert ack.debounced == 1
    assert scheduled == [d_id]


# auto_redeploy 꺼진 배포는 표시만 하고 재배포하지 않는다
async def test_watch_handle_push_marks_when_auto_redeploy_off(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r", "branch": "main"})).json()["d_id"]
    async with AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d_id, {"auto_redeploy": False})
        await db.commit()

    async with AsyncSessionLocal() as db:
        ack=await Watch_Service.services_watch_handle_push(db, "https://github.com/o/r", "main", "b" * 40, "main")
        fetched=await Deploy_Crud.crud_deploy_get_by_d_id(db, d_id)

    assert ack.matched == 1
    assert ack.debounced == 0
    assert fetched.watch_commit_sha == "b" * 40


# branch를 지정 안 한 배포(기본 브랜치 추적)는 push의 default_branch와 비교해서 매칭한다
async def test_watch_handle_push_matches_default_branch(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r"})).json()["d_id"]
    monkeypatch.setattr(watches_module.Watch_Service, "services_watch_debounce_schedule", staticmethod(lambda d: None))

    async with AsyncSessionLocal() as db:
        ack=await Watch_Service.services_watch_handle_push(db, "https://github.com/o/r", "main", "b" * 40, "main")

    assert ack.matched == 1
    async with AsyncSessionLocal() as db:
        # dev 브랜치 푸시는 기본 브랜치가 아니라 안 매칭
        ack2=await Watch_Service.services_watch_handle_push(db, "https://github.com/o/r", "dev", "c" * 40, "main")
    assert ack2.matched == 0


# 짧은 시간에 연속 푸시되면 먼저 예약된 디바운스는 취소되고 마지막 것만 남는다
async def test_watch_debounce_collapses_rapid_pushes(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r", "branch": "main"})).json()["d_id"]
    monkeypatch.setattr(watches_module.settings, "watch_debounce_seconds", 3600)

    Watch_Service.services_watch_debounce_schedule(d_id)
    first_task=Watch_Service.debounce_tasks[d_id]

    Watch_Service.services_watch_debounce_schedule(d_id)
    second_task=Watch_Service.debounce_tasks[d_id]

    assert first_task.cancelled() or first_task.cancel()
    assert second_task is not first_task

    # 다음 테스트로 안 넘어가게 여기서 확실히 정리 (autouse 픽스처는 보조)
    second_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await first_task
        await second_task


# 디바운스 시간이 지나면 실제로 다시 배포한다
async def test_watch_debounce_fires_redeploy(client, monkeypatch):
    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r", "branch": "main"})).json()["d_id"]
    async with AsyncSessionLocal() as db:
        await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "running"})
        await db.commit()

    monkeypatch.setattr(watches_module.settings, "watch_debounce_seconds", 0.01)

    seen=[]
    async def fake_redeploy(db, target_id):
        seen.append(target_id)
    monkeypatch.setattr(watches_module.Deploy_Service, "services_deploy_redeploy", staticmethod(fake_redeploy))

    Watch_Service.services_watch_debounce_schedule(d_id)
    await asyncio.sleep(0.1)

    assert seen == [d_id]
    assert d_id not in Watch_Service.debounce_tasks


# 전체 흐름 - 실제 HTTP로 서명까지 맞춰서 웹훅을 보낸다
async def test_watch_webhook_endpoint_end_to_end(client, monkeypatch):
    monkeypatch.setattr(watches_module.settings, "github_webhook_secret", "some-secret")
    monkeypatch.setattr(watches_module.settings, "watch_debounce_seconds", 3600)

    d_id=(await client.post("/api/deploys", json={"repo_url": "https://github.com/o/r", "branch": "main"})).json()["d_id"]

    body=push_payload(branch="main")
    response=await client.post("/api/watches/webhook", content=body, headers={
        "X-Hub-Signature-256": sign("some-secret", body),
        "X-GitHub-Event": "push",
        "Content-Type": "application/json",
    })

    assert response.status_code == 200
    assert response.json() == {"matched": 1, "debounced": 1}

    # 다음 테스트로 안 넘어가게 여기서 확실히 정리 (autouse 픽스처는 보조)
    task=Watch_Service.debounce_tasks.pop(d_id, None)
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def test_watch_webhook_endpoint_rejects_bad_signature(client, monkeypatch):
    monkeypatch.setattr(watches_module.settings, "github_webhook_secret", "some-secret")
    body=push_payload()

    response=await client.post("/api/watches/webhook", content=body, headers={
        "X-Hub-Signature-256": "sha256=deadbeef",
        "X-GitHub-Event": "push",
    })

    assert response.status_code == 401
