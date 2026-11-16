import asyncio
import json
import logging
import re
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import HTTPException, status

from shared.settings import settings
from shared.database import AsyncSessionLocal
from shared.crypto_types import Encrypted_Text
from shared.masking import MASK

from features.notifications.crud import Notification_Crud
from features.notifications.models import Notification_Setting, NOTIFICATION_KINDS, NOTIFICATION_KINDS_VERSION
from features.notifications.compose import Composed, compose_incident, compose_deploy, compose_service_name
from features.notifications.dispatch import dispatch_scrub, dispatch_oneline, dispatch_mail_send, dispatch_mail_configured, dispatch_push_send, Push_Target
from features.auth.services import Auth_Service

# 알림 보내기 - 앱 안 알림(항상) -> 메일 -> 푸시 순서로, 채널마다 한 줄씩 남긴다 (docs/app-web/05-flowcharts.md 8장)
# 한 채널이 실패해도 다른 채널과 호출한 쪽(인시던트 처리·파이프라인·폴링)은 멈추지 않는다
# incidents / deploys 서비스는 이 파일을 거꾸로 import 한다 (순환) - 쓰는 함수 안에서 불러온다

logger=logging.getLogger(__name__)

# 배포·새 커밋 알림을 보내는 백그라운드 태스크 - 참조를 쥐고 있어야 사라지지 않고, 서버를 끌 때·테스트에서 기다리거나 취소할 수 있다
NOTIFICATION_TASKS:set[asyncio.Task]=set()

ERROR_MAX=300


class Notification_Service:

    # 지금 시각 - DB 의 CURRENT_TIMESTAMP 와 같은 UTC (시간대 없는 값)
    @staticmethod
    def services_notification_now() -> datetime:
        return datetime.now(timezone.utc).replace(tzinfo=None)


    # 알림 설정 가져오기 - u_id 의 줄(None 이면 id=1 줄), 처음이면 기본값으로 만들어 저장한다. 옛 설정(kinds_version 없음)은 한 번 보정한다
    @staticmethod
    async def services_notification_setting_get(db:AsyncSession, u_id:int|None=None) -> Notification_Setting:
        try:
            db_setting=await Notification_Crud.crud_notification_setting_get(db, u_id)

            if db_setting.kinds_version is None:
                Notification_Service.services_notification_kinds_migrate(db_setting)

            await db.commit()
            return db_setting

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"알림 설정 조회 실패 :{dispatch_scrub(str(e))}")


    # 옛 설정 보정 - plan_exceeded 가 생기기 전 기본값(그것만 빠진 여섯 가지)이면 plan_exceeded 를 더하고, 일부를 일부러 꺼 둔 목록은 그대로 둔다
    # 어느 쪽이든 판(kinds_version)을 올려서 다시 건드리지 않는다. 이후 사용자가 여섯 가지로 저장하면 꺼 둔 것으로 존중한다
    @staticmethod
    def services_notification_kinds_migrate(db_setting:Notification_Setting) -> None:
        kinds=Notification_Service.services_notification_kinds(db_setting)
        legacy_default={kind for kind in NOTIFICATION_KINDS if kind != 'plan_exceeded'}

        if set(kinds) == legacy_default:
            db_setting.kinds=json.dumps(kinds + ['plan_exceeded'])

        db_setting.kinds_version=NOTIFICATION_KINDS_VERSION


    # 설정에 저장된 받을 알림 종류 - 읽을 수 없으면 전부
    @staticmethod
    def services_notification_kinds(db_setting:Notification_Setting) -> list[str]:
        try:
            value=json.loads(db_setting.kinds)
        except Exception:
            return list(NOTIFICATION_KINDS)

        if not isinstance(value, list):
            return list(NOTIFICATION_KINDS)

        return [kind for kind in value if kind in NOTIFICATION_KINDS]


    # 인시던트 알림 보내기 - 원인 설명과 자동 복구 이력으로 글을 만들어 설정대로 내보낸다
    # mailer(subject, body) / pusher(devices, title, body, link) 는 시험용 - 안 주면 진짜 발송기
    @staticmethod
    async def services_notification_send_incident(db:AsyncSession, incident, kind:str, mailer=None, pusher=None) -> None:
        from features.incidents.services import Incident_Service
        from features.deploys.services import Deploy_Service

        try:
            detail=await Incident_Service.services_incident_get_detail(db, incident.i_id)
            deploy=await Deploy_Service.services_deploy_get_d_id(db, incident.d_id)
            service=compose_service_name(deploy)
            composed=compose_incident(kind, service, detail)

            await Notification_Service.services_notification_fan_out(db, kind, composed, service, incident.d_id, incident.i_id, True, mailer, pusher, u_id=deploy.u_id)

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"알림 발송 실패 :{dispatch_scrub(str(e))}")


    # 배포 알림 보내기 - deploy_succeeded | deploy_failed | new_commit | plan_exceeded. event 는 새 커밋의 sha (커밋마다 한 번만 알린다)
    @staticmethod
    async def services_notification_send_deploy(db:AsyncSession, deploy, kind:str, mailer=None, pusher=None, event:str|None=None) -> None:
        try:
            service=compose_service_name(deploy)
            composed=compose_deploy(kind, service, deploy, event)

            # 완료·실패는 시도할 때마다 새 사건이라 중복을 막지 않는다. 새 커밋은 제목(커밋 sha)이 같으면 한 번만
            await Notification_Service.services_notification_fan_out(db, kind, composed, service, deploy.d_id, None, kind == 'new_commit', mailer, pusher, u_id=deploy.u_id)

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"알림 발송 실패 :{dispatch_scrub(str(e))}")


    # 채널별로 내보내기 - 설정(종류·메일·푸시)을 지키고, 같은 알림이 이미 있는 채널은 건너뛴다
    # u_id(대상 배포의 주인)가 있으면 그 사용자의 설정·이메일·기기로, None(주인 없는 배포·인증 끔)이면 id=1 설정·MAIL_TO·전체 기기로
    @staticmethod
    async def services_notification_fan_out(db:AsyncSession, kind:str, composed:Composed, service:str, d_id:int, i_id:int|None,
                                            dedupe:bool, mailer=None, pusher=None, u_id:int|None=None) -> None:
        db_setting=await Notification_Service.services_notification_setting_get(db, u_id)

        if kind not in Notification_Service.services_notification_kinds(db_setting):
            return

        base=dict(u_id=u_id, d_id=d_id, i_id=i_id, kind=kind, title=composed.title, body=composed.body)

        async def already(channel:str) -> bool:
            if not dedupe:
                return False
            return await Notification_Crud.crud_notification_exists(db, kind, channel, i_id=i_id, d_id=d_id, title=None if i_id else composed.title)

        # 1. 앱 안 알림 - 항상 (종류가 켜져 있으면)
        if not await already('inapp'):
            await Notification_Crud.crud_notification_create(db, dict(base, channel='inapp', status='sent', sent_at=Notification_Service.services_notification_now()))
            await db.commit()

        # 2. 메일 - 켜져 있고 SMTP 설정과 받는 사람이 있을 때만 (없으면 줄도 남기지 않는다). 주인이 있는데 이메일을 모르면 보내지 않는다
        if db_setting.notify_email and settings.mail_host and not await already('email'):
            to=await Notification_Service.services_notification_recipient(db, u_id) if u_id is not None else None
            if (u_id is None or to) and dispatch_mail_configured(to):
                await Notification_Service.services_notification_send_mail(db, base, dispatch_oneline(f"[배포 마법사] {service} {composed.title}"), mailer, to)

        # 3. 푸시 - 켜져 있고 등록된 기기가 있을 때만
        if db_setting.notify_push and not await already('push'):
            devices=await Notification_Service.services_notification_devices(db, u_id)
            if devices:
                await Notification_Service.services_notification_send_push(db, base, devices, composed, pusher)


    # 메일 받는 사람 - 사용자의 이메일 (auth 서비스로만). 읽지 못하면 마스킹한 경고만 남기고 None (주소는 로그에 싣지 않는다)
    @staticmethod
    async def services_notification_recipient(db:AsyncSession, u_id:int) -> str | None:
        try:
            return await Auth_Service.services_auth_user_email(db, u_id)
        except Exception as e:
            logger.warning("알림 메일 받는 사람 확인 실패 u_id=%s : %s", u_id, type(e).__name__)
            return None


    # 푸시 대상 기기 - 저장된 토큰을 한 줄씩 복호화한다. 읽을 수 없는 줄(이전 전 평문 등)은 마스킹한 경고만 남기고 건너뛴다
    @staticmethod
    async def services_notification_devices(db:AsyncSession, u_id:int|None) -> list[Push_Target]:
        decoder=Encrypted_Text()
        devices=[]

        for p_d_id, raw in await Notification_Crud.crud_notification_device_list_raw(db, u_id):
            try:
                devices.append(Push_Target(p_d_id=p_d_id, expo_token=decoder.process_result_value(raw, None)))
            except Exception as e:
                logger.warning("푸시 기기 건너뜀 p_d_id=%s : %s", p_d_id, dispatch_scrub(str(e))[:200])

        return devices


    # 메일 한 통 - queued 로 남기고 보낸 뒤 sent|failed 로 바꾼다. 실패는 줄에 적고 올리지 않는다
    # to 는 배포 주인의 이메일 (None 이면 MAIL_TO). 주소는 줄에 남기지 않고, 실패 문장에서도 가린다
    @staticmethod
    async def services_notification_send_mail(db:AsyncSession, base:dict, subject:str, mailer=None, to:str|None=None) -> None:
        row=await Notification_Crud.crud_notification_create(db, dict(base, channel='email', status='queued'))
        await db.commit()

        state, error, sent_at='sent', None, Notification_Service.services_notification_now()
        try:
            send=mailer or dispatch_mail_send
            extra={"to": to} if to else {}
            await asyncio.wait_for(send(dispatch_scrub(subject), base["body"], **extra), timeout=settings.mail_timeout_seconds * 2)

        except Exception as e:
            message=f"{type(e).__name__}: {e}"
            if to:
                message=re.sub(re.escape(to), MASK, message, flags=re.IGNORECASE)
            state, error, sent_at='failed', dispatch_scrub(message)[:ERROR_MAX], None

        await Notification_Crud.crud_notification_update_status(db, row, state, error, sent_at)
        await db.commit()


    # 푸시 한 건 - 기기 전체에 보내고, 하나라도 갔으면 sent. 쓸 수 없는 토큰의 기기는 지운다
    @staticmethod
    async def services_notification_send_push(db:AsyncSession, base:dict, devices:list, composed:Composed, pusher=None) -> None:
        row=await Notification_Crud.crud_notification_create(db, dict(base, channel='push', status='queued'))
        await db.commit()

        state, error, sent_at='failed', None, None
        invalid_tokens=[]
        try:
            send=pusher or dispatch_push_send
            result=await asyncio.wait_for(send(devices, composed.title, composed.push_line, composed.link), timeout=settings.expo_push_timeout_seconds * 3)
            invalid_tokens=list(result.invalid_tokens)

            if result.sent > 0:
                state, sent_at='sent', Notification_Service.services_notification_now()
            else:
                error=dispatch_scrub(result.error or "보낸 기기가 없습니다")[:ERROR_MAX]

        except Exception as e:
            error=dispatch_scrub(f"{type(e).__name__}: {e}")[:ERROR_MAX]

        await Notification_Crud.crud_notification_update_status(db, row, state, error, sent_at)
        await Notification_Crud.crud_notification_device_delete_by_tokens(db, invalid_tokens)
        await db.commit()


    # 배포 알림을 백그라운드로 띄운다 - 파이프라인·폴링은 기다리지 않는다 (느린 SMTP·Expo 가 흐름을 붙잡지 않게)
    @staticmethod
    def services_notification_deploy_fire(d_id:int, kind:str, event:str|None=None, mailer=None, pusher=None) -> asyncio.Task:
        task=asyncio.create_task(Notification_Service.services_notification_deploy_run(d_id, kind, event, mailer, pusher))
        NOTIFICATION_TASKS.add(task)
        task.add_done_callback(NOTIFICATION_TASKS.discard)
        return task


    # 백그라운드 알림 본체 - 자기 세션을 쓰고, 어떤 오류도 밖으로 내보내지 않는다 (마스킹한 경고만)
    @staticmethod
    async def services_notification_deploy_run(d_id:int, kind:str, event:str|None=None, mailer=None, pusher=None) -> None:
        from features.deploys.services import Deploy_Service

        try:
            async with AsyncSessionLocal() as db:
                try:
                    deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)
                except HTTPException:
                    return

                await Notification_Service.services_notification_send_deploy(db, deploy, kind, mailer=mailer, pusher=pusher, event=event)

        except asyncio.CancelledError:
            raise

        except Exception as e:
            logger.warning("배포 알림 실패 d_id=%s kind=%s : %s", d_id, kind, dispatch_scrub(str(e))[:200])


    # 떠 있는 알림 태스크가 끝나기를 기다린다 (시험용)
    @staticmethod
    async def services_notification_tasks_wait() -> None:
        while NOTIFICATION_TASKS:
            await asyncio.gather(*list(NOTIFICATION_TASKS), return_exceptions=True)


    # 떠 있는 알림 태스크를 취소하고 기다린다 (서버를 끌 때)
    @staticmethod
    async def services_notification_tasks_cancel() -> None:
        tasks=list(NOTIFICATION_TASKS)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
