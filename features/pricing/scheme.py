from pydantic import BaseModel


# AWS 공개 가격 파일에서 읽은 시간당 단가 표 (USD) - 기준일(basis_date)은 가격 파일 발행일
class Price_Table(BaseModel):
    region: str
    basis_date: str
    fargate_vcpu_hour: float
    fargate_gb_hour: float
    fargate_arm_vcpu_hour: float | None = None
    fargate_arm_gb_hour: float | None = None
    alb_hour: float
    lcu_hour: float | None = None
