from pydantic import BaseModel, Field


# 정식 지원 - 템플릿의 빈칸. LLM에게는 이것만 묻는다 (기획서 02장)
class Dockerfile_Fill(BaseModel):
    runtime_version: str = Field(description="베이스 이미지 버전. 숫자와 점만. 예: 3.12, 22")
    system_packages: list[str] = Field(default=[], description="apt로 설치해야 하는 시스템 패키지. 없으면 빈 목록")
    install_command: str = Field(description="의존성 설치 명령 한 줄. 예: pip install --no-cache-dir -r requirements.txt")
    build_command: str | None = Field(default=None, description="빌드 명령 한 줄. 필요 없으면 null")
    start_command: str = Field(description="서버 시작 명령 한 줄. 반드시 0.0.0.0 에 바인딩")
    port: int = Field(description="컨테이너가 듣는 포트")
    health_check_path: str = Field(default="/", description="200을 돌려주는 GET 경로")


# 실험 지원·자가수정 - Dockerfile 전체
class Dockerfile_Raw(BaseModel):
    dockerfile: str = Field(description="Dockerfile 전체 내용")
    port: int = Field(description="컨테이너가 듣는 포트")
    health_check_path: str = Field(default="/", description="200을 돌려주는 GET 경로")
    reason: str = Field(default="", description="이렇게 쓴 이유 또는 무엇을 고쳤는지 한국어 한두 문장")


# 생성 결과
class Dockerfile_Result(BaseModel):
    dockerfile: str
    port: int
    health_check_path: str = "/"
    # template_llm|template_rule|llm_raw|repo|llm_fix
    source: str
    reason: str = ""
    cached: bool = False
