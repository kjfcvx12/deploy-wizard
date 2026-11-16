from fastapi import APIRouter, Depends, Request, Response, status

from sqlalchemy.ext.asyncio import AsyncSession

from shared.database import get_db
from shared.settings import settings

from features.auth.scheme import (Auth_Google_Request, Auth_Refresh_Request, Auth_Token, User_Read, Current_User,
                                  Api_Token_Create, Api_Token_Read, Api_Token_Issued, Auth_Delete_Read)
from features.auth.services import Auth_Service


router=APIRouter(prefix='/api', tags=['Auth'])

# 웹 리프레시 쿠키 - 자바스크립트가 읽지 못하고(httponly) 같은 사이트의 /api/auth 요청에만 실린다
REFRESH_COOKIE="dw_refresh"
REFRESH_COOKIE_PATH="/api/auth"


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


# POST Google 로그인 - 웹은 리프레시를 쿠키로 (Origin 확인 필수), 앱은 본문으로
@router.post('/auth/google', response_model=Auth_Token)
async def router_auth_google(payload:Auth_Google_Request, request:Request, response:Response, db:AsyncSession=Depends(get_db)):
    if payload.platform == "web":
        Auth_Service.services_auth_origin_check(request.headers.get("origin"))

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


# GET 내 정보 - AUTH_ENABLED 와 무관하게 로그인 사용자(액세스 토큰·개인 토큰)가 있어야 한다
@router.get('/me', response_model=User_Read)
async def router_auth_me(user:Current_User=Depends(Auth_Service.services_auth_login_user), db:AsyncSession=Depends(get_db)):
    return await Auth_Service.services_auth_me(db, Auth_Service.services_auth_require_user(user))


# POST 개인 토큰 발급 (MCP 용) - 원문은 이 응답에만. 로그인(액세스 토큰)으로만
@router.post('/auth/tokens', response_model=Api_Token_Issued, status_code=status.HTTP_201_CREATED)
async def router_auth_token_create(payload:Api_Token_Create, user:Current_User=Depends(Auth_Service.services_auth_login_user),
                                   db:AsyncSession=Depends(get_db)):
    return await Auth_Service.services_auth_token_create(db, Auth_Service.services_auth_require_access(user), payload)


# GET 내 개인 토큰 목록 - 끝 4자리만
@router.get('/auth/tokens', response_model=list[Api_Token_Read])
async def router_auth_token_list(user:Current_User=Depends(Auth_Service.services_auth_login_user), db:AsyncSession=Depends(get_db)):
    return await Auth_Service.services_auth_token_list(db, Auth_Service.services_auth_require_access(user))


# DELETE 개인 토큰 폐기 - 남의 것은 404
@router.delete('/auth/tokens/{a_t_id}', response_model=dict)
async def router_auth_token_revoke(a_t_id:int, user:Current_User=Depends(Auth_Service.services_auth_login_user), db:AsyncSession=Depends(get_db)):
    return await Auth_Service.services_auth_token_revoke(db, Auth_Service.services_auth_require_access(user), a_t_id)


# 본문을 그대로 읽는다 - 없거나 깨진 JSON 도 422 가 아니라 확인 실패(400)로 보내려고 직접 파싱한다
async def router_auth_body_read(request:Request):
    try:
        return await request.json()
    except ValueError:
        return None


# DELETE 계정 삭제 - 본문 {"confirm": true} 필수. 기록만 지우고 AWS·GitHub 는 건드리지 않는다. 로그인(액세스 토큰)으로만, 개인 토큰은 403
@router.delete('/me', response_model=Auth_Delete_Read)
async def router_auth_me_delete(request:Request, user:Current_User=Depends(Auth_Service.services_auth_login_user), db:AsyncSession=Depends(get_db)):
    u_id=Auth_Service.services_auth_require_access(user)
    Auth_Service.services_auth_delete_confirm(await router_auth_body_read(request))
    return await Auth_Service.services_auth_account_delete(db, u_id)
