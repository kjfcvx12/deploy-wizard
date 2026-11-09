from fastapi import APIRouter, Depends, Query

from sqlalchemy.ext.asyncio import AsyncSession

from shared.database import get_db

from features.incidents.scheme import Incident_Read, Incident_Detail
from features.incidents.services import Incident_Service


# /api/deploys/{d_id}/incidents 도 여기서 받는다 (deploys 라우터는 이 기능을 모른다)
router=APIRouter(prefix='/api',tags=['Incident'])


# GET 인시던트 목록 (최신순 100건)
@router.get('/incidents', response_model=list[Incident_Read])
async def router_incident_get_all(status:str|None=None, d_id:int|None=None, after:int|None=Query(None, ge=1), db:AsyncSession=Depends(get_db)):
    return await Incident_Service.services_incident_get_all(db, status, d_id, after)


# GET 인시던트 한 건과 복구 시도 이력
@router.get('/incidents/{i_id}', response_model=Incident_Detail)
async def router_incident_get_i_id(i_id:int, db:AsyncSession=Depends(get_db)):
    return await Incident_Service.services_incident_get_detail(db, i_id)


# GET 한 배포의 인시던트들
@router.get('/deploys/{d_id}/incidents', response_model=list[Incident_Read])
async def router_incident_get_by_deploy(d_id:int, after:int|None=Query(None, ge=1), db:AsyncSession=Depends(get_db)):
    return await Incident_Service.services_incident_get_by_deploy(db, d_id, after)
