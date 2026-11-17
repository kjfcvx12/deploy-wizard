from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, delete

from features.envvars.models import Deploy_Env_Var
from features.envvars.scheme import Env_Found


class Env_Crud:

    # 배포의 환경변수 전부 조회 (이름순)
    @staticmethod
    async def crud_env_get_by_d_id(db:AsyncSession, d_id:int) -> list[Deploy_Env_Var]:
        result=await db.execute(select(Deploy_Env_Var)
                                .where(Deploy_Env_Var.d_id == d_id)
                                .order_by(Deploy_Env_Var.name))
        return result.scalars().all()


    # 배포 d_id + 이름으로 한 건 찾기
    @staticmethod
    async def crud_env_get(db:AsyncSession, d_id:int, name:str) -> Deploy_Env_Var | None:
        result=await db.execute(select(Deploy_Env_Var)
                                .where(Deploy_Env_Var.d_id == d_id, Deploy_Env_Var.name == name))
        return result.scalars().first()


    # 스캔 결과 반영 - 없으면 넣고, 있으면 사용자 입력(status/storage/값)은 두고 발견 정보만 갱신
    @staticmethod
    async def crud_env_upsert_found(db:AsyncSession, d_id:int, found:Env_Found) -> Deploy_Env_Var:
        db_env=await Env_Crud.crud_env_get(db, d_id, found.name)

        if db_env is None:
            db_env=Deploy_Env_Var(d_id=d_id, **found.model_dump(), status='detected', storage='none')
            db.add(db_env)

        else:
            db_env.required=found.required
            db_env.has_default=found.has_default
            db_env.source=found.source
            db_env.source_hint=found.source_hint

            # 종류는 아직 모를 때만 재스캔이 채운다
            if db_env.kind == 'unknown':
                db_env.kind=found.kind

        await db.flush()
        return db_env


    # 환경변수 업데이트 - 사용자 입력·종류 변경·건너뛰기
    @staticmethod
    async def crud_env_update(db:AsyncSession, d_id:int, name:str, update_data:dict) -> Deploy_Env_Var | None:
        db_env=await Env_Crud.crud_env_get(db, d_id, name)

        if db_env:

            for key, value in update_data.items():
                setattr(db_env, key, value)

            await db.flush()
            return db_env

        return None


    # 값 입력이 필요한 환경변수 개수 - 필수이고 아직 detected 인 것만
    @staticmethod
    async def crud_env_count_pending(db:AsyncSession, d_id:int) -> int:
        result=await db.execute(select(func.count())
                                .select_from(Deploy_Env_Var)
                                .where(Deploy_Env_Var.d_id == d_id,
                                       Deploy_Env_Var.required.is_(True),
                                       Deploy_Env_Var.status == 'detected'))
        return result.scalar_one()


    # 여러 배포의 입력 필요 개수를 한 번에 - 행이 없는 배포는 0
    @staticmethod
    async def crud_env_count_pending_many(db:AsyncSession, d_ids:list[int]) -> dict[int, int]:
        counts={d_id: 0 for d_id in d_ids}

        if not d_ids:
            return counts

        result=await db.execute(select(Deploy_Env_Var.d_id, func.count())
                                .where(Deploy_Env_Var.d_id.in_(d_ids),
                                       Deploy_Env_Var.required.is_(True),
                                       Deploy_Env_Var.status == 'detected')
                                .group_by(Deploy_Env_Var.d_id))

        for d_id, count in result.all():
            counts[d_id]=count

        return counts


    # 배포들(d_ids 는 목록이나 하위 쿼리)의 환경변수 기록을 지운다 - 계정 삭제용. 반환: 지운 수
    @staticmethod
    async def crud_env_delete_by_d_ids(db:AsyncSession, d_ids) -> int:
        result=await db.execute(delete(Deploy_Env_Var).where(Deploy_Env_Var.d_id.in_(d_ids)).execution_options(synchronize_session=False))
        await db.flush()
        return result.rowcount
