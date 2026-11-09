from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from features.incidents.models import Incident
from features.incidents.scheme import INCIDENT_ACTIVE_STATUSES


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
