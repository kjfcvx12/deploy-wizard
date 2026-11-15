from typing import Any

import httpx

from features.mcp.guard import guard_text_clip


# 서버가 돌려준 실패를 한국어 한 줄로 담는 예외
class Wizard_Error(Exception):

    def __init__(self, message:str):
        super().__init__(message)
        self.message=message


# 배포 마법사 REST API 호출 클라이언트 (기획서 5.1) - 표준 출력에는 아무것도 쓰지 않는다
class Wizard_Client:

    # 기본 주소·토큰·전송 계층으로 httpx 클라이언트를 만든다 (transport 는 테스트용)
    def __init__(self, base_url:str, token:str|None=None, transport:httpx.AsyncBaseTransport|None=None):
        headers={"Authorization":f"Bearer {token}"} if token else {}
        self.http=httpx.AsyncClient(base_url=base_url, headers=headers, transport=transport, timeout=30.0)

    # 요청 하나를 보내고 JSON 을 돌려준다 - 실패는 Wizard_Error
    async def client_request(self, method:str, path:str, **kwargs) -> Any:
        try:
            response=await self.http.request(method, path, **kwargs)
        except httpx.ConnectError:
            raise Wizard_Error("배포 마법사 서버에 연결할 수 없습니다. 서버를 켜 주세요: uvicorn main:app --port=8081")
        except httpx.TimeoutException:
            raise Wizard_Error("배포 마법사 서버의 응답이 늦습니다. 잠시 뒤 다시 시도해 주세요.")
        except httpx.HTTPError as e:
            raise Wizard_Error(f"배포 마법사 서버와 통신하지 못했습니다: {type(e).__name__}")

        if response.status_code >= 400:
            raise Wizard_Error(self.client_error_message(response))
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            raise Wizard_Error("배포 마법사 서버의 응답을 읽을 수 없습니다.")

    # 실패 응답을 한국어 메시지로 바꾼다
    @staticmethod
    def client_error_message(response:httpx.Response) -> str:
        try:
            detail=response.json().get("detail")
        except (ValueError, AttributeError):
            detail=None
        if response.status_code == 422:
            return "입력 형식이 맞지 않습니다. 값을 확인해 주세요."
        if isinstance(detail, str) and detail:
            return guard_text_clip(detail)
        return f"배포 마법사 서버가 오류를 돌려줬습니다 (HTTP {response.status_code})."

    # 마지막 tail 개 로그 줄을 오래된 것부터 돌려준다 - 한 번에 500개씩 끝까지 읽는다
    async def client_logs_tail(self, d_id:int, tail:int) -> list[dict]:
        kept:list[dict]=[]
        after=0
        while True:
            rows=await self.client_request("GET", f"/api/deploys/{d_id}/logs", params={"after":after})
            if not rows:
                break
            kept.extend(rows)
            kept=kept[-tail:] if tail > 0 else []
            after=rows[-1]["d_l_id"]
        return kept

    # 연결을 닫는다
    async def aclose(self) -> None:
        await self.http.aclose()
