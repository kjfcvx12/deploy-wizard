from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from features.health.models import Health_Check


class Health_Crud:

    # 헬스체크 결과 한 건 기록
    @staticmethod
    async def crud_health_create(db:AsyncSession, d_id:int, ok:bool, status_code:int|None=None, latency_ms:int|None=None, detail:str|None=None) -> Health_Check:
        db_check=Health_Check(d_id=d_id, ok=ok, status_code=status_code, latency_ms=latency_ms, detail=detail)
        db.add(db_check)
        await db.flush()
        return db_check


    # 배포의 가장 최근 결과 - 최신순으로 size 건
    @staticmethod
    async def crud_health_get_recent(db:AsyncSession, d_id:int, size:int=10) -> list[Health_Check]:
        result=await db.execute(select(Health_Check)
                                .where(Health_Check.d_id == d_id)
                                .order_by(Health_Check.h_c_id.desc())
                                .limit(size))
        return result.scalars().all()
