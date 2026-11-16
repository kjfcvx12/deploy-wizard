from pydantic import BaseModel, field_validator


# 로그인 플랫폼 -> 그 플랫폼의 Google 클라이언트 ID 설정 이름 (settings 속성). 이 표가 허용 플랫폼의 기준이다
# iOS 추가 시 여기에 'ios' 한 줄 + GOOGLE_CLIENT_ID_IOS 설정
LOGIN_PLATFORMS={
    "web": "google_client_id_web",
    "android": "google_client_id_android",
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
