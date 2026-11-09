import json

from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import HTTPException, status

from features.notifications.crud import Notification_Crud
from features.notifications.models import Notification, Push_Device
from features.notifications.scheme import Device_Create, Device_Read, Notification_Setting_Read, Notification_Setting_Update
from features.notifications.services import Notification_Service
from features.notifications.dispatch import dispatch_scrub

# 앱이 부르는 쪽 - 앱 안 알림 목록·읽음, 기기 등록, 알림 설정 (docs/app-web/04-api-spec.md 4·5장)
# 로그인 전에는 u_id 가 항상 null 이라 사용자 필터가 없다 - 3단계에서 get_current_user 로 거른다

LIST_LIMIT=100


class Notification_Inbox_Service:

    # 앱 안 알림 목록 - 최신 100건, after(n_id)보다 오래된 것부터
    @staticmethod
    async def services_notification_get_all(db:AsyncSession, after:int|None=None, unread:bool=False) -> list[Notification]:
        return await Notification_Crud.crud_notification_list_inapp(db, after, unread, LIST_LIMIT)


    # 읽지 않은 수
    @staticmethod
    async def services_notification_unread_count(db:AsyncSession) -> dict:
        return {"count": await Notification_Crud.crud_notification_unread_count(db)}


    # 한 건 읽음 - 없거나 앱 안 알림이 아니면 404
    @staticmethod
    async def services_notification_read(db:AsyncSession, n_id:int) -> Notification:
        try:
            db_notification=await Notification_Crud.crud_notification_get_inapp(db, n_id)

            if db_notification is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                    detail='해당 id의 알림이 없습니다')

            await Notification_Crud.crud_notification_mark_read(db, db_notification, Notification_Service.services_notification_now())
            await db.commit()
            return db_notification

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"읽음 처리 실패 :{dispatch_scrub(str(e))}")


    # 모두 읽음
    @staticmethod
    async def services_notification_read_all(db:AsyncSession) -> dict:
        try:
            updated=await Notification_Crud.crud_notification_mark_all_read(db, Notification_Service.services_notification_now())
            await db.commit()
            return {"updated": updated}

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"모두 읽음 처리 실패 :{dispatch_scrub(str(e))}")


    # 기기 응답 - 토큰은 끝 6자리만 (Hard rule 6)
    @staticmethod
    def services_notification_device_read(db_device:Push_Device) -> Device_Read:
        return Device_Read(p_d_id=db_device.p_d_id, platform=db_device.platform, token_tail=db_device.expo_token[-6:],
                           created_at=db_device.created_at, last_seen_at=db_device.last_seen_at)


    # 기기 등록 - 같은 토큰이면 갱신해서 같은 기기를 돌려준다
    @staticmethod
    async def services_notification_device_register(db:AsyncSession, device:Device_Create) -> Device_Read:
        try:
            db_device=await Notification_Crud.crud_notification_device_get_by_token(db, device.expo_token)

            if db_device is None:
                db_device=await Notification_Crud.crud_notification_device_create(db, device.expo_token, device.platform)
            else:
                await Notification_Crud.crud_notification_device_touch(db, db_device, device.platform, Notification_Service.services_notification_now())

            await db.commit()
            await db.refresh(db_device)
            return Notification_Inbox_Service.services_notification_device_read(db_device)

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"기기 등록 실패 :{dispatch_scrub(str(e))}")


    # 기기 등록 해제 - 없으면 404
    @staticmethod
    async def services_notification_device_delete(db:AsyncSession, p_d_id:int) -> dict:
        try:
            db_device=await Notification_Crud.crud_notification_device_get_by_p_d_id(db, p_d_id)

            if db_device is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                    detail='해당 id의 기기가 없습니다')

            await Notification_Crud.crud_notification_device_delete(db, db_device)
            await db.commit()
            return {"message": "기기 등록을 해제했습니다"}

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"기기 해제 실패 :{dispatch_scrub(str(e))}")


    # 알림 설정 응답
    @staticmethod
    async def services_notification_setting_read(db:AsyncSession) -> Notification_Setting_Read:
        db_setting=await Notification_Service.services_notification_setting_get(db)
        return Notification_Setting_Read(notify_email=db_setting.notify_email, notify_push=db_setting.notify_push,
                                         kinds=Notification_Service.services_notification_kinds(db_setting))


    # 알림 설정 수정 - 보낸 항목만 바꾼다
    @staticmethod
    async def services_notification_setting_update(db:AsyncSession, update:Notification_Setting_Update) -> Notification_Setting_Read:
        try:
            db_setting=await Notification_Service.services_notification_setting_get(db)

            if update.notify_email is not None:
                db_setting.notify_email=update.notify_email
            if update.notify_push is not None:
                db_setting.notify_push=update.notify_push
            if update.kinds is not None:
                db_setting.kinds=json.dumps(update.kinds)

            await db.commit()
            return await Notification_Inbox_Service.services_notification_setting_read(db)

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"알림 설정 수정 실패 :{dispatch_scrub(str(e))}")
