import asyncio
import logging

from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import HTTPException

from shared.database import AsyncSessionLocal
from shared.masking import mask_text

from features.incidents.crud import Incident_Crud
from features.incidents.services import Incident_Service, EVIDENCE_MAX

# 자동 복구의 기록·재개 쪽 - recovery.py 가 너무 길어져 나눴다 (Recovery_Service 가 같은 이름으로 다시 내보낸다)
# deploys 서비스는 이 파일을 거꾸로 import 하는 쪽과 순환하므로 쓰는 함수 안에서 불러온다

logger=logging.getLogger(__name__)

DETAIL_MAX=500

RESUME_DETAIL="서버가 다시 시작되어 자동 복구가 중단되었습니다"
RESUME_SKIP_DETAIL="서버가 다시 시작되었고 자동 복구를 이어갈 수 없는 상태라 확인이 필요합니다"
BOOKKEEPING_DETAIL="AWS는 이전 이미지로 되돌아갔지만 배포 기록 반영에 실패했습니다"
# 되돌리기 갱신을 AWS 에 보냈는데 기록 반영이 끝나지 않은 모든 경우의 표식 (검증 실패·대기 시간 초과·서버 재시작)
UNRECORDED_DETAIL="AWS에 이전 이미지로 되돌리는 요청을 보냈지만 배포 기록에는 반영하지 못했습니다"
BOOKKEEPING_MARKERS=(BOOKKEEPING_DETAIL, UNRECORDED_DETAIL)
BOOKKEEPING_TRIES=3
BOOKKEEPING_RETRY_SECONDS=1


class Recovery_State:

    # 되돌리기 표식이 붙은 detail 인지 - 이후 자동 복구를 막는 근거
    @staticmethod
    def services_recovery_is_unrecorded(detail:str | None) -> bool:
        return (detail or "").startswith(BOOKKEEPING_MARKERS)


    # 표식 붙이기 - 이미 붙어 있으면 그대로 둔다
    @staticmethod
    def services_recovery_mark_unrecorded(detail:str | None) -> str:
        if Recovery_State.services_recovery_is_unrecorded(detail):
            return (detail or "")[:DETAIL_MAX]

        return mask_text(f"{UNRECORDED_DETAIL} ({detail})" if detail else UNRECORDED_DETAIL)[:DETAIL_MAX]


    # 되돌리기 결과를 배포 기록에 반영 - 새 세션에서 3번까지 다시 시도한다. 성공이면 None, 아니면 사용자에게 보일 이유
    # expected_image_uri 는 복구를 시작할 때의 이미지 - 그 사이 배포가 바뀌었으면 반영하지 않는다 (다시 시도하지도 않는다)
    @staticmethod
    async def services_recovery_apply_rollback(d_id:int, rel_id:int | None, expected_image_uri:str | None, sleeper=None) -> str | None:
        from features.deploys.services import Deploy_Service, DEPLOY_CHANGED_DETAIL

        sleep=sleeper or asyncio.sleep
        last=None

        for attempt in range(BOOKKEEPING_TRIES):
            try:
                async with AsyncSessionLocal() as fresh:
                    target=await Deploy_Service.services_deploy_release_rollback_target(fresh, d_id)
                    if target is None or target.d_r_id != rel_id:
                        raise HTTPException(status_code=409, detail=DEPLOY_CHANGED_DETAIL)
                    await Deploy_Service.services_deploy_apply_rollback(fresh, d_id, target, expected_image_uri)
                return None

            except HTTPException as e:
                if e.status_code == 409 and e.detail == DEPLOY_CHANGED_DETAIL:
                    return DEPLOY_CHANGED_DETAIL
                last=e.detail

            except Exception as e:
                last=f"{type(e).__name__}: {e}"

            if attempt < BOOKKEEPING_TRIES - 1:
                await sleep(BOOKKEEPING_RETRY_SECONDS)

        return mask_text(f"{BOOKKEEPING_DETAIL} ({last})")[:DETAIL_MAX]


    # 포기 - 이유를 evidence 끝에 덧붙이고 needs_action (알림은 needs_action 전환이 보낸다)
    @staticmethod
    async def services_recovery_give_up(db:AsyncSession, i_id:int, reason:str) -> None:
        incident=await Incident_Crud.crud_incident_get_by_i_id(db, i_id)
        if incident is None:
            return

        await db.refresh(incident)
        evidence=f"{incident.evidence or ''}\n자동 복구: {mask_text(reason)}".strip()[-EVIDENCE_MAX:]
        await Incident_Service.services_incident_needs_action(db, i_id, {"evidence": evidence})


    # 서버를 다시 켤 때 - 끊긴 인시던트를 정리한다. recovering 은 needs_action, 처리 중이던 open 은 배포가 running·자동 복구 켜짐이면 처리를 다시 띄우고 아니면 needs_action
    # 멈춰 있던 되돌리기 시도는 AWS 에 갔는지 알 수 없으므로 모두 표식을 붙여, 기록과 AWS 가 어긋났을 수 있는 배포에 자동 복구가 더 일어나지 않게 한다
    @staticmethod
    async def services_recovery_resume(db:AsyncSession) -> int:
        from features.deploys.services import Deploy_Service

        handled=0
        stuck=[(incident.i_id, incident.d_id, incident.status) for incident in await Incident_Crud.crud_incident_get_by_statuses(db, ('recovering', 'open'))]

        for i_id, d_id, status_value in stuck:
            try:
                if status_value == 'recovering':
                    now=Incident_Service.services_incident_now()
                    await Incident_Crud.crud_incident_action_fail_running(db, i_id, Recovery_State.services_recovery_mark_unrecorded(RESUME_DETAIL), now, 'rollback')
                    await Incident_Crud.crud_incident_action_fail_running(db, i_id, RESUME_DETAIL, now)
                    await db.commit()
                    await Recovery_State.services_recovery_give_up(db, i_id, RESUME_DETAIL)
                    handled+=1
                    continue

                try:
                    deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)
                    await db.refresh(deploy)
                    resumable=deploy.status == 'running' and deploy.auto_recover
                except HTTPException:
                    resumable=False

                if resumable:
                    Incident_Service.services_incident_spawn(i_id)
                else:
                    await Recovery_State.services_recovery_give_up(db, i_id, RESUME_SKIP_DETAIL)
                handled+=1

            except Exception as e:
                await db.rollback()
                logger.warning("인시던트 정리 실패 i_id=%s : %s", i_id, mask_text(str(e))[:200])

        return handled
