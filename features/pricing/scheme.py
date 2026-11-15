from pydantic import BaseModel, StrictFloat, StrictInt, StrictStr


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


# 사양 프리셋 하나 - cpu 는 CPU 단위 문자열("256"=0.25 vCPU), memory 는 MiB 문자열
class Spec_Option(BaseModel):
    label: str
    cpu: str
    memory: str
    vcpu: float
    memory_gb: float


# 비용 구성 요소 하나 (Fargate, ALB 등) - 시간당 USD
class Cost_Component(BaseModel):
    name: str
    hourly_usd: float
    note: str | None = None


# 기간별 금액 (1시간·1일·1주·한 달)
class Cost_Period(BaseModel):
    label: str
    hours: float
    usd: float


# 배포 비용 추정 결과 - 모든 금액은 USD 온디맨드 추정치
class Cost_Estimate(BaseModel):
    basis_date: str
    region: str
    currency: str = "USD"
    cpu: str
    memory: str
    spec_label: str
    spec_is_default: bool
    components: list[Cost_Component]
    hourly_usd: float
    periods: list[Cost_Period]
    planned_hours: float | None = None
    planned_usd: float | None = None
    max_tasks: int | None = None
    max_hourly_usd: float | None = None
    max_monthly_usd: float | None = None
    arm64_hourly_usd: float | None = None
    arm64_saving_percent: float | None = None
    assumptions: list[str]
    not_included: list[str]


# 사용 기간 선택지 하나 - hours 가 None 이면 "계속" (기간을 정하지 않음)
class Pricing_Plan(BaseModel):
    label: str
    hours: int | None = None


# 가격 화면에 필요한 선택지 - 사양 프리셋과 사용 기간
class Pricing_Options(BaseModel):
    specs: list[Spec_Option]
    plans: list[Pricing_Plan]


# 비용 추정 요청 - 모든 값이 선택. 타입은 엄격하게 받고(불리언·글자 숫자 거절), 범위는 라우터가 한국어 400 으로 검사한다
class Estimate_Request(BaseModel):
    cpu: StrictStr | None = None
    memory: StrictStr | None = None
    planned_hours: StrictInt | StrictFloat | None = None
    max_tasks: StrictInt | None = None
