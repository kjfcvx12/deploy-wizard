from pydantic import BaseModel, Field
from datetime import datetime
from typing import Annotated


class Aws_Account_Create(BaseModel):
    label: Annotated[str, Field(max_length=100)]
    region: str | None = None


# POST 응답 전용 - 생성 직후에만 평문 external_id 를 보여준다. 이후로는 다시 노출하지 않는다
class Aws_Account_Setup(BaseModel):
    a_id: int
    label: str
    external_id: str
    our_account_id: str
    template_download_url: str
    stack_create_url: str


# 사용자 계정의 스택이 최신 템플릿인지 - update_needed 면 화면이 "스택 업데이트 필요"를 띄운다
class Aws_Account_Template_Status(BaseModel):
    a_id: int
    current_version: int
    latest_version: int
    update_needed: bool
    # 사용자 계정 S3 에 남아 있는 업로드 사본 수 - 0 이면 지울 것이 없다
    template_file_count: int
    template_download_url: str
    stack_list_url: str


class Aws_Account_Role_Attach(BaseModel):
    role_arn: Annotated[str, Field(max_length=255)]


class Aws_Account_Read(BaseModel):
    a_id: int
    label: str
    role_arn: str | None = None
    aws_account_id: str | None = None
    region: str | None = None
    status: str
    last_verified_at: datetime | None = None
    last_error: str | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
    # external_id_encrypted 는 절대 포함하지 않는다


# 설치가 읽을 수 있는 레포 하나 - 새 배포 폼이 주소 입력창의 목록으로 보여준다
class Github_Repository_Read(BaseModel):
    full_name: str
    html_url: str
    private: bool = False
    default_branch: str | None = None


# 연결 확인 결과 - 설치 토큰으로 실제 접근해 본 것. repositories 는 앞의 몇 개만
class Github_Installation_Check(BaseModel):
    g_id: int
    account_login: str
    repository_selection: str | None = None
    repository_count: int
    repositories: list[str]


# 설치는 GitHub 콜백에서 서버가 직접 만든다 - 별도 Create 스키마 없음
class Github_Installation_Read(BaseModel):
    g_id: int
    installation_id: int
    account_login: str
    account_type: str | None = None
    repository_selection: str | None = None
    status: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class Connection_Create(BaseModel):
    label: Annotated[str, Field(min_length=1, max_length=100)]


# 블록에 AWS 계정·GitHub 설치를 잇거나(id) 뗀다(null). 보내지 않은 쪽은 그대로 둔다
class Connection_Update(BaseModel):
    aws_account_id: int | None = None
    github_installation_id: int | None = None


# 연결 블록 - AWS 계정과 GitHub 설치를 한 묶음으로. 아직 연결 전인 쪽은 null
class Connection_Read(BaseModel):
    c_id: int
    label: str
    aws: Aws_Account_Read | None = None
    github: Github_Installation_Read | None = None
