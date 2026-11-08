from pydantic import BaseModel
from typing import Literal


ENV_KINDS=('database', 'cache', 'external_api', 'secret', 'config', 'unknown')
# 값이 시크릿 저장소로 가야 하는 종류
ENV_SECRET_KINDS={'database', 'cache', 'external_api', 'secret'}
ENV_SOURCES=('code', 'compose', 'example', 'runtime_error', 'user')
ENV_STATUSES=('detected', 'set', 'skipped')


# 스캐너가 코드에서 찾아낸 환경변수 한 건 - 이름과 위치만 있고 값은 없다
class Env_Found(BaseModel):
    name: str
    required: bool
    has_default: bool
    kind: str = 'unknown'
    source: str
    source_hint: str | None = None


# 화면·API 응답 - 값은 절대 싣지 않고 has_value 만 돌려준다
class Env_Read(BaseModel):
    d_e_id: int
    d_id: int
    name: str
    required: bool
    has_default: bool
    kind: str
    source: str
    source_hint: str | None = None
    status: str
    has_value: bool
    needs_redeploy: bool = False


# 값 입력·종류 변경·건너뛰기 - 쓰기 전용
class Env_Update(BaseModel):
    value: str | None = None
    kind: str | None = None
    skip: bool | None = None


# LLM 이 고르는 빈칸 - 정해진 목록 중 하나만 허용한다 (기획서 LLM 규칙)
class Env_Kind_Pick(BaseModel):
    kind: Literal['database', 'cache', 'external_api', 'secret', 'config', 'unknown']
