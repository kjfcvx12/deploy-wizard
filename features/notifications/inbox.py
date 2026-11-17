import json

from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import HTTPException, status

from shared.secrets import blind_index

from features.notifications.crud import Notification_Crud
from features.notifications.models import Notification, Push_Device, NOTIFICATION_KINDS_VERSION
from features.notifications.scheme import Device_Create, Device_Read, Notification_Setting_Read, Notification_Setting_Update
from features.notifications.services import Notification_Service
from features.notifications.dispatch import dispatch_scrub

# 앱이 부르는 쪽 - 앱 안 알림 목록·읽음, 기기 등록, 알림 설정 (docs/app-web/04-api-spec.md 4·5장)
# u_id 는 현재 사용자 (인증 끔이면 None - 사용자 필터 없이 지금처럼). 남의 알림·기기는 없는 것과 같이 404

LIST_LIMIT=100


class Notification_Inbox_Service:

    # 앱 안 알림 목록 - 최신 100건, after(n_id)보다 오래된 것부터. 내 것만
    @staticmethod
    async def services_notification_get_all(db:AsyncSession, after:int|None=None, unread:bool=False, u_id:int|None=None) -> list[Notification]:
        return await Notification_Crud.crud_notification_list_inapp(db, after, unread, LIST_LIMIT, u_id)


    # 읽지 않은 수 - 내 것만
    @staticmethod
    async def services_notification_unread_count(db:AsyncSession, u_id:int|None=None) -> dict:
        return {"count": await Notification_Crud.crud_notification_unread_count(db, u_id)}


    # 한 건 읽음 - 없거나 앱 안 알림이 아니거나 남의 것이면 404
    @staticmethod
    async def services_notification_read(db:AsyncSession, n_id:int, u_id:int|None=None) -> Notification:
        try:
            db_notification=await Notification_Crud.crud_notification_get_inapp(db, n_id, u_id)

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


    # 모두 읽음 - 내 것만
    @staticmethod
    async def services_notification_read_all(db:AsyncSession, u_id:int|None=None) -> dict:
        try:
            updated=await Notification_Crud.crud_notification_mark_all_read(db, Notification_Service.services_notification_now(), u_id)
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


    # 기기 등록 - 같은 토큰(블라인드 인덱스)이면 갱신해서 같은 기기를 돌려준다. 다른 사용자가 같은 토큰을 등록하면 그 사용자 기기로 옮긴다 (기기 주인이 바뀐 것)
    @staticmethod
    async def services_notification_device_register(db:AsyncSession, device:Device_Create, u_id:int|None=None) -> Device_Read:
        try:
            db_device=await Notification_Crud.crud_notification_device_get_by_bidx(db, blind_index("expo_token", device.expo_token))

            if db_device is None:
                db_device=await Notification_Crud.crud_notification_device_create(db, device.expo_token, device.platform, u_id)
            else:
                await Notification_Crud.crud_notification_device_touch(db, db_device, device.platform, Notification_Service.services_notification_now(), u_id)

            await db.commit()
            await db.refresh(db_device)
            return Notification_Inbox_Service.services_notification_device_read(db_device)

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"기기 등록 실패 :{dispatch_scrub(str(e))}")


    # 기기 등록 해제 - 없거나 남의 기기면 404
    @staticmethod
    async def services_notification_device_delete(db:AsyncSession, p_d_id:int, u_id:int|None=None) -> dict:
        try:
            db_device=await Notification_Crud.crud_notification_device_get_by_p_d_id(db, p_d_id, u_id)

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


    # 알림 설정 응답 - 내 설정 (인증 끔이면 id=1 줄)
    @staticmethod
    async def services_notification_setting_read(db:AsyncSession, u_id:int|None=None) -> Notification_Setting_Read:
        db_setting=await Notification_Service.services_notification_setting_get(db, u_id)
        return Notification_Setting_Read(notify_email=db_setting.notify_email, notify_push=db_setting.notify_push,
                                         kinds=Notification_Service.services_notification_kinds(db_setting))


    # 알림 설정 수정 - 보낸 항목만 바꾼다. 내 설정만
    @staticmethod
    async def services_notification_setting_update(db:AsyncSession, update:Notification_Setting_Update, u_id:int|None=None) -> Notification_Setting_Read:
        try:
            db_setting=await Notification_Service.services_notification_setting_get(db, u_id)

            if update.notify_email is not None:
                db_setting.notify_email=update.notify_email
            if update.notify_push is not None:
                db_setting.notify_push=update.notify_push
            if update.kinds is not None:
                db_setting.kinds=json.dumps(update.kinds)
                db_setting.kinds_version=NOTIFICATION_KINDS_VERSION

            await db.commit()
            return await Notification_Inbox_Service.services_notification_setting_read(db, u_id)

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"알림 설정 수정 실패 :{dispatch_scrub(str(e))}")
