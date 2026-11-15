from fastapi import APIRouter, HTTPException, status

from shared.settings import settings

from features.pricing.scheme import Cost_Estimate, Estimate_Request, Pricing_Options
from features.pricing.services import Pricing_Service


router=APIRouter(prefix='/api/pricing',tags=['Pricing'])


# GET 사양 프리셋과 사용 기간 선택지
@router.get('/options', response_model=Pricing_Options)
async def router_pricing_options():
    return Pricing_Options(specs=Pricing_Service.services_pricing_spec_options(), plans=Pricing_Service.services_pricing_plans())


# POST 비용 추정 - 값 검사는 여기서 하고(400), 가격 표를 못 얻으면 503
@router.post('/estimate', response_model=Cost_Estimate)
async def router_pricing_estimate(req: Estimate_Request):
    # 빈 글자·공백만 있는 사양은 비어 있는 것으로 본다
    cpu=req.cpu if req.cpu is not None and req.cpu.strip() else None
    memory=req.memory if req.memory is not None and req.memory.strip() else None

    message=Pricing_Service.services_pricing_request_error(cpu, memory, req.planned_hours, req.max_tasks, settings.max_tasks_cap)
    if message:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=message)

    table=await Pricing_Service.services_pricing_table()
    if table is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="가격 정보를 가져오지 못했습니다. 잠시 뒤 다시 시도하세요")

    planned_hours=None if req.planned_hours is None else float(req.planned_hours)
    return Pricing_Service.services_pricing_estimate(table, cpu, memory, planned_hours, req.max_tasks)
