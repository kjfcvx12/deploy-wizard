from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import update, func
from datetime import datetime

from features.incidents.models import Incident, Recovery_Action
from features.incidents.scheme import INCIDENT_ACTIVE_STATUSES, INCIDENT_UNRESOLVED_STATUSES


class Incident_Crud:

    # 배포들의 열린(open|recovering) 인시던트 중 가장 최근 것 - 배포마다 최대 하나
    @staticmethod
    async def crud_incident_get_open_by_d_ids(db:AsyncSession, d_ids:list[int]) -> dict[int, Incident]:
        if not d_ids:
            return {}

        result=await db.execute(select(Incident)
                                .where(Incident.d_id.in_(d_ids), Incident.status.in_(INCIDENT_ACTIVE_STATUSES))
                                .order_by(Incident.i_id.asc()))

        # i_id 오름차순으로 덮어쓰므로 마지막(가장 최근) 것이 남는다
        return {incident.d_id: incident for incident in result.scalars().all()}


    # 인시던트 i_id 찾기
    @staticmethod
    async def crud_incident_get_by_i_id(db:AsyncSession, i_id:int) -> Incident | None:
        result=await db.execute(select(Incident).where(Incident.i_id == i_id))
        return result.scalars().first()


    # 배포의 끝나지 않은(open|recovering|needs_action) 인시던트 중 가장 최근 것
    @staticmethod
    async def crud_incident_get_unresolved_by_d_id(db:AsyncSession, d_id:int) -> Incident | None:
        result=await db.execute(select(Incident)
                                .where(Incident.d_id == d_id, Incident.status.in_(INCIDENT_UNRESOLVED_STATUSES))
                                .order_by(Incident.i_id.desc())
                                .limit(1))
        return result.scalars().first()


    # 인시던트 만들기 - status 는 open
    @staticmethod
    async def crud_incident_create(db:AsyncSession, d_id:int, kind:str, summary:str, detected_at:datetime|None=None) -> Incident:
        db_incident=Incident(d_id=d_id, kind=kind, status='open', summary=summary)
        if detected_at is not None:
            db_incident.detected_at=detected_at
        db.add(db_incident)
        await db.flush()
        return db_incident


    # 상태가 from_statuses 중 하나일 때만 바꾼다 - 동시에 다른 쪽이 먼저 바꿨으면 0 (덮어쓰지 않는다)
    @staticmethod
    async def crud_incident_transition(db:AsyncSession, i_id:int, from_statuses:tuple[str, ...], to_status:str, values:dict|None=None) -> int:
        result=await db.execute(update(Incident)
                                .where(Incident.i_id == i_id, Incident.status.in_(from_statuses))
                                .values(status=to_status, **(values or {}))
                                .execution_options(synchronize_session=False))
        await db.flush()
        return result.rowcount


    # 내용(원인 설명 등)만 바꾼다 - 상태는 건드리지 않는다
    @staticmethod
    async def crud_incident_update_fields(db:AsyncSession, i_id:int, values:dict) -> int:
        result=await db.execute(update(Incident)
                                .where(Incident.i_id == i_id)
                                .values(**values)
                                .execution_options(synchronize_session=False))
        await db.flush()
        return result.rowcount


    # 인시던트 목록 - 최신순, after 는 i_id 커서(그보다 오래된 것만)
    @staticmethod
    async def crud_incident_list(db:AsyncSession, status:str|None=None, d_id:int|None=None, after:int|None=None, limit:int=100) -> list[Incident]:
        query=select(Incident)

        if status is not None:
            query=query.where(Incident.status == status)
        if d_id is not None:
            query=query.where(Incident.d_id == d_id)
        if after is not None:
            query=query.where(Incident.i_id < after)

        result=await db.execute(query.order_by(Incident.i_id.desc()).limit(limit))
        return result.scalars().all()


    # 인시던트의 복구 시도 - 시작 시각순
    @staticmethod
    async def crud_incident_action_list(db:AsyncSession, i_id:int) -> list[Recovery_Action]:
        result=await db.execute(select(Recovery_Action)
                                .where(Recovery_Action.i_id == i_id)
                                .order_by(Recovery_Action.started_at.asc(), Recovery_Action.r_a_id.asc()))
        return result.scalars().all()


    # 인시던트의 복구 시도 수
    @staticmethod
    async def crud_incident_action_count(db:AsyncSession, i_id:int) -> int:
        result=await db.execute(select(func.count(Recovery_Action.r_a_id)).where(Recovery_Action.i_id == i_id))
        return result.scalar() or 0
