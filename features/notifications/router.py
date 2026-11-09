from fastapi import APIRouter, Depends, Query

from sqlalchemy.ext.asyncio import AsyncSession

from shared.database import get_db

from features.notifications.scheme import (Notification_Read, Device_Create, Device_Read,
                                           Notification_Setting_Read, Notification_Setting_Update)
from features.notifications.inbox import Notification_Inbox_Service


router=APIRouter(prefix='/api',tags=['Notification'])


# GET 앱 안 알림 목록 (최신순 100건)
@router.get('/notifications', response_model=list[Notification_Read])
async def router_notification_get_all(after:int|None=Query(None, ge=1), unread:bool=False, db:AsyncSession=Depends(get_db)):
    return await Notification_Inbox_Service.services_notification_get_all(db, after, unread)


# GET 읽지 않은 알림 수
@router.get('/notifications/unread-count')
async def router_notification_unread_count(db:AsyncSession=Depends(get_db)):
    return await Notification_Inbox_Service.services_notification_unread_count(db)


# GET 알림 설정
@router.get('/notifications/settings', response_model=Notification_Setting_Read)
async def router_notification_setting_get(db:AsyncSession=Depends(get_db)):
    return await Notification_Inbox_Service.services_notification_setting_read(db)


# PATCH 알림 설정 수정
@router.patch('/notifications/settings', response_model=Notification_Setting_Read)
async def router_notification_setting_update(update:Notification_Setting_Update, db:AsyncSession=Depends(get_db)):
    return await Notification_Inbox_Service.services_notification_setting_update(db, update)


# POST 모두 읽음
@router.post('/notifications/read-all')
async def router_notification_read_all(db:AsyncSession=Depends(get_db)):
    return await Notification_Inbox_Service.services_notification_read_all(db)


# POST 알림 한 건 읽음
@router.post('/notifications/{n_id}/read', response_model=Notification_Read)
async def router_notification_read(n_id:int, db:AsyncSession=Depends(get_db)):
    return await Notification_Inbox_Service.services_notification_read(db, n_id)


# POST 푸시 기기 등록 (같은 토큰이면 갱신)
@router.post('/devices', response_model=Device_Read, status_code=201)
async def router_notification_device_register(device:Device_Create, db:AsyncSession=Depends(get_db)):
    return await Notification_Inbox_Service.services_notification_device_register(db, device)


# DELETE 푸시 기기 등록 해제
@router.delete('/devices/{p_d_id}')
async def router_notification_device_delete(p_d_id:int, db:AsyncSession=Depends(get_db)):
    return await Notification_Inbox_Service.services_notification_device_delete(db, p_d_id)
