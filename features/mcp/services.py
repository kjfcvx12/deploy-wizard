import asyncio
import time
from typing import Awaitable, Callable

from features.mcp.client import Wizard_Client, Wizard_Error
from features.mcp.guard import (
    UNTRUSTED_NOTICE,
    Confirm_Store,
    guard_connection_summary,
    guard_deploy_summary,
    guard_text_clip,
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
TOKEN_ERROR="확인 토큰이 없거나 만료됐거나 이미 썼습니다. 미리보기부터 다시 하세요"
CONFIRM_INSTRUCTION="사용자에게 이 내용을 보여 주고 명시적으로 승인을 받은 뒤에만 같은 도구를 confirm_token과 함께 다시 부르세요"
# 도구 이름 -> (HTTP 메서드, 경로 형식, 하는 일, 경고 문구들)
ACTION_SPECS={
    "redeploy":("POST", "/api/deploys/{d_id}/redeploy", "다시 배포", [
        "새 이미지를 빌드·푸시해 갱신합니다. 끝날 때까지 몇 분 걸리고 그동안 요금은 계속 나옵니다.",
    ]),
    "stop_deploy":("POST", "/api/deploys/{d_id}/stop", "멈춤", [
        "ECS 서비스가 지워져 요금은 멈추지만 다시 켜기에 약 10분 걸리고 주소가 바뀝니다. 이미지와 기록은 남습니다.",
    ]),
    "start_deploy":("POST", "/api/deploys/{d_id}/start", "다시 켜기", [
        "다시 켜면 요금이 다시 나옵니다. 약 10분 걸리고 주소가 바뀔 수 있습니다.",
    ]),
    "delete_deploy":("DELETE", "/api/deploys/{d_id}", "삭제", [
        "ECS 서비스와 ECR 이미지가 지워지고 되돌릴 수 없습니다. 다시 쓰려면 처음부터 배포해야 합니다.",
    ]),
}


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
    async def services_mcp_analyze(client:Wizard_Client, repo_url:str, branch:str|None=None, github_installation_id:int|None=None) -> dict:
        body={"repo_url":repo_url}
        if branch:
            body["branch"]=branch
        if github_installation_id is not None:
            body["github_installation_id"]=github_installation_id
        raw=await client.client_request("POST", "/api/deploys/advice", json=body)
        result={name:raw[name] for name in ADVICE_FIELDS if name in raw}
        has_text=False
        for name in ("reasons", "unknowns"):
            if result.get(name):
                result[name]=[guard_text_clip(item) for item in result[name]]
                has_text=True
        if result.get("needs"):
            needs=[]
            for item in result["needs"]:
                if isinstance(item, dict):
                    item={**item, "message":guard_text_clip(item["message"])} if item.get("message") else item
                else:
                    item=guard_text_clip(item)
                needs.append(item)
            result["needs"]=needs
            has_text=True
        if result.get("app_dir"):
            result["app_dir"]=guard_text_clip(result["app_dir"])
            has_text=True
        if has_text:
            result["notice"]=UNTRUSTED_NOTICE
        return result

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
        return {
            "health":raw.get("health"),
            "status_code":raw.get("status_code"),
            "detail":guard_text_clip(raw["detail"]) if raw.get("detail") else raw.get("detail"),
        }

    # 블록·연결 요약 목록 (비밀값·역할 ARN·전체 계정 ID 없음)
    @staticmethod
    async def services_mcp_connections(client:Wizard_Client) -> list[dict]:
        rows=await client.client_request("GET", "/api/accounts/connections")
        return [guard_connection_summary(row) for row in rows]

    # 요금이 나오는 배포인가 - 진행·실행 상태, 또는 서비스가 남아 있는 실패 (멈춤은 ARN 을 지우고 생성 전 실패는 ARN 이 없다)
    @staticmethod
    def services_mcp_is_live(row:dict) -> bool:
        status=row.get("status")
        return status in LIVE_STATUSES or (status == "failed" and bool(row.get("service_arn")))

    # 살아 있는 배포 수가 한도 이상이면 Wizard_Error
    @staticmethod
    async def services_mcp_live_check(client:Wizard_Client, max_live:int) -> None:
        rows=await client.client_request("GET", "/api/deploys")
        live=sum(1 for row in rows if Mcp_Service.services_mcp_is_live(row))
        if live >= max_live:
            raise Wizard_Error(
                f"살아 있는 배포가 {live}개로 한도({max_live}개)에 이르렀습니다. 요금이 계속 나오므로 "
                "새 배포 전에 다른 배포를 먼저 멈추거나 삭제해 주세요."
            )

    # 블록 번호로 (AWS 계정 행 id, GitHub 설치 행 id, 이름)을 찾는다 - 없거나 AWS 가 확인되지 않았으면 Wizard_Error
    @staticmethod
    async def services_mcp_resolve_connection(client:Wizard_Client, connection_id:int) -> tuple[int, int|None, str]:
        rows=await Mcp_Service.services_mcp_connections(client)
        row=next((item for item in rows if item["c_id"] == connection_id), None)
        if row is None:
            raise Wizard_Error(f"연결 {connection_id}번을 찾을 수 없습니다. list_connections 로 번호를 확인해 주세요.")
        aws=row.get("aws")
        if aws is None or aws.get("status") != "verified":
            raise Wizard_Error("AWS 연결이 아직 확인되지 않았습니다. 웹 화면에서 AWS 연결을 마친 뒤 다시 시도해 주세요.")
        github=row.get("github")
        return aws["a_id"], (github["g_id"] if github else None), row["label"]

    # 확인 토큰을 소비한다 - 맞지 않으면 Wizard_Error
    @staticmethod
    def services_mcp_consume(store:Confirm_Store, token:str, tool:str, args:dict) -> None:
        if not store.store_consume(token, tool, args):
            raise Wizard_Error(TOKEN_ERROR)

    # 미리보기 결과를 만들고 토큰을 발급한다 (실행하지 않는다)
    @staticmethod
    def services_mcp_preview(store:Confirm_Store, tool:str, args:dict, summary:str, warnings:list[str]) -> dict:
        return {
            "status":"confirmation_required",
            "action":tool,
            "summary":summary,
            "warnings":warnings,
            "confirm_token":store.store_issue(tool, args),
            "expires_in_seconds":store.ttl_seconds,
            "instruction":CONFIRM_INSTRUCTION,
        }

    # 끝난 동작의 결과 - 배포 요약에 status=done 과 배포의 실제 상태(deploy_status)를 붙인다
    @staticmethod
    def services_mcp_done(raw:dict) -> dict:
        return {**Mcp_Service.services_mcp_summary(raw), "status":"done", "deploy_status":raw.get("status")}

    # 새 배포 - 토큰 없이 부르면 분석·미리보기만, 토큰이 맞으면 배포를 만든다
    @staticmethod
    async def services_mcp_deploy(
        client:Wizard_Client,
        store:Confirm_Store,
        repo_url:str,
        branch:str|None=None,
        connection_id:int|None=None,
        confirm_token:str|None=None,
        max_live:int=3,
    ) -> dict:
        args={"repo_url":repo_url, "branch":branch, "connection_id":connection_id}
        if confirm_token:
            Mcp_Service.services_mcp_consume(store, confirm_token, "deploy", args)
        await Mcp_Service.services_mcp_live_check(client, max_live)
        aws_id=None
        github_id=None
        label=None
        if connection_id is not None:
            aws_id, github_id, label=await Mcp_Service.services_mcp_resolve_connection(client, connection_id)

        if confirm_token:
            body={"repo_url":repo_url}
            if branch:
                body["branch"]=branch
            if aws_id is not None:
                body["aws_account_id"]=aws_id
            if github_id is not None:
                body["github_installation_id"]=github_id
            raw=await client.client_request("POST", "/api/deploys", json=body)
            return Mcp_Service.services_mcp_done(raw)

        advice=await Mcp_Service.services_mcp_analyze(client, repo_url, branch, github_id)
        spec=f"추천 사양 {advice.get('tier') or '알 수 없음'}"
        if advice.get("cpu") and advice.get("memory"):
            spec+=f" (CPU {advice['cpu']}, 메모리 {advice['memory']})"
        note=(advice.get("cost") or {}).get("note") or "트래픽에 따라 늘어납니다"
        summary=(
            f"레포 {repo_url} (브랜치 {branch or '기본'}) 를 AWS에 새로 배포합니다. "
            f"언어 {advice.get('language') or '알 수 없음'}, {spec}, 예상 비용: {note}."
        )
        if label:
            summary+=f" 연결: {label}."
        warnings=[
            "ECR·ECS 서비스·ALB가 만들어지고 떠 있는 동안 요금이 계속 나옵니다.",
            "멈추거나 삭제하기 전까지 요금이 계속됩니다. 끝나면 stop_deploy 또는 delete_deploy 를 쓰세요.",
        ]
        warnings.extend(f"확인 필요: {guard_text_clip(item)}" for item in advice.get("unknowns") or [])
        return Mcp_Service.services_mcp_preview(store, "deploy", args, summary, warnings)

    # 기존 배포에 하는 동작 하나 - 토큰 없이 부르면 미리보기, 토큰이 맞으면 실행 (새 서비스가 생기는 동작은 한도를 두 번 확인한다)
    @staticmethod
    async def services_mcp_action(
        client:Wizard_Client, store:Confirm_Store, tool:str, d_id:int, confirm_token:str|None, max_live:int=3
    ) -> dict:
        method, path, title, warnings=ACTION_SPECS[tool]
        args={"d_id":d_id}
        if confirm_token:
            Mcp_Service.services_mcp_consume(store, confirm_token, tool, args)
            if tool == "start_deploy":
                await Mcp_Service.services_mcp_live_check(client, max_live)
            elif tool == "redeploy":
                target=await client.client_request("GET", f"/api/deploys/{d_id}")
                if not Mcp_Service.services_mcp_is_live(target):
                    await Mcp_Service.services_mcp_live_check(client, max_live)
            raw=await client.client_request(method, path.format(d_id=d_id))
            if tool == "delete_deploy":
                raw=raw or {}
                return {
                    "status":"done",
                    "message":guard_text_clip(raw.get("message") or "삭제했습니다."),
                    "deleted_count":len(raw.get("deleted") or []),
                }
            return Mcp_Service.services_mcp_done(raw)

        target=await client.client_request("GET", f"/api/deploys/{d_id}")
        if tool == "start_deploy" or (tool == "redeploy" and not Mcp_Service.services_mcp_is_live(target)):
            await Mcp_Service.services_mcp_live_check(client, max_live)
        current=Mcp_Service.services_mcp_summary(target)
        summary=f"배포 {d_id}번 ({current['repo_url']}, 지금 상태 {current['status']}) 을 {title}합니다."
        return Mcp_Service.services_mcp_preview(store, tool, args, summary, list(warnings))

    # 다시 배포 (미리보기 → 확인 → 실행)
    @staticmethod
    async def services_mcp_redeploy(
        client:Wizard_Client, store:Confirm_Store, d_id:int, confirm_token:str|None=None, max_live:int=3
    ) -> dict:
        return await Mcp_Service.services_mcp_action(client, store, "redeploy", d_id, confirm_token, max_live)

    # 멈춤 (미리보기 → 확인 → 실행)
    @staticmethod
    async def services_mcp_stop(client:Wizard_Client, store:Confirm_Store, d_id:int, confirm_token:str|None=None) -> dict:
        return await Mcp_Service.services_mcp_action(client, store, "stop_deploy", d_id, confirm_token)

    # 다시 켜기 (미리보기 → 확인 → 실행)
    @staticmethod
    async def services_mcp_start(
        client:Wizard_Client, store:Confirm_Store, d_id:int, confirm_token:str|None=None, max_live:int=3
    ) -> dict:
        return await Mcp_Service.services_mcp_action(client, store, "start_deploy", d_id, confirm_token, max_live)

    # 삭제 (미리보기 → 확인 → 실행)
    @staticmethod
    async def services_mcp_delete(client:Wizard_Client, store:Confirm_Store, d_id:int, confirm_token:str|None=None) -> dict:
        return await Mcp_Service.services_mcp_action(client, store, "delete_deploy", d_id, confirm_token)
