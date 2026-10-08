from fastapi import APIRouter, Depends, Header, Request

from sqlalchemy.ext.asyncio import AsyncSession

from shared.database import get_db

from features.watches.scheme import Watch_Ack
from features.watches.services import Watch_Service

router=APIRouter(prefix='/api/watches', tags=['Watches'])


# POST GitHub 웹훅 - push 이벤트만 처리, 서명 검증 필수
@router.post('/webhook', response_model=Watch_Ack, include_in_schema=False)
async def router_watch_webhook(request:Request,
                               x_hub_signature_256:str|None=Header(None, alias="X-Hub-Signature-256"),
                               x_github_event:str|None=Header(None, alias="X-GitHub-Event"),
                               db:AsyncSession=Depends(get_db)):
    raw_body=await request.body()
    return await Watch_Service.services_watch_receive(db, raw_body, x_hub_signature_256, x_github_event)
