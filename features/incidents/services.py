from sqlalchemy.ext.asyncio import AsyncSession

from features.incidents.crud import Incident_Crud


class Incident_Service:

    # 열린 인시던트 번호 조회 - 배포 d_id 마다 없으면 None (deploys 가 목록·상세에 채운다)
    @staticmethod
    async def services_incident_open_ids(db:AsyncSession, d_ids:list[int]) -> dict[int, int | None]:
        open_incidents=await Incident_Crud.crud_incident_get_open_by_d_ids(db, d_ids)
        return {d_id: (open_incidents[d_id].i_id if d_id in open_incidents else None) for d_id in d_ids}


    # 헬스체크 결과를 받아 인시던트를 열고 닫는다 - 다음 작업에서 채운다 (지금은 아무것도 하지 않는다)
    @staticmethod
    async def services_incident_on_result(db:AsyncSession, d_id:int, ok:bool) -> None:
        return None
