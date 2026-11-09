from pydantic import BaseModel, ConfigDict
from datetime import datetime


# 헬스체크 한 번의 결과 - 화면·API 응답
class Health_Check_Read(BaseModel):
    h_c_id: int
    d_id: int
    ok: bool
    status_code: int | None = None
    latency_ms: int | None = None
    detail: str | None = None
    checked_at: datetime

    model_config = ConfigDict(from_attributes=True)
