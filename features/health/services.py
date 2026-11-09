from sqlalchemy.ext.asyncio import AsyncSession

from features.health.crud import Health_Crud
from features.health.models import Health_Check


class Health_Service:

    # 배포의 최근 헬스체크 조회 - 최신순 (모니터 루프는 다음 작업에서 이 서비스에 붙는다)
    @staticmethod
    async def services_health_get_recent(db:AsyncSession, d_id:int, size:int=10) -> list[Health_Check]:
        return await Health_Crud.crud_health_get_recent(db, d_id, size)
