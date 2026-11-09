from pydantic import BaseModel, ConfigDict, Field, field_validator
from datetime import datetime
from typing import Annotated
import json

from features.explains.scheme import Explain_Result


class Deploy_Base(BaseModel):
    repo_url: Annotated[str, Field(max_length=255)]
    branch: Annotated[str | None, Field(max_length=100)] = None


class Deploy_Create(Deploy_Base):
    # M6 - 연결된 계정. 없으면 개발 세션 + public 클론 (M1~M5 그대로)
    aws_account_id: int | None = None
    github_installation_id: int | None = None


class Deploy_In_DB(Deploy_Base):
    d_id: int
    commit_sha: str | None = None

    language: str | None = None
    support_level: str | None = None
    app_dir: str | None = None

    status: str

    dockerfile: str | None = None
    dockerfile_source: str | None = None
    fix_count: int = 0

    service_name: str | None = None
    service_arn: str | None = None
    image_uri: str | None = None
    port: int | None = None
    health_check_path: str | None = None
    endpoint: str | None = None

    error_step: str | None = None
    error_msg: str | None = None
    explain: Explain_Result | None = None

    # M6
    aws_account_id: int | None = None
    github_installation_id: int | None = None
    auto_redeploy: bool = True
    watch_commit_sha: str | None = None
    watch_checked_at: datetime | None = None

    # 값이 비어 있는 필수 환경변수 수 - DB 열이 아니라 서비스가 채운다
    env_pending: int = 0

    # 운영 복구 (D1) - 자동 복구 스위치와 헬스 요약. open_incident_id·open_incident_status(끝나지 않은 open|recovering|needs_action 인시던트의 번호·상태)는 DB 열이 아니라 서비스가 채운다
    auto_recover: bool = True
    health_state: str = 'unknown'
    last_health_at: datetime | None = None
    open_incident_id: int | None = None
    open_incident_status: str | None = None

    created_at: datetime
    updated_at: datetime

    # DB에는 json 문자열로 들어 있다
    @field_validator("explain", mode="before")
    @classmethod
    def explain_from_json(cls, value):
        if isinstance(value, str):
            try:
                return json.loads(value)
            except Exception:
                return None
        return value

    class Config:
        from_attributes = True


class Deploy_Read(Deploy_In_DB):
    pass


class Deploy_Log_Read(BaseModel):
    d_l_id: int
    d_id: int
    step: str
    level: str
    message: str
    created_at: datetime

    class Config:
        from_attributes = True


class Deploy_Issue_Read(BaseModel):
    d_i_id: int
    d_id: int
    step: str
    error_msg: str
    explain: Explain_Result | None = None
    created_at: datetime

    # DB에는 json 문자열로 들어 있다
    @field_validator("explain", mode="before")
    @classmethod
    def explain_from_json(cls, value):
        if isinstance(value, str):
            try:
                return json.loads(value)
            except Exception:
                return None
        return value

    class Config:
        from_attributes = True


class Deploy_Health(BaseModel):
    d_id: int
    # healthy|unhealthy|unknown
    health: str
    status_code: int | None = None
    detail: str | None = None


# 배포별 설정 변경 - 보낸 항목만 바꾼다 (모르는 항목은 거부)
class Deploy_Settings_Update(BaseModel):
    auto_redeploy: bool | None = None
    auto_recover: bool | None = None

    model_config = ConfigDict(extra='forbid')
