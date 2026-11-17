from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


# 로그인 플랫폼 -> 그 플랫폼 로그인에서 aud 로 받는 Google 클라이언트 ID 설정 이름들 (settings 속성). 이 표가 허용 플랫폼의 기준이다
# 안드로이드 네이티브 로그인은 id_token 의 aud 를 서버(웹) 클라이언트 ID 로, 안드로이드 클라이언트 ID 는 azp 로 준다 (Google 문서, 한 번 더 확인 필요) - 그래서 둘 다 받는다
# iOS 추가 시 여기에 'ios' 한 줄 + GOOGLE_CLIENT_ID_IOS 설정
LOGIN_PLATFORMS={
    "web": ("google_client_id_web",),
    "android": ("google_client_id_android", "google_client_id_web"),
}


class Auth_Google_Request(BaseModel):
    id_token: str
    platform: str

    # 플랫폼은 LOGIN_PLATFORMS 의 키만 받는다 (그 밖은 422)
    @field_validator("platform")
    @classmethod
    def scheme_auth_platform_check(cls, value:str) -> str:
        if value not in LOGIN_PLATFORMS:
            raise ValueError("지원하지 않는 플랫폼입니다 (" + "|".join(LOGIN_PLATFORMS) + ")")
        return value


# 앱은 본문에 refresh_token 을 넣고, 웹은 비워 두면 쿠키(dw_refresh)를 쓴다
class Auth_Refresh_Request(BaseModel):
    refresh_token: str | None = None


class User_Read(BaseModel):
    u_id: int
    email: str
    name: str | None = None
    picture_url: str | None = None

    class Config:
        from_attributes = True


# 웹 응답에서는 refresh_token 이 None 이고 쿠키로 간다
class Auth_Token(BaseModel):
    access_token: str
    expires_in: int
    refresh_token: str | None = None
    user: User_Read


# 현재 사용자 - off: AUTH_ENABLED=false (u_id 없음, 소유권 필터 없음) · access: 액세스 JWT · pat: 개인 토큰
class Current_User(BaseModel):
    u_id: int | None = None
    via: Literal["off", "access", "pat"]


# 개인 토큰 발급 요청 - 이름 1~50자, 기간(일)은 비우면 기본값(AUTH_PAT_DEFAULT_DAYS)
class Api_Token_Create(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    expires_in_days: int | None = Field(None, ge=1)

    # 앞뒤 공백을 지운 뒤 길이를 본다
    @field_validator("name", mode="before")
    @classmethod
    def scheme_api_token_name_strip(cls, value):
        return value.strip() if isinstance(value, str) else value


# 목록·발급 응답 - 원문 없이 끝 4자리만
class Api_Token_Read(BaseModel):
    a_t_id: int
    name: str
    last4: str
    expires_at: datetime | None = None
    last_used_at: datetime | None = None
    created_at: datetime | None = None

    class Config:
        from_attributes = True


# 발급 응답 - token(원문)은 이 응답에만 있다
class Api_Token_Issued(Api_Token_Read):
    token: str


# 계정 삭제 응답 - 지운 기록 수 (AWS·GitHub 쪽은 지우지 않으므로 message 로 직접 지우라고 안내한다)
class Auth_Delete_Read(BaseModel):
    message: str
    deleted: dict[str, int]
    # 지운 배포 기록이 남긴 ECR 저장소 이름 - 요금이 나갈 수 있으니 사용자가 직접 지운다 (자동으로 지우지 않는다)
    leftover_ecr_repositories: list[str] = []
