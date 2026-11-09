import json

from pydantic import BaseModel, ConfigDict, field_validator
from datetime import datetime

INCIDENT_KINDS=('unhealthy', 'crash_loop', 'bad_release', 'unknown')
INCIDENT_STATUSES=('open', 'recovering', 'resolved', 'needs_action')
# 아직 처리 중인 상태 - 한 배포에 이 상태의 인시던트는 하나만 둔다
INCIDENT_ACTIVE_STATUSES=('open', 'recovering')
# 아직 끝나지 않은 상태 - needs_action 은 사용자가 손봐야 하므로 같은 배포에 새 인시던트를 또 열지 않는다
INCIDENT_UNRESOLVED_STATUSES=('open', 'recovering', 'needs_action')
RECOVERY_ACTIONS=('restart', 'rollback')
RECOVERY_RESULTS=('running', 'ok', 'failed')


# 원인 설명 - 규칙 표가 채운다. fix_where 는 사용자 레포·설정·콘솔 위치를 가리키는 안내 문장일 뿐 마법사가 코드를 고친다는 뜻이 아니다
class Incident_Explain(BaseModel):
    summary: str
    cause: str
    fix_where: str
    actions: list[str] = []
    # rule|llm|none
    source: str = "none"


# 인시던트 한 건 - API 응답 (explain 은 저장된 json 을 풀어 보여 주고, evidence 는 마스킹 후 저장된 글)
class Incident_Read(BaseModel):
    i_id: int
    d_id: int
    kind: str
    status: str
    summary: str | None = None
    explain: Incident_Explain | None = None
    evidence: str | None = None
    detected_at: datetime
    resolved_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)

    # 저장된 json 글을 Incident_Explain 으로 푼다 - 읽을 수 없는 값은 None
    @field_validator('explain', mode='before')
    @classmethod
    def scheme_incident_explain_parse(cls, value):
        if isinstance(value, str):
            try:
                return Incident_Explain.model_validate(json.loads(value))
            except Exception:
                return None
        return value


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


# 인시던트 상세 - 복구 시도 이력(시작 시각순)이 붙는다
class Incident_Detail(Incident_Read):
    actions: list[Recovery_Action_Read] = []
