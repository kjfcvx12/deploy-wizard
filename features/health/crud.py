from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import delete, func, or_, and_
from datetime import datetime

from features.health.models import Health_Check


class Health_Crud:

    # 헬스체크 결과 한 건 기록
    @staticmethod
    async def crud_health_create(db:AsyncSession, d_id:int, ok:bool, status_code:int|None=None, latency_ms:int|None=None, detail:str|None=None, checked_at:datetime|None=None) -> Health_Check:
        db_check=Health_Check(d_id=d_id, ok=ok, status_code=status_code, latency_ms=latency_ms, detail=detail)
        if checked_at is not None:
            db_check.checked_at=checked_at
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


    # 마지막 성공 이후 연속 실패 수 - checked_at, h_c_id 순서 기준. 성공이 한 번도 없으면 전부 센다
    @staticmethod
    async def crud_health_count_failures_after_last_ok(db:AsyncSession, d_id:int) -> int:
        last_ok=await db.execute(select(Health_Check.h_c_id)
                                 .where(Health_Check.d_id == d_id, Health_Check.ok.is_(True))
                                 .order_by(Health_Check.checked_at.desc(), Health_Check.h_c_id.desc())
                                 .limit(1))
        last_ok_id=last_ok.scalar()

        query=select(func.count(Health_Check.h_c_id)).where(Health_Check.d_id == d_id, Health_Check.ok.is_(False))
        if last_ok_id is not None:
            # 시각은 파라미터로 다시 묶지 않고 저장된 값 그대로 비교한다 (저장 형식이 달라도 어긋나지 않게)
            ok_at=select(Health_Check.checked_at).where(Health_Check.h_c_id == last_ok_id).scalar_subquery()
            query=query.where(or_(Health_Check.checked_at > ok_at,
                                  and_(Health_Check.checked_at == ok_at, Health_Check.h_c_id > last_ok_id)))

        result=await db.execute(query)
        return result.scalar() or 0


    # 마지막 실패 이후 연속 성공 수 - 순서 기준은 연속 실패 수와 같다 (checked_at, h_c_id). 실패가 한 번도 없으면 성공을 전부 센다
    @staticmethod
    async def crud_health_count_successes_after_last_failure(db:AsyncSession, d_id:int) -> int:
        last_fail=await db.execute(select(Health_Check.h_c_id)
                                   .where(Health_Check.d_id == d_id, Health_Check.ok.is_(False))
                                   .order_by(Health_Check.checked_at.desc(), Health_Check.h_c_id.desc())
                                   .limit(1))
        last_fail_id=last_fail.scalar()

        query=select(func.count(Health_Check.h_c_id)).where(Health_Check.d_id == d_id, Health_Check.ok.is_(True))
        if last_fail_id is not None:
            fail_at=select(Health_Check.checked_at).where(Health_Check.h_c_id == last_fail_id).scalar_subquery()
            query=query.where(or_(Health_Check.checked_at > fail_at,
                                  and_(Health_Check.checked_at == fail_at, Health_Check.h_c_id > last_fail_id)))

        result=await db.execute(query)
        return result.scalar() or 0


    # 기간 안의 결과 - 최신 size 건을 최신순으로 (서비스가 시간순으로 뒤집는다)
    @staticmethod
    async def crud_health_get_since(db:AsyncSession, d_id:int, since:datetime, size:int=1440) -> list[Health_Check]:
        result=await db.execute(select(Health_Check)
                                .where(Health_Check.d_id == d_id, Health_Check.checked_at >= since)
                                .order_by(Health_Check.checked_at.desc(), Health_Check.h_c_id.desc())
                                .limit(size))
        return result.scalars().all()


    # 오래된 결과 삭제 - cutoff 보다 이전 것만
    @staticmethod
    async def crud_health_delete_older_than(db:AsyncSession, cutoff:datetime) -> int:
        result=await db.execute(delete(Health_Check).where(Health_Check.checked_at < cutoff))
        await db.flush()
        return result.rowcount


    # 배포들(d_ids 는 목록이나 하위 쿼리)의 헬스체크 기록을 지운다 - 계정 삭제용. 반환: 지운 수
    @staticmethod
    async def crud_health_delete_by_d_ids(db:AsyncSession, d_ids) -> int:
        result=await db.execute(delete(Health_Check).where(Health_Check.d_id.in_(d_ids)).execution_options(synchronize_session=False))
        await db.flush()
        return result.rowcount
