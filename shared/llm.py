import anthropic
from pydantic import BaseModel
from typing import TypeVar

from shared.settings import settings
from shared.masking import mask_text

# LLM은 "빈칸 채우기"로만 쓴다 (기획서 02장)
# 출력은 항상 pydantic 스키마로 고정하고, 자유 서술을 그대로 실행하지 않는다

T=TypeVar("T", bound=BaseModel)


# LLM을 쓸 수 없을 때 (꺼짐·인증 없음·거절) -> 호출한 쪽에서 규칙 기반으로 넘어간다
class LLM_Unavailable(Exception):
    pass


class LLM_Client:
    client:anthropic.AsyncAnthropic|None=None

    # 클라이언트는 처음 쓸 때 한 번만 만든다 (키는 SDK가 환경에서 직접 찾는다)
    @staticmethod
    def llm_get_client() -> anthropic.AsyncAnthropic:
        if not settings.llm_enabled:
            raise LLM_Unavailable("LLM_ENABLED=false")

        if LLM_Client.client is None:
            LLM_Client.client=anthropic.AsyncAnthropic()

        return LLM_Client.client


    # 구조화 출력 요청 - scheme 인스턴스로 돌려준다
    @staticmethod
    async def llm_parse(system:str, prompt:str, scheme:type[T]) -> T:
        client=LLM_Client.llm_get_client()

        try:
            response=await client.messages.parse(
                model=settings.llm_model,
                max_tokens=16000,
                system=system,
                messages=[{"role": "user", "content": mask_text(prompt)}],
                output_format=scheme,
                # 안전 분류기가 거절하면 서버에서 다른 모델로 다시 실행
                extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
                extra_body={"fallbacks": "default"},
            )

        except anthropic.AuthenticationError as e:
            raise LLM_Unavailable(f"LLM 인증 실패 :{e}")

        except anthropic.RateLimitError as e:
            raise LLM_Unavailable(f"LLM 호출 한도 초과 :{e}")

        except anthropic.APIStatusError as e:
            raise LLM_Unavailable(f"LLM 오류 {e.status_code} :{e.message}")

        except anthropic.APIConnectionError as e:
            raise LLM_Unavailable(f"LLM 연결 실패 :{e}")

        except Exception as e:
            # 자격증명을 아예 못 찾으면 SDK가 요청 전에 일반 예외를 던진다
            raise LLM_Unavailable(f"LLM 호출 실패 :{e}")

        if response.stop_reason == "refusal":
            raise LLM_Unavailable("LLM이 요청을 거절했습니다")

        if response.stop_reason == "max_tokens" or response.parsed_output is None:
            raise LLM_Unavailable("LLM 응답이 잘렸습니다")

        return response.parsed_output
