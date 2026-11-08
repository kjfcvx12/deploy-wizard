from fastapi import APIRouter, Depends

from sqlalchemy.ext.asyncio import AsyncSession

from shared.database import get_db

from features.envvars.scheme import Env_Read, Env_Update
from features.envvars.services import Env_Service


router=APIRouter(prefix='/api/deploys/{d_id}/env',tags=['Env'])


# GET 배포의 환경변수 목록 (값은 싣지 않는다)
@router.get('', response_model=list[Env_Read])
async def router_env_get_all(d_id: int, db: AsyncSession = Depends(get_db)):
    return await Env_Service.services_env_get_all(db, d_id)


# PUT 값 입력·종류 지정·건너뛰기
@router.put('/{name}', response_model=Env_Read)
async def router_env_update(d_id: int, name: str, body: Env_Update, db: AsyncSession = Depends(get_db)):
    return await Env_Service.services_env_update(db, d_id, name, body)


# DELETE 저장된 값 지우기
@router.delete('/{name}/value', response_model=Env_Read)
async def router_env_clear_value(d_id: int, name: str, db: AsyncSession = Depends(get_db)):
    return await Env_Service.services_env_clear_value(db, d_id, name)
