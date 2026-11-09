from sqlalchemy.ext.asyncio import AsyncSession


class Recovery_Service:

    # 자동 복구 시작 - 아직 아무것도 하지 않는다 (복구 작업에서 재시작·되돌리기로 채운다)
    @staticmethod
    async def services_recovery_start(db:AsyncSession, i_id:int) -> None:
        return None
