from fastapi import APIRouter, Depends

from sqlalchemy.ext.asyncio import AsyncSession

from shared.database import get_db

from features.auth.scheme import Current_User
from features.auth.services import Auth_Service
from features.advice.scheme import Advice_Request, Deploy_Advice
from features.advice.services import Advice_Service


router=APIRouter(prefix='/api/deploys',tags=['Advice'])


# POST 배포 전 분석 - 레포를 읽기만 한다 (배포 기록·AWS 호출 없음)
@router.post('/advice', response_model=Deploy_Advice)
async def router_advice_analyze(req: Advice_Request, db: AsyncSession = Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Advice_Service.services_advice_analyze(db, req, user.u_id)
