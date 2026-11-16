from fastapi import APIRouter, Depends, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.responses import JSONResponse

from sqlalchemy.ext.asyncio import AsyncSession

from shared.database import get_db

from features.auth.scheme import Current_User
from features.auth.services import Auth_Service
from features.notifications.scheme import (Notification_Read, Device_Create, Device_Read,
                                           Notification_Setting_Read, Notification_Setting_Update)
from features.notifications.inbox import Notification_Inbox_Service


router=APIRouter(prefix='/api',tags=['Notification'])


# 요청 검증 오류 처리 - /api/devices 는 입력값(푸시 토큰)을 응답에 되돌려 보내지 않는다 (type/loc/msg 만).
# /api/auth 는 input 항목만 뺀다 (id_token·리프레시 토큰이 본문째로 실려 나가지 않게). 다른 경로는 FastAPI 기본 그대로
async def router_notification_validation_error(request:Request, exc:RequestValidationError):
    path=request.url.path
    if path.startswith('/api/devices'):
        errors=[{key: error[key] for key in ('type', 'loc', 'msg') if key in error} for error in exc.errors()]
    elif path.startswith('/api/auth'):
        errors=[{key: value for key, value in error.items() if key != 'input'} for error in exc.errors()]
    else:
        return await request_validation_exception_handler(request, exc)

    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})


# GET 앱 안 알림 목록 (최신순 100건)
@router.get('/notifications', response_model=list[Notification_Read])
async def router_notification_get_all(after:int|None=Query(None, ge=1), unread:bool=False, db:AsyncSession=Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Notification_Inbox_Service.services_notification_get_all(db, after, unread, user.u_id)


# GET 읽지 않은 알림 수
@router.get('/notifications/unread-count')
async def router_notification_unread_count(db:AsyncSession=Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Notification_Inbox_Service.services_notification_unread_count(db, user.u_id)


# GET 알림 설정
@router.get('/notifications/settings', response_model=Notification_Setting_Read)
async def router_notification_setting_get(db:AsyncSession=Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Notification_Inbox_Service.services_notification_setting_read(db, user.u_id)


# PATCH 알림 설정 수정
@router.patch('/notifications/settings', response_model=Notification_Setting_Read)
async def router_notification_setting_update(update:Notification_Setting_Update, db:AsyncSession=Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Notification_Inbox_Service.services_notification_setting_update(db, update, user.u_id)


# POST 모두 읽음
@router.post('/notifications/read-all')
async def router_notification_read_all(db:AsyncSession=Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Notification_Inbox_Service.services_notification_read_all(db, user.u_id)


# POST 알림 한 건 읽음
@router.post('/notifications/{n_id}/read', response_model=Notification_Read)
async def router_notification_read(n_id:int, db:AsyncSession=Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Notification_Inbox_Service.services_notification_read(db, n_id, user.u_id)


# POST 푸시 기기 등록 (같은 토큰이면 갱신)
@router.post('/devices', response_model=Device_Read, status_code=201)
async def router_notification_device_register(device:Device_Create, db:AsyncSession=Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Notification_Inbox_Service.services_notification_device_register(db, device, user.u_id)


# DELETE 푸시 기기 등록 해제
@router.delete('/devices/{p_d_id}')
async def router_notification_device_delete(p_d_id:int, db:AsyncSession=Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Notification_Inbox_Service.services_notification_device_delete(db, p_d_id, user.u_id)
