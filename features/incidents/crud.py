from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import update, delete, func
from datetime import datetime

from shared.database import Base

from features.incidents.models import Incident, Recovery_Action
from features.incidents.scheme import INCIDENT_UNRESOLVED_STATUSES


# 주인 조건 - incidents 에는 u_id 가 없고 배포(deploys.u_id)를 따라간다. u_id 가 None(인증 끔·백그라운드)이면 그대로
# deploys 모델은 다른 기능이라 import 하지 않고 같은 Base 에 올라간 표를 쓴다
def incident_owner_where(query, u_id:int|None):
    if u_id is None:
        return query

    deploys=Base.metadata.tables["deploys"]
    return query.join(deploys, deploys.c.d_id == Incident.d_id).where(deploys.c.u_id == u_id)


class Incident_Crud:

    # 배포들의 끝나지 않은(open|recovering|needs_action) 인시던트 중 가장 최근 것 - 배포마다 최대 하나
    @staticmethod
    async def crud_incident_get_open_by_d_ids(db:AsyncSession, d_ids:list[int]) -> dict[int, Incident]:
        if not d_ids:
            return {}

        result=await db.execute(select(Incident)
                                .where(Incident.d_id.in_(d_ids), Incident.status.in_(INCIDENT_UNRESOLVED_STATUSES))
                                .order_by(Incident.i_id.asc()))

        # i_id 오름차순으로 덮어쓰므로 마지막(가장 최근) 것이 남는다
        return {incident.d_id: incident for incident in result.scalars().all()}


    # 인시던트 i_id 찾기 - u_id 를 주면 그 사용자 배포의 것일 때만
    @staticmethod
    async def crud_incident_get_by_i_id(db:AsyncSession, i_id:int, u_id:int|None=None) -> Incident | None:
        result=await db.execute(incident_owner_where(select(Incident).where(Incident.i_id == i_id), u_id))
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


    # 인시던트 목록 - 최신순, after 는 i_id 커서(그보다 오래된 것만). u_id 를 주면 그 사용자 배포의 것만
    @staticmethod
    async def crud_incident_list(db:AsyncSession, status:str|None=None, d_id:int|None=None, after:int|None=None, limit:int=100, u_id:int|None=None) -> list[Incident]:
        query=incident_owner_where(select(Incident), u_id)

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


    # 배포가 since 이후에 한 자동 복구 시도 수 - 하루 한도를 셀 때 쓴다 (모든 인시던트의 시도를 합친다)
    @staticmethod
    async def crud_incident_action_count_since(db:AsyncSession, d_id:int, since:datetime) -> int:
        result=await db.execute(select(func.count(Recovery_Action.r_a_id))
                                .join(Incident, Incident.i_id == Recovery_Action.i_id)
                                .where(Incident.d_id == d_id, Recovery_Action.started_at >= since))
        return result.scalar() or 0


    # 복구 시도 한 줄 시작 - result 는 running
    @staticmethod
    async def crud_incident_action_create(db:AsyncSession, i_id:int, action:str, d_r_id:int|None=None, started_at:datetime|None=None) -> Recovery_Action:
        db_action=Recovery_Action(i_id=i_id, action=action, d_r_id=d_r_id, result='running')
        if started_at is not None:
            db_action.started_at=started_at
        db.add(db_action)
        await db.flush()
        return db_action


    # 복구 시도 끝내기 - 아직 running 인 줄만 바꾼다
    @staticmethod
    async def crud_incident_action_finish(db:AsyncSession, r_a_id:int, result_value:str, detail:str|None, finished_at:datetime) -> int:
        result=await db.execute(update(Recovery_Action)
                                .where(Recovery_Action.r_a_id == r_a_id, Recovery_Action.result == 'running')
                                .values(result=result_value, detail=detail, finished_at=finished_at)
                                .execution_options(synchronize_session=False))
        await db.flush()
        return result.rowcount


    # 인시던트의 멈춘(running) 복구 시도를 실패로 정리 - 서버가 꺼져 끊긴 것. action 을 주면 그 종류만
    @staticmethod
    async def crud_incident_action_fail_running(db:AsyncSession, i_id:int, detail:str, finished_at:datetime, action:str|None=None) -> int:
        query=update(Recovery_Action).where(Recovery_Action.i_id == i_id, Recovery_Action.result == 'running')
        if action is not None:
            query=query.where(Recovery_Action.action == action)

        result=await db.execute(query
                                .values(result='failed', detail=detail, finished_at=finished_at)
                                .execution_options(synchronize_session=False))
        await db.flush()
        return result.rowcount


    # 상태별 인시던트 - i_id 오름차순 (서버를 다시 켤 때 끊긴 것을 찾는다)
    @staticmethod
    async def crud_incident_get_by_statuses(db:AsyncSession, statuses:tuple[str, ...]) -> list[Incident]:
        result=await db.execute(select(Incident).where(Incident.status.in_(statuses)).order_by(Incident.i_id.asc()))
        return result.scalars().all()


    # 배포의 가장 최근 복구 시도 - 모든 인시던트를 통틀어 (시작 시각, 번호 내림차순)
    @staticmethod
    async def crud_incident_action_latest_by_d_id(db:AsyncSession, d_id:int) -> Recovery_Action | None:
        result=await db.execute(select(Recovery_Action)
                                .join(Incident, Incident.i_id == Recovery_Action.i_id)
                                .where(Incident.d_id == d_id)
                                .order_by(Recovery_Action.started_at.desc(), Recovery_Action.r_a_id.desc())
                                .limit(1))
        return result.scalars().first()


    # 배포의 다른 인시던트에 running 으로 남은 되돌리기 시도 중 가장 최근 것 - 끝내지 못하고 멈춘 시도
    @staticmethod
    async def crud_incident_action_running_rollback_other(db:AsyncSession, d_id:int, i_id:int) -> Recovery_Action | None:
        result=await db.execute(select(Recovery_Action)
                                .join(Incident, Incident.i_id == Recovery_Action.i_id)
                                .where(Incident.d_id == d_id, Recovery_Action.i_id != i_id,
                                       Recovery_Action.action == 'rollback', Recovery_Action.result == 'running')
                                .order_by(Recovery_Action.started_at.desc(), Recovery_Action.r_a_id.desc())
                                .limit(1))
        return result.scalars().first()


    # 배포들의 인시던트와 복구 기록을 지운다 (복구 기록이 자식이라 먼저) - 계정 삭제용. 반환: 지운 인시던트 수
    @staticmethod
    async def crud_incident_delete_by_d_ids(db:AsyncSession, d_ids:list[int]) -> int:
        if not d_ids:
            return 0

        i_ids=select(Incident.i_id).where(Incident.d_id.in_(d_ids))
        await db.execute(delete(Recovery_Action).where(Recovery_Action.i_id.in_(i_ids)).execution_options(synchronize_session=False))

        result=await db.execute(delete(Incident).where(Incident.d_id.in_(d_ids)).execution_options(synchronize_session=False))
        await db.flush()
        return result.rowcount
