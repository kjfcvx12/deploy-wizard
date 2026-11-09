from pydantic import BaseModel, ConfigDict
from datetime import datetime

INCIDENT_KINDS=('unhealthy', 'crash_loop', 'bad_release', 'unknown')
INCIDENT_STATUSES=('open', 'recovering', 'resolved', 'needs_action')
# 아직 처리 중인 상태 - 한 배포에 이 상태의 인시던트는 하나만 둔다
INCIDENT_ACTIVE_STATUSES=('open', 'recovering')
RECOVERY_ACTIONS=('restart', 'rollback')
RECOVERY_RESULTS=('running', 'ok', 'failed')


# 인시던트 한 건 - API 응답 (explain·evidence 는 마스킹 후 저장된 글)
class Incident_Read(BaseModel):
    i_id: int
    d_id: int
    kind: str
    status: str
    summary: str | None = None
    explain: str | None = None
    evidence: str | None = None
    detected_at: datetime
    resolved_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# 자동 복구 시도 한 건
class Recovery_Action_Read(BaseModel):
    r_a_id: int
    i_id: int
    action: str
    d_r_id: int | None = None
    result: str
    detail: str | None = None
    started_at: datetime
    finished_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)
