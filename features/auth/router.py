from fastapi import APIRouter, Depends, Request, Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from sqlalchemy.ext.asyncio import AsyncSession

from shared.database import get_db
from shared.settings import settings

from features.auth.scheme import Auth_Google_Request, Auth_Refresh_Request, Auth_Token, User_Read
from features.auth.services import Auth_Service


router=APIRouter(prefix='/api', tags=['Auth'])

# 웹 리프레시 쿠키 - 자바스크립트가 읽지 못하고(httponly) 같은 사이트의 /api/auth 요청에만 실린다
REFRESH_COOKIE="dw_refresh"
REFRESH_COOKIE_PATH="/api/auth"

bearer=HTTPBearer(auto_error=False)


# 리프레시 쿠키 굽기
def router_auth_cookie_set(response:Response, raw:str) -> None:
    response.set_cookie(REFRESH_COOKIE, raw, max_age=settings.auth_refresh_days * 86400, path=REFRESH_COOKIE_PATH,
                        secure=settings.auth_cookie_secure, httponly=True, samesite="strict")


# 본문에 없으면 쿠키에서 리프레시 토큰을 꺼낸다 - 쿠키로 왔으면 Origin 을 확인한다. 반환: (토큰, 쿠키로 왔는지)
def router_auth_refresh_token_pick(request:Request, payload:Auth_Refresh_Request | None) -> tuple[str | None, bool]:
    if payload and payload.refresh_token:
        return payload.refresh_token, False

    cookie=request.cookies.get(REFRESH_COOKIE)
    if not cookie:
        return None, False

    Auth_Service.services_auth_origin_check(request.headers.get("origin"))
    return cookie, True


# POST Google 로그인 - 웹은 리프레시를 쿠키로, 앱은 본문으로
@router.post('/auth/google', response_model=Auth_Token)
async def router_auth_google(payload:Auth_Google_Request, response:Response, db:AsyncSession=Depends(get_db)):
    token, raw=await Auth_Service.services_auth_google_login(db, payload.id_token, payload.platform)

    if payload.platform == "web":
        router_auth_cookie_set(response, raw)
        return token.model_copy(update={"refresh_token": None})

    return token


# POST 토큰 연장 (회전) - 쿠키로 온 토큰이면 새 토큰도 쿠키로
@router.post('/auth/refresh', response_model=Auth_Token)
async def router_auth_refresh(request:Request, response:Response, payload:Auth_Refresh_Request | None=None, db:AsyncSession=Depends(get_db)):
    refresh_token, from_cookie=router_auth_refresh_token_pick(request, payload)
    token, raw=await Auth_Service.services_auth_refresh(db, refresh_token)

    if from_cookie:
        router_auth_cookie_set(response, raw)
        return token.model_copy(update={"refresh_token": None})

    return token


# POST 로그아웃 - 그 계열 폐기 후 쿠키를 지운다 (모르는 토큰이어도 200)
@router.post('/auth/logout')
async def router_auth_logout(request:Request, response:Response, payload:Auth_Refresh_Request | None=None, db:AsyncSession=Depends(get_db)):
    refresh_token, _=router_auth_refresh_token_pick(request, payload)
    await Auth_Service.services_auth_logout(db, refresh_token)

    response.delete_cookie(REFRESH_COOKIE, path=REFRESH_COOKIE_PATH, secure=settings.auth_cookie_secure, httponly=True, samesite="strict")
    return {"message": "로그아웃했습니다"}


# GET 내 정보 - AUTH_ENABLED 와 무관하게 액세스 토큰이 있어야 한다
@router.get('/me', response_model=User_Read)
async def router_auth_me(credentials:HTTPAuthorizationCredentials | None=Depends(bearer), db:AsyncSession=Depends(get_db)):
    u_id=Auth_Service.services_auth_access_decode(credentials.credentials if credentials else "")
    return await Auth_Service.services_auth_me(db, u_id)
