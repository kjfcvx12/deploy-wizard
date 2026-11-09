import asyncio
import logging
from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import HTTPException

from shared.settings import settings
from shared.masking import mask_text
from shared.keyed_lock import keyed_lock

from features.incidents.crud import Incident_Crud
from features.incidents.models import Incident
from features.incidents.scheme import INCIDENT_ACTIVE_STATUSES
from features.incidents.services import Incident_Service
from features.incidents.recovery_state import (Recovery_State, DETAIL_MAX, RESUME_DETAIL, RESUME_SKIP_DETAIL, BOOKKEEPING_DETAIL, UNRECORDED_DETAIL,
                                               BOOKKEEPING_TRIES, BOOKKEEPING_RETRY_SECONDS)
from features.express.services import Express_Service
from features.accounts.services import Aws_Account_Service
from features.envvars.services import Env_Service

# 자동 복구 (D1) - CLAUDE.md Hard rule 3: 자동으로 하는 것은 재시작(같은 이미지로 갱신)과 직전 정상 이미지로 되돌리기 둘뿐이다.
# 삭제·사양 변경·크기 조절은 하지 않는다. 호출하는 AWS API 는 update_express_gateway_service 하나 (docs/aws-notes.md "운영 복구")
# deploys / health 서비스는 이 파일을 거꾸로 import 하는 쪽과 순환하므로 쓰는 함수 안에서 불러온다
# 기록 반영 재시도·포기·서버 재개는 recovery_state.py 에 있고, 아래 Recovery_Service 가 같은 이름으로 다시 내보낸다

logger=logging.getLogger(__name__)

# 배포별 잠금 - 같은 배포에 재시작·되돌리기가 겹쳐 돌지 않게 (이벤트 루프마다 따로 두고, 다 쓰면 지운다)
RECOVERY_LOCKS:dict[tuple[int, int], list]={}

VERIFY_INTERVAL_SECONDS=15
DAILY_WINDOW_HOURS=24

NOT_RECOVERED_REASON="자동 복구를 했지만 정상으로 돌아오지 않았습니다"
NO_TARGET_REASON="되돌릴 이전 정상 버전이 없습니다 (정상으로 확인된 적이 있고 이미지가 남아 있는 직전 버전이 필요합니다)"


class Recovery_Service:

    # 인시던트를 지금 값으로 읽는다 - open|recovering 이 아니면 None (이미 닫혔거나 없다)
    @staticmethod
    async def services_recovery_get_active(db:AsyncSession, i_id:int) -> Incident | None:
        incident=await Incident_Crud.crud_incident_get_by_i_id(db, i_id)

        if incident is None:
            return None

        await db.refresh(incident)
        return incident if incident.status in INCIDENT_ACTIVE_STATUSES else None


    # 자동 복구를 해도 되는지 - AWS 를 부르기 직전마다 다시 확인한다. 안 되는 이유(한국어)를 돌려주고, 모두 맞으면 None
    @staticmethod
    async def services_recovery_check(db:AsyncSession, incident:Incident) -> str | None:
        from features.deploys.services import Deploy_Service

        try:
            deploy=await Deploy_Service.services_deploy_get_d_id(db, incident.d_id)
        except HTTPException:
            return "배포를 찾을 수 없어 자동 복구를 하지 않습니다"

        await db.refresh(deploy)

        if deploy.status != 'running':
            return "배포가 실행 중이 아니라 자동 복구를 하지 않습니다"
        if not deploy.auto_recover:
            return "이 배포는 자동 복구가 꺼져 있습니다"
        if not deploy.service_arn:
            return "서비스 정보가 없어 자동 복구를 하지 않습니다"

        attempts=await Incident_Crud.crud_incident_action_count(db, incident.i_id)
        if attempts >= settings.recovery_max_attempts_per_incident:
            return f"이 문제에 대한 자동 복구 시도 한도({settings.recovery_max_attempts_per_incident}회)에 닿았습니다"

        # 되돌리기가 AWS 에 갔는데 배포 기록 반영이 끝나지 않은 배포는, 사용자가 새 버전을 배포하기 전까지 자동 복구를 하지 않는다 (기록이 거짓이라 잘못된 이미지로 재시작할 수 있다)
        latest=await Incident_Crud.crud_incident_action_latest_by_d_id(db, incident.d_id)
        if latest is not None and latest.action == 'rollback' and latest.result == 'failed' and Recovery_State.services_recovery_is_unrecorded(latest.detail):
            current=await Deploy_Service.services_deploy_release_current(db, incident.d_id)
            if current is None or current.created_at is None or current.created_at <= latest.started_at:
                return "지난 되돌리기의 배포 기록 반영이 실패한 상태라 자동 복구를 하지 않습니다. 배포 상태를 확인한 뒤 다시 배포해 주세요"

        since=Incident_Service.services_incident_now() - timedelta(hours=DAILY_WINDOW_HOURS)
        if await Incident_Crud.crud_incident_action_count_since(db, incident.d_id, since) >= settings.recovery_daily_limit:
            return f"하루 자동 복구 한도({settings.recovery_daily_limit}회)에 닿았습니다"

        return None


    # 자동 복구 시작 - 배포별 잠금 안에서 규칙 표대로 실행한다. 어떤 오류도 needs_action 으로 끝낸다 (recovering 에 멈추지 않는다)
    # updater/waiter/sleeper/checker 는 시험용 - 각각 AWS 갱신, 갱신 완료 대기, 기다림, 헬스 점검을 대신한다
    @staticmethod
    async def services_recovery_start(db:AsyncSession, i_id:int, updater=None, waiter=None, sleeper=None, checker=None) -> None:
        try:
            incident=await Recovery_Service.services_recovery_get_active(db, i_id)
            if incident is None:
                return

            async with keyed_lock(RECOVERY_LOCKS, (id(asyncio.get_running_loop()), incident.d_id)):
                await Recovery_Service.services_recovery_run(db, i_id, updater, waiter, sleeper, checker)

        except Exception as e:
            logger.warning("자동 복구 실패 i_id=%s : %s", i_id, mask_text(str(e))[:200])
            try:
                await db.rollback()
                await Incident_Crud.crud_incident_action_fail_running(db, i_id, mask_text(f"{type(e).__name__}: {e}")[:DETAIL_MAX],
                                                                      Incident_Service.services_incident_now())
                await db.commit()
            except Exception:
                await db.rollback()
            await Incident_Service.services_incident_fail_safe(db, i_id, e)


    # 규칙 표 실행 - bad_release 는 되돌리기만, 그 밖에는 재시작 -> (안 되면) 되돌리기. 대상이 없으면 되돌리기는 하지 않는다
    @staticmethod
    async def services_recovery_run(db:AsyncSession, i_id:int, updater, waiter, sleeper, checker) -> None:
        from features.deploys.services import Deploy_Service

        incident=await Recovery_Service.services_recovery_get_active(db, i_id)
        if incident is None:
            return

        reason=NOT_RECOVERED_REASON
        order=['rollback'] if incident.kind == 'bad_release' else ['restart', 'rollback']

        for action in order:
            incident=await Recovery_Service.services_recovery_get_active(db, i_id)
            if incident is None:
                return

            problem=await Recovery_Service.services_recovery_check(db, incident)
            if problem:
                reason=problem
                break

            release=None
            if action == 'rollback':
                release=await Deploy_Service.services_deploy_release_rollback_target(db, incident.d_id)
                if release is None:
                    reason=NO_TARGET_REASON
                    break

            outcome, why=await Recovery_Service.services_recovery_act(db, incident, action, release, updater, waiter, sleeper, checker)
            if outcome in ('ok', 'closed'):
                return
            if outcome == 'halt':
                reason=why
                break

        await Recovery_Service.services_recovery_give_up(db, i_id, reason)


    # 동작 하나 - recovering 으로 바꾸고 시도를 기록한 뒤 갱신 -> 완료 대기 -> 대기 -> 검증. 'ok'|'failed'|'closed'(그 사이 인시던트가 닫힘)를 돌려준다
    @staticmethod
    async def services_recovery_act(db:AsyncSession, incident:Incident, action:str, release, updater, waiter, sleeper, checker) -> tuple[str, str | None]:
        from features.deploys.services import Deploy_Service, DEPLOY_CHANGED_DETAIL

        i_id, d_id=incident.i_id, incident.d_id
        rel_id, rel_image=(release.d_r_id, release.image_uri) if release else (None, None)

        if not await Incident_Crud.crud_incident_transition(db, i_id, ('open', 'recovering'), 'recovering'):
            await db.commit()
            return 'closed', None

        record=await Incident_Crud.crud_incident_action_create(db, i_id, action, rel_id)
        await db.commit()
        r_a_id=record.r_a_id

        result, detail, halt='failed', None, None
        update_sent=False

        try:
            deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)
            await db.refresh(deploy)

            # 재시작은 지금 이미지 그대로, 되돌리기는 직전 정상 버전의 이미지로 같은 갱신을 한다
            image_uri=rel_image or deploy.image_uri
            if not image_uri or deploy.port is None or not deploy.service_arn:
                raise ValueError("이미지·포트·서비스 정보가 없어 실행할 수 없습니다")

            start_image, service_arn, port, path=deploy.image_uri, deploy.service_arn, deploy.port, deploy.health_check_path or "/"

            environment=await Env_Service.services_env_runtime_dict(db, d_id) or None
            session=await Aws_Account_Service.services_aws_account_build_session(db, deploy.aws_account_id)
            await db.commit()

            # AWS 를 부르기 직전의 마지막 확인 - 세션 준비 사이에 멈추거나 자동 복구가 꺼졌을 수 있다
            halt=await Recovery_Service.services_recovery_check_final(db, i_id, d_id)
            await db.commit()

            if halt is None:
                update=updater or Express_Service.services_express_update
                await asyncio.to_thread(update, session, service_arn, image_uri, port, path, environment=environment)
                update_sent=True

                wait=waiter or Express_Service.services_express_wait
                await asyncio.to_thread(wait, session, service_arn)

                if await Recovery_Service.services_recovery_verify(db, d_id, sleeper, checker):
                    if action == 'rollback':
                        halt=await Recovery_Service.services_recovery_apply_rollback(d_id, rel_id, start_image, sleeper)
                    result='ok' if halt is None else 'failed'
                else:
                    detail="복구 뒤 정상으로 확인되지 않았습니다"

            detail=halt or detail

        except Exception as e:
            await db.rollback()
            detail=mask_text(f"{type(e).__name__}: {e}")[:DETAIL_MAX]

        # 되돌리기 갱신이 AWS 에 갔는데 기록에는 반영되지 않았으면 표식을 남긴다 - 기록(deploys.image_uri)은 나쁜 이미지 그대로라 이후 자동 복구를 막아야 한다
        # (그 사이 배포가 바뀐 경우는 새 배포가 기록을 대신하므로 제외)
        if action == 'rollback' and update_sent and result != 'ok' and detail != DEPLOY_CHANGED_DETAIL:
            detail=Recovery_State.services_recovery_mark_unrecorded(detail)

        await Incident_Crud.crud_incident_action_finish(db, r_a_id, result, detail, Incident_Service.services_incident_now())
        await db.commit()

        if halt is not None:
            return 'halt', halt
        if result != 'ok':
            return 'failed', None

        now=Incident_Service.services_incident_now()
        if not await Incident_Crud.crud_incident_transition(db, i_id, ('recovering',), 'resolved', {"resolved_at": now}):
            await db.commit()
            return 'closed', None

        await db.commit()
        await db.refresh(incident)
        await Incident_Service.services_incident_notify(db, incident, 'incident_recovered')
        return 'ok', None


    # AWS 를 부르기 직전 확인 - 배포가 running 이고 자동 복구가 켜져 있고 인시던트가 아직 처리 중인지. 안 되면 이유, 되면 None (시도 횟수는 이미 기록했으니 세지 않는다)
    @staticmethod
    async def services_recovery_check_final(db:AsyncSession, i_id:int, d_id:int) -> str | None:
        from features.deploys.services import Deploy_Service

        if await Recovery_Service.services_recovery_get_active(db, i_id) is None:
            return "인시던트가 이미 닫혀 자동 복구를 하지 않습니다"

        try:
            deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)
        except HTTPException:
            return "배포를 찾을 수 없어 자동 복구를 하지 않습니다"

        await db.refresh(deploy)

        if deploy.status != 'running' or not deploy.auto_recover or not deploy.service_arn:
            return "복구를 시작하기 직전에 배포 상태나 자동 복구 설정이 바뀌어 자동 복구를 하지 않습니다"

        return None


    # 검증 - 대기 뒤 15초마다 같은 주소를 점검한다. 검증 시간 안에 연속 정상이 기준 횟수에 닿으면 True
    @staticmethod
    async def services_recovery_verify(db:AsyncSession, d_id:int, sleeper=None, checker=None) -> bool:
        from features.deploys.services import Deploy_Service
        from features.health.services import Health_Service

        deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)
        await db.refresh(deploy)
        url=Health_Service.services_health_safe_url(deploy.endpoint, deploy.health_check_path) if deploy.endpoint else None
        await db.commit()

        sleep=sleeper or asyncio.sleep
        check=checker or Health_Service.services_health_default_checker

        await sleep(settings.recovery_wait_seconds)

        if url is None:
            return False

        semaphore=asyncio.Semaphore(1)
        rounds=settings.recovery_verify_seconds // VERIFY_INTERVAL_SECONDS
        streak=0

        for n in range(rounds + 1):
            ok, _, _, _=await Health_Service.services_health_check_one(url, check, semaphore)
            streak=streak + 1 if ok else 0

            if streak >= settings.recovery_verify_ok_count:
                return True

            if n < rounds:
                await sleep(VERIFY_INTERVAL_SECONDS)

        return False


    # 기록 반영 재시도·포기·서버 재개는 recovery_state.py 의 구현을 그대로 쓴다
    services_recovery_apply_rollback=staticmethod(Recovery_State.services_recovery_apply_rollback)
    services_recovery_give_up=staticmethod(Recovery_State.services_recovery_give_up)
    services_recovery_resume=staticmethod(Recovery_State.services_recovery_resume)
