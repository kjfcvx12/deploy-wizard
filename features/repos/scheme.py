from pydantic import BaseModel


# 레포 안에서 찾은 앱 하나
class Repo_App(BaseModel):
    language: str
    # official|experimental
    support_level: str
    # 레포 루트 기준 상대 경로 ("." 이면 루트)
    app_dir: str
    manifest: str
    has_dockerfile: bool = False


# 언어 판별 결과
class Repo_Detect(Repo_App):
    # 같은 레포에서 함께 발견된 다른 앱 (프론트 등) - M8에서 사용
    other_apps: list[Repo_App] = []


# LLM에 보낼 파일 하나
class Repo_File(BaseModel):
    path: str
    content: str


# LLM에 보낼 레포 요약 - 레포 전체는 절대 보내지 않는다
class Repo_Collect(BaseModel):
    tree: str
    manifest: Repo_File
    entry_files: list[Repo_File] = []


# git ls-remote 결과
class Repo_Remote(BaseModel):
    default_branch: str | None = None
    branches: list[str] = []
