import asyncio
import logging
import re
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import HTTPException, status

from shared.settings import settings
from shared.database import AsyncSessionLocal
from shared.masking import mask_text
from shared.keyed_lock import keyed_lock

from features.incidents.crud import Incident_Crud
from features.incidents.models import Incident
from features.incidents.scheme import Incident_Explain, Incident_Detail, Recovery_Action_Read, INCIDENT_STATUSES
from features.express.services import Express_Service
from features.accounts.services import Aws_Account_Service
from features.notifications.services import Notification_Service

# deploys / health / recovery 서비스는 이 파일을 거꾸로 import 한다 (순환) - 쓰는 함수 안에서 불러온다

logger=logging.getLogger(__name__)

# 백그라운드 처리 태스크 - 참조를 쥐고 있어야 중간에 사라지지 않고, 서버를 끌 때·테스트에서 기다리거나 취소할 수 있다
INCIDENT_TASKS:set[asyncio.Task]=set()
# 배포별 잠금 - 같은 배포에 인시던트가 둘 열리지 않게 (이벤트 루프마다 따로 두고, 다 쓰면 지운다)
INCIDENT_LOCKS:dict[tuple[int, int], list]={}

EVIDENCE_MAX=4000
EVIDENCE_HEALTH_LINES=5
SUMMARY_MAX=255
DESCRIBE_TIMEOUT_SECONDS=25

SUMMARY_PENDING="문제를 확인하고 있습니다"
SUMMARY_NEW_RELEASE_SUFFIX=" (새 버전 배포로 종료)"
SUMMARY_ERROR="자동 처리 중 오류가 나 확인이 필요합니다"

CONNECTION_PATTERN=re.compile(r"연결 실패|connection (?:refused|reset)|ConnectError|ECONN(?:REFUSED|RESET)", re.I)

# 원인 설명 규칙 표 - 서비스 조회 결과(evidence) 규칙을 먼저, 그다음 가장 최근 실패 사유(detail)부터 본다
# 대상 "evidence_release" 는 새 버전 배포 직후(kind=bad_release)일 때만 쓴다 - 아니면 오래된 배포 실패 기록이 지금의 구체적 사유(거부·시간 초과·5xx·404)를 가리지 않게 건너뛴다
# (대상, 패턴, 요약, 원인, 고칠 곳, 조치) - 고칠 곳은 사용자의 레포·설정·콘솔 위치를 가리키는 안내일 뿐 마법사가 코드를 고치지 않는다
EXPLAIN_RULES=[
    ("evidence", re.compile(r"^서비스 상태: (?:INACTIVE|DRAINING)", re.M),
     "서비스가 실행 중이 아닙니다.",
     "ECS 서비스가 내려가 있거나 내려가는 중이라 요청을 받을 수 없습니다.",
     "AWS 콘솔 ECS > 클러스터 > 서비스 > 이벤트 탭에서 서비스가 내려간 이유를 확인합니다.",
     ["직접 멈추거나 지운 적이 없다면 이벤트 탭의 메시지를 확인합니다.", "문제가 풀렸다면 [다시 켜기] 또는 [다시 배포]를 누릅니다."]),

    ("evidence_release", re.compile(r"^배포 상태: (?:ROLLBACK_\w+|STOPPED|FAILED)", re.M),
     "최근 배포가 실패했거나 되돌려졌습니다.",
     "ECS가 새 작업을 띄우다 실패해 배포를 중단하거나 이전 상태로 되돌렸습니다. 앱이 시작하지 못하는 경우가 가장 흔합니다.",
     "AWS 콘솔 ECS > 서비스 > 배포·이벤트 탭의 사유와, 레포의 시작 명령·환경변수 설정을 확인합니다.",
     ["배포 사유 메시지를 확인합니다.", "앱이 시작할 때 필요한 환경변수가 모두 있는지 확인합니다.", "고친 뒤 [다시 배포]를 누릅니다."]),

    ("detail", CONNECTION_PATTERN,
     "앱이 요청을 받지 못하고 있습니다.",
     "연결이 거부되었거나 끊어졌습니다. 앱이 기대한 포트에서 듣고 있지 않거나, 시작 직후 계속 죽고 있을 수 있습니다.",
     "레포의 서버 시작 코드에서 듣는 포트와 0.0.0.0 바인딩, 그리고 배포 설정의 포트가 같은지 확인합니다.",
     ["서버가 127.0.0.1 이 아니라 0.0.0.0 에 바인딩하는지 확인합니다.", "앱이 듣는 포트와 배포에 쓴 포트가 같은지 확인합니다.", "서비스 로그는 AWS 콘솔 ECS 서비스의 로그 탭(CloudWatch Logs)에서 봅니다."]),

    ("detail", re.compile(r"HTTP 5\d\d"),
     "앱이 오류로 응답하고 있습니다.",
     "앱이 떠 있지만 헬스체크 요청에 서버 오류(5xx)로 답하고 있습니다. 코드의 예외나 DB·외부 서비스 연결 실패가 흔한 원인입니다.",
     "AWS 콘솔 ECS 서비스의 로그 탭(CloudWatch Logs)에서 오류 메시지를 확인하고, 해당 코드가 있는 레포 파일을 고칩니다.",
     ["로그에서 마지막 오류 줄을 확인합니다.", "DB 주소 같은 환경변수가 맞는지 확인합니다.", "고친 뒤 [다시 배포]를 누릅니다."]),

    ("detail", re.compile(r"HTTP 404"),
     "헬스체크 경로에서 페이지를 찾지 못합니다.",
     "앱은 응답하지만 헬스체크가 부르는 경로가 앱에 없습니다.",
     "배포 설정의 health_check_path 가 앱에 실제로 있는 경로(예: /health)인지 확인합니다.",
     ["앱에 헬스체크용 경로가 있는지 확인합니다.", "경로를 고친 뒤 [다시 배포]를 누릅니다."]),

    ("detail", re.compile(r"시간 초과|timed? ?out", re.I),
     "앱이 시간 안에 응답하지 못합니다.",
     "앱이 너무 느리거나 멈춰 있습니다. 시작 중이거나 메모리가 부족하거나 무한 대기에 걸렸을 수 있습니다.",
     "AWS 콘솔 ECS 서비스의 로그 탭(CloudWatch Logs)과 작업(Task) 메모리·CPU 사용량을 확인합니다.",
     ["로그에서 마지막 줄을 확인합니다.", "사양(CPU·메모리)이 부족하면 배포 설정에서 올립니다."]),
]

# 규칙에 없을 때의 기본 안내
EXPLAIN_DEFAULT=("앱이 헬스체크에 연속으로 응답하지 않았습니다.",
                 "알려진 원인 목록에 없는 경우입니다. 최근 헬스체크 기록과 서비스 로그에 단서가 있습니다.",
                 "AWS 콘솔 ECS 서비스의 이벤트·로그 탭(CloudWatch Logs)과, 레포의 시작 코드·환경변수 설정을 확인합니다.",
                 ["서비스 로그의 마지막 오류 줄을 확인합니다.", "최근에 바꾼 코드나 환경변수가 있는지 확인합니다.", "고친 뒤 [다시 배포]를 누릅니다."])


class Incident_Service:

    # 끝나지 않은 인시던트의 번호와 상태 조회 - 배포 d_id 마다 (i_id, status), 없으면 (None, None) (deploys 가 목록·상세에 채운다)
    @staticmethod
    async def services_incident_open_states(db:AsyncSession, d_ids:list[int]) -> dict[int, tuple[int | None, str | None]]:
        open_incidents=await Incident_Crud.crud_incident_get_open_by_d_ids(db, d_ids)
        return {d_id: ((open_incidents[d_id].i_id, open_incidents[d_id].status) if d_id in open_incidents else (None, None)) for d_id in d_ids}


    # 끝나지 않은 인시던트 번호 조회 - 배포 d_id 마다 없으면 None
    @staticmethod
    async def services_incident_open_ids(db:AsyncSession, d_ids:list[int]) -> dict[int, int | None]:
        states=await Incident_Service.services_incident_open_states(db, d_ids)
        return {d_id: i_id for d_id, (i_id, _) in states.items()}


    # 현재 시각 - DB 의 CURRENT_TIMESTAMP 와 같은 UTC (시간대 없는 값)
    @staticmethod
    def services_incident_now() -> datetime:
        return datetime.now(timezone.utc).replace(tzinfo=None)


    # 종류 고르기 - 새 버전 배포 직후이고 되돌릴 이전 버전이 있으면 bad_release, 최근 실패가 모두 연결 거부면 crash_loop, 아니면 unhealthy
    @staticmethod
    async def services_incident_pick_kind(db:AsyncSession, d_id:int, last_details:list[str|None], now:datetime|None=None) -> str:
        from features.deploys.services import Deploy_Service

        now=now or Incident_Service.services_incident_now()

        current=await Deploy_Service.services_deploy_release_current(db, d_id)
        previous=await Deploy_Service.services_deploy_release_previous(db, d_id)

        if current is not None and previous is not None and current.created_at is not None:
            created_at=current.created_at.replace(tzinfo=None)
            if (now - created_at).total_seconds() <= settings.new_release_window_seconds:
                return 'bad_release'

        if last_details and all(detail and CONNECTION_PATTERN.search(detail) for detail in last_details):
            return 'crash_loop'

        return 'unhealthy'


    # 원인 수집 - 서비스 상태(AWS 조회, 못 해도 넘어감) + 최근 헬스체크 5줄. 마스킹하고 4000자까지만
    # session 을 주면 그것으로 조회하고, 안 주면 배포에 연결된 계정의 세션을 만든다 (연결된 계정이 없으면 조회를 건너뛴다)
    @staticmethod
    async def services_incident_collect_evidence(db:AsyncSession, d_id:int, session=None, describer=None) -> str:
        from features.deploys.services import Deploy_Service
        from features.health.services import Health_Service

        deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)
        lines=[]

        if deploy.service_arn:
            if session is None and deploy.aws_account_id is not None:
                try:
                    session=await Aws_Account_Service.services_aws_account_build_session(db, deploy.aws_account_id)
                except Exception as e:
                    lines.append(f"서비스 상태: 확인하지 못함 (AWS 세션 준비 실패 - {type(e).__name__})")

            if session is not None:
                try:
                    describe=describer or Express_Service.services_express_describe
                    express=await asyncio.wait_for(asyncio.to_thread(describe, session, deploy.service_arn), DESCRIBE_TIMEOUT_SECONDS)
                    lines.append(f"서비스 상태: {express.status_code} ({express.status_reason or '-'})")
                    lines.append(f"배포 상태: {express.deployment_status or '-'} / 단계 {express.lifecycle_stage or '-'} / 사유 {express.deployment_reason or '-'}")
                except asyncio.TimeoutError:
                    lines.append("서비스 상태를 확인하지 못했습니다 (시간 초과)")
                except Exception as e:
                    lines.append(f"서비스 상태: 확인하지 못함 ({type(e).__name__}: {str(e)[:200]})")

        lines.append("최근 헬스체크:")
        recent=await Health_Service.services_health_get_recent(db, d_id, EVIDENCE_HEALTH_LINES)
        for check in recent:
            when=check.checked_at.strftime("%Y-%m-%d %H:%M:%S") if check.checked_at else "-"
            lines.append(f"- {when} {'정상' if check.ok else '실패'} 코드={check.status_code} 응답={check.latency_ms}ms {check.detail or ''}".rstrip())

        return mask_text("\n".join(lines))[:EVIDENCE_MAX]


    # 원인 설명 - 규칙 표에서 찾는다 (서비스 조회 결과 먼저, 그다음 가장 최근 실패 사유부터). 없으면 기본 안내(source=none)
    @staticmethod
    def services_incident_explain(kind:str, evidence:str|None, last_details:list[str|None]) -> Incident_Explain:
        evidence=mask_text(evidence)
        details=[mask_text(detail) for detail in last_details if detail]
        found=None

        for target, pattern, summary, cause, fix_where, actions in EXPLAIN_RULES:
            if target == "evidence" and pattern.search(evidence):
                found=(summary, cause, fix_where, actions)
                break
            if target == "evidence_release" and kind == 'bad_release' and pattern.search(evidence):
                found=(summary, cause, fix_where, actions)
                break

        if found is None:
            for detail in details:
                for target, pattern, summary, cause, fix_where, actions in EXPLAIN_RULES:
                    if target == "detail" and pattern.search(detail):
                        found=(summary, cause, fix_where, actions)
                        break
                if found is not None:
                    break

        source="rule"
        if found is None:
            found=(*EXPLAIN_DEFAULT,)
            source="none"

        summary, cause, fix_where, actions=found

        if kind == 'bad_release':
            cause=f"{cause} 새 버전을 배포한 직후에 시작된 문제라 이번 변경이 원인일 가능성이 높습니다."

        return Incident_Explain(summary=mask_text(summary), cause=mask_text(cause), fix_where=mask_text(fix_where),
                                actions=[mask_text(action) for action in actions], source=source)


    # 알림 보내기 - 알림이 실패해도 인시던트 처리는 멈추지 않는다
    @staticmethod
    async def services_incident_notify(db:AsyncSession, incident:Incident, kind:str) -> None:
        try:
            await Notification_Service.services_notification_send_incident(db, incident, kind)
        except Exception as e:
            logger.warning("인시던트 알림 실패 i_id=%s kind=%s : %s", incident.i_id, kind, mask_text(str(e))[:200])


    # 알림을 백그라운드 태스크로 띄운다 - 모니터의 직렬 루프·세션 안에서 SMTP·Expo 를 기다리지 않게. 자기 세션을 쓰고 오류는 마스킹해 삼킨다
    # spawner 는 시험용 - (i_id, kind) 를 받아 대신 처리하는 함수
    @staticmethod
    def services_incident_notify_spawn(i_id:int, kind:str, spawner=None) -> asyncio.Task | None:
        if spawner is not None:
            spawner(i_id, kind)
            return None

        task=asyncio.create_task(Incident_Service.services_incident_notify_task(i_id, kind))
        INCIDENT_TASKS.add(task)
        task.add_done_callback(INCIDENT_TASKS.discard)
        return task


    # 알림 태스크 본체 - 인시던트를 새 세션으로 읽어 알린다
    @staticmethod
    async def services_incident_notify_task(i_id:int, kind:str) -> None:
        try:
            async with AsyncSessionLocal() as db:
                incident=await Incident_Crud.crud_incident_get_by_i_id(db, i_id)
                if incident is not None:
                    await Incident_Service.services_incident_notify(db, incident, kind)

        except asyncio.CancelledError:
            raise

        except Exception as e:
            logger.warning("인시던트 알림 태스크 실패 i_id=%s kind=%s : %s", i_id, kind, mask_text(str(e))[:200])


    # 헬스체크 결과를 받아 인시던트를 열고 닫는다 - 모니터의 세션 안에서 DB 만 쓰고 바로 돌아온다 (AWS 조회·설명은 백그라운드 태스크가 한다)
    # 연속 실패가 기준(기본 3)에 닿고 끝나지 않은 인시던트가 없으면 열고, 연속 정상이 기준(기본 3)에 닿으면 open|needs_action 을 닫는다
    # spawner 는 시험용 - i_id 를 받아 처리를 시작하는 함수 (기본은 백그라운드 태스크). notify_spawner 는 해제 알림용 (i_id, kind)
    @staticmethod
    async def services_incident_on_result(db:AsyncSession, d_id:int, ok:bool, now:datetime|None=None, spawner=None, notify_spawner=None) -> Incident | None:
        from features.deploys.services import Deploy_Service
        from features.health.services import Health_Service

        try:
            now=now or Incident_Service.services_incident_now()

            try:
                deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)
            except HTTPException:
                return None

            await db.refresh(deploy)
            if deploy.status != 'running':
                return None

            if ok:
                # 한 번 정상이라고 닫지 않는다 - 연속 정상이 기준(RECOVERY_VERIFY_OK_COUNT)에 닿아야 닫는다 (자주 죽었다 살아나는 앱이 알림을 쏟아내지 않게)
                if await Incident_Crud.crud_incident_get_unresolved_by_d_id(db, d_id) is None:
                    return None

                if await Health_Service.services_health_consecutive_successes(db, d_id) < settings.recovery_verify_ok_count:
                    return None

                return await Incident_Service.services_incident_resolve(db, d_id, now, notify_spawner)

            failures=await Health_Service.services_health_consecutive_failures(db, d_id)
            if failures < settings.health_failure_threshold:
                return None

            # 확인과 생성을 한 덩어리로 - 동시에 들어와도 인시던트는 하나만 열린다
            async with keyed_lock(INCIDENT_LOCKS, (id(asyncio.get_running_loop()), d_id)):
                if await Incident_Crud.crud_incident_get_unresolved_by_d_id(db, d_id):
                    return None

                recent=await Health_Service.services_health_get_recent(db, d_id, settings.health_failure_threshold)
                last_details=[check.detail for check in recent if not check.ok]
                kind=await Incident_Service.services_incident_pick_kind(db, d_id, last_details, now)

                incident=await Incident_Crud.crud_incident_create(db, d_id, kind, SUMMARY_PENDING, detected_at=now)
                await db.commit()
                await db.refresh(incident)

            await Incident_Service.services_incident_start_process(db, incident.i_id, spawner)
            return incident

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"인시던트 처리 실패 :{mask_text(str(e))}")


    # 처리 시작 - 시작하지 못하면 열린 채로 두지 않고 needs_action 으로 돌린다
    @staticmethod
    async def services_incident_start_process(db:AsyncSession, i_id:int, spawner=None) -> None:
        try:
            spawn=spawner or Incident_Service.services_incident_spawn
            started=spawn(i_id)
            if asyncio.iscoroutine(started):
                await started

        except Exception as e:
            await Incident_Service.services_incident_fail_safe(db, i_id, e)


    # 백그라운드 처리 태스크 띄우기 - 집합에 담아 두었다가 끝나면 뺀다
    @staticmethod
    def services_incident_spawn(i_id:int) -> asyncio.Task:
        task=asyncio.create_task(Incident_Service.services_incident_process(i_id))
        INCIDENT_TASKS.add(task)
        task.add_done_callback(INCIDENT_TASKS.discard)
        return task


    # 떠 있는 처리 태스크가 끝나기를 기다린다 (시험용)
    @staticmethod
    async def services_incident_tasks_wait() -> None:
        while INCIDENT_TASKS:
            await asyncio.gather(*list(INCIDENT_TASKS), return_exceptions=True)


    # 떠 있는 처리 태스크를 취소하고 기다린다 (서버를 끌 때)
    @staticmethod
    async def services_incident_tasks_cancel() -> None:
        tasks=list(INCIDENT_TASKS)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


    # 열린 인시던트 처리 - 원인 수집 -> 설명 저장 -> 알림 -> 자동 복구 시작 또는 needs_action. 자기 세션을 쓴다
    @staticmethod
    async def services_incident_process(i_id:int, session=None, describer=None) -> None:
        from features.deploys.services import Deploy_Service
        from features.health.services import Health_Service
        from features.incidents.recovery import Recovery_Service

        async with AsyncSessionLocal() as db:
            try:
                incident=await Incident_Crud.crud_incident_get_by_i_id(db, i_id)
                if incident is None or incident.status != 'open':
                    return

                d_id=incident.d_id
                evidence=await Incident_Service.services_incident_collect_evidence(db, d_id, session, describer)
                recent=await Health_Service.services_health_get_recent(db, d_id, 10)
                explain=Incident_Service.services_incident_explain(incident.kind, evidence, [check.detail for check in recent if not check.ok])

                await Incident_Crud.crud_incident_update_fields(db, i_id, {
                    "evidence": evidence,
                    "explain": explain.model_dump_json(),
                    "summary": mask_text(explain.summary)[:SUMMARY_MAX],
                })
                await db.commit()
                await db.refresh(incident)

                # 그 사이 정상으로 돌아와 닫혔으면 알리지도 복구하지도 않는다
                if incident.status != 'open':
                    return

                await Incident_Service.services_incident_notify(db, incident, 'incident_opened')

                deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)
                if deploy.auto_recover and deploy.status == 'running':
                    await Recovery_Service.services_recovery_start(db, i_id)
                else:
                    await Incident_Service.services_incident_needs_action(db, i_id)

            except Exception as e:
                logger.warning("인시던트 처리 실패 i_id=%s : %s", i_id, mask_text(str(e))[:200])
                await Incident_Service.services_incident_fail_safe(db, i_id, e)


    # needs_action 으로 바꾸고 알린다 - open|recovering 일 때만 (이미 닫혔으면 건드리지 않는다)
    @staticmethod
    async def services_incident_needs_action(db:AsyncSession, i_id:int, values:dict|None=None) -> bool:
        changed=await Incident_Crud.crud_incident_transition(db, i_id, ('open', 'recovering'), 'needs_action', values)
        await db.commit()

        if not changed:
            return False

        incident=await Incident_Crud.crud_incident_get_by_i_id(db, i_id)
        await db.refresh(incident)
        await Incident_Service.services_incident_notify(db, incident, 'incident_needs_action')
        return True


    # 처리 중 오류 - 조용히 open 으로 남기지 않고 needs_action 으로 돌린다 (오류 내용은 마스킹해서 evidence 끝에 덧붙인다)
    @staticmethod
    async def services_incident_fail_safe(db:AsyncSession, i_id:int, error:Exception) -> None:
        try:
            await db.rollback()
            incident=await Incident_Crud.crud_incident_get_by_i_id(db, i_id)
            if incident is None:
                return

            await db.refresh(incident)
            note=mask_text(f"처리 오류: {type(error).__name__}: {str(error)[:300]}")
            evidence=f"{incident.evidence or ''}\n{note}".strip()[-EVIDENCE_MAX:]
            await Incident_Service.services_incident_needs_action(db, i_id, {"summary": SUMMARY_ERROR, "evidence": evidence})

        except Exception as e:
            await db.rollback()
            logger.warning("인시던트 오류 정리 실패 i_id=%s : %s", i_id, mask_text(str(e))[:200])


    # 정상으로 돌아오면 닫는다 - open|needs_action 만 (recovering 은 복구 쪽이 직접 확인해서 닫는다)
    # 복구 시도가 있었던 인시던트만 "복구됨" 알림을 보낸다 - 모니터 경로이므로 알림은 백그라운드로 띄운다 (메일·푸시가 느려도 다른 배포 점검이 밀리지 않게)
    @staticmethod
    async def services_incident_resolve(db:AsyncSession, d_id:int, now:datetime|None=None, notify_spawner=None) -> Incident | None:
        incident=await Incident_Crud.crud_incident_get_unresolved_by_d_id(db, d_id)

        if incident is None or incident.status == 'recovering':
            return None

        i_id=incident.i_id
        had_actions=await Incident_Crud.crud_incident_action_count(db, i_id) > 0

        changed=await Incident_Crud.crud_incident_transition(db, i_id, ('open', 'needs_action'), 'resolved',
                                                             {"resolved_at": now or Incident_Service.services_incident_now()})
        await db.commit()

        if not changed:
            return None

        await db.refresh(incident)

        if had_actions:
            try:
                Incident_Service.services_incident_notify_spawn(i_id, 'incident_recovered', notify_spawner)
            except Exception as e:
                logger.warning("복구 알림을 띄우지 못했습니다 i_id=%s : %s", i_id, mask_text(str(e))[:200])

        return incident


    # 새 버전이 배포되면 사용자의 확인을 기다리던(needs_action) 인시던트를 닫는다 - 이전 버전의 문제라 새 버전에 대한 것이 아니다. open|recovering 은 처리 중이니 건드리지 않는다
    # 닫은 수를 돌려준다. 알림은 보내지 않는다 (사용자가 방금 새로 배포했다)
    @staticmethod
    async def services_incident_close_needs_action(db:AsyncSession, d_id:int) -> int:
        try:
            now=Incident_Service.services_incident_now()
            closed=0

            for incident in await Incident_Crud.crud_incident_list(db, 'needs_action', d_id, None, 100):
                summary=(incident.summary or "")[:SUMMARY_MAX - len(SUMMARY_NEW_RELEASE_SUFFIX)] + SUMMARY_NEW_RELEASE_SUFFIX
                closed+=await Incident_Crud.crud_incident_transition(db, incident.i_id, ('needs_action',), 'resolved',
                                                                     {"resolved_at": now, "summary": summary})

            await db.commit()
            return closed

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"인시던트 종료 실패 :{mask_text(str(e))}")


    # 인시던트 목록 - 최신 100건, after(i_id)보다 오래된 것부터. u_id 를 주면 그 사용자 배포의 것만
    @staticmethod
    async def services_incident_get_all(db:AsyncSession, status_filter:str|None=None, d_id:int|None=None, after:int|None=None, u_id:int|None=None) -> list[Incident]:
        if status_filter is not None and status_filter not in INCIDENT_STATUSES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail='상태는 open, recovering, resolved, needs_action 중 하나여야 합니다')

        return await Incident_Crud.crud_incident_list(db, status_filter, d_id, after, 100, u_id)


    # 한 배포의 인시던트 목록 - 없거나 남의 배포는 404
    @staticmethod
    async def services_incident_get_by_deploy(db:AsyncSession, d_id:int, after:int|None=None, u_id:int|None=None) -> list[Incident]:
        from features.deploys.services import Deploy_Service

        await Deploy_Service.services_deploy_get_owned(db, d_id, u_id)
        return await Incident_Crud.crud_incident_list(db, None, d_id, after, 100)


    # 인시던트 한 건과 복구 시도 이력 - 시작 시각순. 남의 배포의 것은 404
    @staticmethod
    async def services_incident_get_detail(db:AsyncSession, i_id:int, u_id:int|None=None) -> Incident_Detail:
        incident=await Incident_Crud.crud_incident_get_by_i_id(db, i_id, u_id)

        if incident is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                detail='해당 id의 인시던트가 없습니다')

        actions=await Incident_Crud.crud_incident_action_list(db, i_id)

        detail=Incident_Detail.model_validate(incident)
        detail.actions=[Recovery_Action_Read.model_validate(action) for action in actions]
        return detail
