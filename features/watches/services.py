import asyncio
import hmac
import hashlib
import json

from fastapi import HTTPException, status

from shared.settings import settings
from shared.database import AsyncSessionLocal

from features.deploys.services import Deploy_Service
from features.repos.services import Repo_Service
from features.accounts.services import Github_Service
from features.watches.scheme import Watch_Ack

# 코드 변경 감지 - 폴링 + 웹훅 (기획서 03장)
# DB 없는 기능 - 감시 상태는 전부 Deploy(watch_commit_sha, watch_checked_at)에 얹혀 있다


class Watch_Service:
    # 디바운스 타이머 - Deploy_Pipeline.tasks 와 같은 패턴, 재시작하면 다음 웹훅·폴링이 다시 잡는다
    debounce_tasks:dict[int, asyncio.Task]={}

    # 떠 있는 배포들의 원격 커밋을 한 번씩 확인 - 하나가 실패해도 나머지는 계속
    @staticmethod
    async def services_watch_poll_once() -> int:
        async with AsyncSessionLocal() as db:
            deploys=await Deploy_Service.services_deploy_get_pollable(db)

        checked=0
        for deploy in deploys:
            try:
                await Watch_Service.services_watch_poll_deploy(deploy)
                checked+=1
            except Exception:
                continue

        return checked


    # 배포 하나의 원격 커밋을 확인 - 바뀌었으면 자동재배포 켜져 있을 때만 다시 배포, 아니면 표시만
    @staticmethod
    async def services_watch_poll_deploy(deploy) -> None:
        token=None
        if deploy.github_installation_id:
            async with AsyncSessionLocal() as db:
                token=await Github_Service.services_github_token_by_g_id(db, deploy.github_installation_id)

        commit_sha=await asyncio.to_thread(Repo_Service.services_repo_commit_sha, deploy.repo_url, deploy.branch, token)

        if not commit_sha or commit_sha == deploy.commit_sha:
            return

        async with AsyncSessionLocal() as db:
            if deploy.auto_redeploy:
                try:
                    await Deploy_Service.services_deploy_redeploy(db, deploy.d_id)
                except Exception:
                    pass  # 이미 진행 중이면 다음 폴링 때 다시 시도
            else:
                await Deploy_Service.services_deploy_mark_new_commit(db, deploy.d_id, commit_sha)


    # 서버가 떠 있는 동안 계속 도는 폴링 루프 - main.py lifespan에서 시작
    @staticmethod
    async def services_watch_poll_loop() -> None:
        while True:
            try:
                await Watch_Service.services_watch_poll_once()
            except Exception:
                pass

            await asyncio.sleep(settings.watch_poll_seconds)


    # 웹훅 서명 검증 - X-Hub-Signature-256 (HMAC-SHA256). 검증 안 하면 누구나 가짜 푸시로 배포를 일으킬 수 있다
    @staticmethod
    def services_watch_verify_signature(raw_body:bytes, signature_header:str|None) -> None:
        if not settings.github_webhook_secret or not signature_header:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="웹훅 서명이 올바르지 않습니다")

        expected="sha256=" + hmac.new(settings.github_webhook_secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()

        if not hmac.compare_digest(expected, signature_header):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="웹훅 서명이 올바르지 않습니다")


    # 웹훅 수신 - 서명 검증 후 push 이벤트만 처리
    @staticmethod
    async def services_watch_receive(db, raw_body:bytes, signature:str|None, event:str|None) -> Watch_Ack:
        Watch_Service.services_watch_verify_signature(raw_body, signature)

        if event != "push":
            return Watch_Ack(matched=0, debounced=0)

        try:
            payload=json.loads(raw_body)
        except Exception:
            return Watch_Ack(matched=0, debounced=0)

        ref=payload.get("ref") or ""
        if not ref.startswith("refs/heads/"):
            return Watch_Ack(matched=0, debounced=0)

        branch=ref.removeprefix("refs/heads/")
        commit_sha=payload.get("after")
        repository=payload.get("repository") or {}
        repo_url=repository.get("html_url")
        default_branch=repository.get("default_branch")

        if not repo_url or not commit_sha:
            return Watch_Ack(matched=0, debounced=0)

        return await Watch_Service.services_watch_handle_push(db, repo_url, branch, commit_sha, default_branch)


    # 매칭되는 배포마다 - 자동재배포 켜져 있으면 디바운스 예약, 꺼져 있으면 표시만
    @staticmethod
    async def services_watch_handle_push(db, repo_url:str, branch:str, commit_sha:str, default_branch:str|None) -> Watch_Ack:
        deploys=await Deploy_Service.services_deploy_get_by_repo_branch(db, repo_url, branch, default_branch)

        debounced=0
        for deploy in deploys:
            if deploy.auto_redeploy:
                Watch_Service.services_watch_debounce_schedule(deploy.d_id)
                debounced+=1
            else:
                await Deploy_Service.services_deploy_mark_new_commit(db, deploy.d_id, commit_sha)

        return Watch_Ack(matched=len(deploys), debounced=debounced)


    # 디바운스 예약 - 짧은 시간에 연속 푸시되면 마지막 것만 배포 (기획서 03장)
    @staticmethod
    def services_watch_debounce_schedule(d_id:int) -> None:
        existing=Watch_Service.debounce_tasks.get(d_id)
        if existing and not existing.done():
            existing.cancel()

        Watch_Service.debounce_tasks[d_id]=asyncio.create_task(Watch_Service.services_watch_debounce_fire(d_id))


    # 디바운스 시간 뒤에 실제로 다시 배포
    @staticmethod
    async def services_watch_debounce_fire(d_id:int) -> None:
        try:
            await asyncio.sleep(settings.watch_debounce_seconds)

            async with AsyncSessionLocal() as db:
                try:
                    deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)
                except HTTPException:
                    return

                if deploy.auto_redeploy and deploy.status == 'running':
                    try:
                        await Deploy_Service.services_deploy_redeploy(db, d_id)
                    except HTTPException:
                        pass  # 이미 진행 중이면 다음 웹훅·폴링이 다시 잡는다

        finally:
            Watch_Service.debounce_tasks.pop(d_id, None)
