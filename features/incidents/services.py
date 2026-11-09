from sqlalchemy.ext.asyncio import AsyncSession

from features.incidents.crud import Incident_Crud


class Incident_Service:

    # 열린 인시던트 번호 조회 - 배포 d_id 마다 없으면 None (deploys 가 목록·상세에 채운다)
    @staticmethod
    async def services_incident_open_ids(db:AsyncSession, d_ids:list[int]) -> dict[int, int | None]:
        open_incidents=await Incident_Crud.crud_incident_get_open_by_d_ids(db, d_ids)
        return {d_id: (open_incidents[d_id].i_id if d_id in open_incidents else None) for d_id in d_ids}
