from sqlalchemy.ext.asyncio import AsyncSession


class Notification_Service:

    # 인시던트 알림 보내기 - 아직 아무것도 하지 않는다 (알림 작업에서 메일·푸시·앱 안 알림으로 채운다)
    @staticmethod
    async def services_notification_send_incident(db:AsyncSession, incident, kind:str) -> None:
        return None
