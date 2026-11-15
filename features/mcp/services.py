import asyncio
import time
from typing import Awaitable, Callable

from features.mcp.client import Wizard_Client
from features.mcp.guard import (
    UNTRUSTED_NOTICE,
    guard_connection_summary,
    guard_deploy_summary,
    guard_wrap_untrusted,
)

# AWS 리소스가 있거나 곧 생길 상태 (deleting 은 지우는 중이라 아직 남아 있어 센다) - 파이프라인 상태와 테스트로 맞춘다
LIVE_STATUSES=frozenset({
    "queued", "cloning", "analyzing", "generating", "building", "pushing", "deploying", "deleting",
    "running", "needs_input",
})
# wait_for_deploy 가 기다리다 멈추는 상태
TERMINAL_STATUSES=frozenset({"running", "failed", "needs_input", "stopped", "deleted"})

ADVICE_FIELDS=("tier", "confidence", "cpu", "memory", "cost", "reasons", "needs", "unknowns", "language", "support_level", "app_dir")
WAIT_MAX_SECONDS=120
LOG_TAIL_MAX=200


# MCP 읽기 도구 로직 (기획서 5.2) - 첫 인자는 Wizard_Client, 결과는 JSON 으로 내보낼 수 있는 값
class Mcp_Service:

    # 배포 응답을 허용 목록 요약으로 줄이고 오류·해설이 있으면 데이터 안내문을 붙인다
    @staticmethod
    def services_mcp_summary(raw:dict) -> dict:
        summary=guard_deploy_summary(raw)
        if summary.get("error_msg") or raw.get("explain"):
            summary["notice"]=UNTRUSTED_NOTICE
        return summary

    # 저장소를 분석해 추천 사양을 돌려준다 (AWS 리소스는 만들지 않는다)
    @staticmethod
    async def services_mcp_analyze(client:Wizard_Client, repo_url:str, branch:str|None=None) -> dict:
        body={"repo_url":repo_url}
        if branch:
            body["branch"]=branch
        raw=await client.client_request("POST", "/api/deploys/advice", json=body)
        return {name:raw[name] for name in ADVICE_FIELDS if name in raw}

    # 배포 목록 요약
    @staticmethod
    async def services_mcp_list_deploys(client:Wizard_Client) -> list[dict]:
        rows=await client.client_request("GET", "/api/deploys")
        return [Mcp_Service.services_mcp_summary(row) for row in rows]

    # 배포 하나의 요약과 (있으면) 데이터 표시로 감싼 원인 해설
    @staticmethod
    async def services_mcp_get_deploy(client:Wizard_Client, d_id:int) -> dict:
        raw=await client.client_request("GET", f"/api/deploys/{d_id}")
        result=Mcp_Service.services_mcp_summary(raw)
        explain=raw.get("explain")
        if explain:
            lines=[f"요약: {explain.get('summary') or ''}", f"원인: {explain.get('cause') or ''}"]
            lines.extend(f"조치: {action}" for action in explain.get("actions") or [])
            result["explain"]=guard_wrap_untrusted(lines)
        return result

    # 끝 상태가 될 때까지 (최대 120초) 일정 간격으로 다시 보고 마지막 상태를 돌려준다
    @staticmethod
    async def services_mcp_wait(
        client:Wizard_Client,
        d_id:int,
        max_seconds:int=60,
        poll_seconds:float=5,
        sleep:Callable[[float], Awaitable[None]]=asyncio.sleep,
        now:Callable[[], float]=time.monotonic,
    ) -> dict:
        limit=min(max(max_seconds, 1), WAIT_MAX_SECONDS)
        poll=max(poll_seconds, 0.5)
        started=now()
        while True:
            raw=await client.client_request("GET", f"/api/deploys/{d_id}")
            result=Mcp_Service.services_mcp_summary(raw)
            if result["status"] in TERMINAL_STATUSES:
                result["waited_out"]=False
                return result
            remaining=limit - (now() - started)
            if remaining <= 0:
                result["waited_out"]=True
                return result
            await sleep(min(poll, remaining))

    # 마지막 tail 줄(1~200)을 "[단계] 수준 내용" 문자열로 만들어 데이터 표시로 감싼다
    @staticmethod
    async def services_mcp_logs(client:Wizard_Client, d_id:int, tail:int=50) -> dict:
        count=min(max(tail, 1), LOG_TAIL_MAX)
        rows=await client.client_logs_tail(d_id, count)
        return guard_wrap_untrusted([f"[{row.get('step')}] {row.get('level')} {row.get('message')}" for row in rows])

    # 지난 실패 이력 - 단계·시각과 데이터 표시로 감싼 오류 문구
    @staticmethod
    async def services_mcp_issues(client:Wizard_Client, d_id:int) -> list[dict]:
        rows=await client.client_request("GET", f"/api/deploys/{d_id}/issues")
        return [
            {
                "step":row.get("step"),
                "created_at":row.get("created_at"),
                "error_msg":guard_wrap_untrusted([row["error_msg"]] if row.get("error_msg") else []),
            }
            for row in rows
        ]

    # 공개 주소 응답 상태
    @staticmethod
    async def services_mcp_health(client:Wizard_Client, d_id:int) -> dict:
        raw=await client.client_request("GET", f"/api/deploys/{d_id}/health")
        return {name:raw.get(name) for name in ("health", "status_code", "detail")}

    # 블록·연결 요약 목록 (비밀값·역할 ARN·전체 계정 ID 없음)
    @staticmethod
    async def services_mcp_connections(client:Wizard_Client) -> list[dict]:
        rows=await client.client_request("GET", "/api/accounts/connections")
        return [guard_connection_summary(row) for row in rows]
