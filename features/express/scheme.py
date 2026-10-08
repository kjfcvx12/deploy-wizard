from pydantic import BaseModel


# Express Mode 서비스 현재 상태
class Express_Status(BaseModel):
    service_arn: str
    service_name: str | None = None
    # ACTIVE|DRAINING|INACTIVE
    status_code: str | None = None
    status_reason: str | None = None
    # PENDING|IN_PROGRESS|SUCCESSFUL|STOPPED|ROLLBACK_IN_PROGRESS|ROLLBACK_SUCCESSFUL|ROLLBACK_FAILED ...
    deployment_status: str | None = None
    deployment_reason: str | None = None
    lifecycle_stage: str | None = None
    endpoint: str | None = None


# 정리 대상 리소스 하나
class Express_Resource(BaseModel):
    # ecs_service|ecr_repository
    kind: str
    arn: str
    name: str
