from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from features.notifications.models import Notification, Notification_Setting


class Notification_Crud:

    # 알림 한 줄 쌓기
    @staticmethod
    async def crud_notification_create(db:AsyncSession, data:dict) -> Notification:
        db_notification=Notification(**data)
        db.add(db_notification)
        await db.flush()
        return db_notification


    # 알림 설정 조회 - 한 줄뿐인 표라 없으면 기본값으로 만든다
    @staticmethod
    async def crud_notification_setting_get(db:AsyncSession) -> Notification_Setting:
        result=await db.execute(select(Notification_Setting).where(Notification_Setting.id == 1))
        db_setting=result.scalars().first()

        if db_setting is None:
            db_setting=Notification_Setting(id=1)
            db.add(db_setting)
            await db.flush()

        return db_setting
