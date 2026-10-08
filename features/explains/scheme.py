from pydantic import BaseModel, Field


# 한국어 에러 해설 (M5)
class Explain_Result(BaseModel):
    summary: str = Field(description="무슨 일이 일어났는지 한 문장")
    cause: str = Field(description="원인 설명. 초보자도 이해할 수 있게 두세 문장")
    actions: list[str] = Field(default=[], description="사용자가 해 볼 수 있는 조치. 구체적인 순서로 1~4개")
    # rule|llm|none
    source: str = "none"
    # 에러 시그니처 캐시에서 그대로 가져왔는지 - LLM을 다시 부르지 않았다는 뜻
    cached: bool = False
