from pydantic import BaseModel


# 분석 요청 - 배포 만들기와 같은 본문
class Advice_Request(BaseModel):
    repo_url: str
    branch: str | None = None
    aws_account_id: int | None = None
    github_installation_id: int | None = None


# 필요한 것 한 항목 (database cache worker env_vars disk_write static_site)
class Advice_Need(BaseModel):
    kind: str
    supported: bool
    message: str | None = None
    count: int | None = None


# 비용 범위 - 요금 구성을 검증하기 전까지 숫자는 전부 None (D10)
class Advice_Cost(BaseModel):
    monthly_min: float | None = None
    monthly_max: float | None = None
    currency: str = 'USD'
    basis_date: str | None = None
    note: str = '트래픽에 따라 늘어납니다'


# 레포를 읽고 모은 신호 - 판정은 이 값만 보고 한다
class Advice_Signals(BaseModel):
    dep_file_parsed: bool
    dep_count: int = 0
    heavy_libs: list[str] = []
    db_libs: list[str] = []
    cache_libs: list[str] = []
    worker_libs: list[str] = []
    static_site: bool = False
    disk_write: bool = False
    env_count: int = 0
    manifest: str = ''


# 분석 결과 - 응답 그대로
class Deploy_Advice(BaseModel):
    tier: str
    confidence: str
    cpu: str | None = None
    memory: str | None = None
    cost: Advice_Cost
    reasons: list[str]
    needs: list[Advice_Need]
    unknowns: list[str]
    language: str
    support_level: str
    app_dir: str
    commit_sha: str | None = None
