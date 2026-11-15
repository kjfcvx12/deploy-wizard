import asyncio
import logging
import time
import httpx
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlsplit

from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import HTTPException, status

from shared.settings import settings
from shared.database import AsyncSessionLocal
from shared.masking import mask_text

from features.health.crud import Health_Crud
from features.health.models import Health_Check
from features.deploys.services import Deploy_Service
from features.incidents.services import Incident_Service
from features.notifications.services import Notification_Service

logger=logging.getLogger(__name__)

# 한 번에 부르는 배포 수 상한, 리다이렉트 최대 횟수, 오래된 기록 정리 주기(루프 횟수), 이력 최대 건수
HEALTH_CONCURRENCY=10
HEALTH_MAX_REDIRECTS=5
HEALTH_PRUNE_EVERY=30
HEALTH_HISTORY_MAX=1440
HEALTH_DETAIL_MAX=200


class Health_Service:

    # 배포의 최근 헬스체크 조회 - 최신순
    @staticmethod
    async def services_health_get_recent(db:AsyncSession, d_id:int, size:int=10) -> list[Health_Check]:
        return await Health_Crud.crud_health_get_recent(db, d_id, size)


    # 현재 시각 - DB 의 CURRENT_TIMESTAMP 와 같은 UTC (시간대 없는 값)
    @staticmethod
    def services_health_now() -> datetime:
        return datetime.now(timezone.utc).replace(tzinfo=None)


    # 실패 사유 글 - 짧게, 마스킹 후 자른다 (헤더·본문은 절대 넣지 않는다)
    @staticmethod
    def services_health_detail(text:str|None) -> str | None:
        if not text:
            return None
        return mask_text(text)[:HEALTH_DETAIL_MAX]


    # 점검할 주소 - 배포의 endpoint + health_check_path 뿐이다 (모니터와 자동 복구 검증이 같은 규칙을 쓴다)
    @staticmethod
    def services_health_url(endpoint:str, health_check_path:str|None) -> str:
        return endpoint.rstrip("/") + (health_check_path or "/")


    # 안전한 점검 주소 - 위 주소의 호스트가 endpoint 의 호스트와 다르면 (health_check_path 가 "@evil.tld/" 처럼 호스트를 바꾸는 경우) None
    @staticmethod
    def services_health_safe_url(endpoint:str, health_check_path:str|None) -> str | None:
        url=Health_Service.services_health_url(endpoint, health_check_path)

        try:
            return url if urlsplit(url).netloc == urlsplit(endpoint).netloc else None
        except ValueError:
            return None


    # 기본 점검기 - 주소에 GET. 상태코드 400 미만이면 정상 (services_deploy_health 와 같은 기준)
    # 리다이렉트는 같은 호스트 안에서만 따라간다 - 다른 호스트로 가거나 횟수 제한을 넘으면 정상으로 치지 않는다
    @staticmethod
    async def services_health_default_checker(url:str) -> tuple[bool, int | None, int | None, str | None]:
        started=time.perf_counter()

        try:
            problem=None

            async with httpx.AsyncClient(timeout=settings.health_timeout_seconds, follow_redirects=False) as client:
                current=url
                response=await client.get(current)

                for hop in range(HEALTH_MAX_REDIRECTS + 1):
                    location=response.headers.get("location")
                    if response.status_code not in (301, 302, 303, 307, 308) or not location:
                        break

                    target=urljoin(current, location)
                    if urlsplit(target).netloc != urlsplit(url).netloc:
                        problem="다른 호스트로 이동"
                        break

                    if hop == HEALTH_MAX_REDIRECTS:
                        problem="리다이렉트 반복"
                        break

                    current=target
                    response=await client.get(current)

            latency_ms=int((time.perf_counter() - started) * 1000)
            ok=response.status_code < 400 and problem is None
            return ok, response.status_code, latency_ms, None if ok else (problem or f"HTTP {response.status_code}")

        except httpx.TimeoutException:
            return False, None, int((time.perf_counter() - started) * 1000), "시간 초과"

        except httpx.ConnectError:
            return False, None, int((time.perf_counter() - started) * 1000), "연결 실패"

        except Exception as e:
            return False, None, int((time.perf_counter() - started) * 1000), f"요청 실패 ({type(e).__name__})"


    # 점검 하나 - 점검기가 예외를 내거나 오래 걸려도 실패 결과로 돌려준다 (다른 배포에 영향 없음)
    @staticmethod
    async def services_health_check_one(url:str, checker, semaphore:asyncio.Semaphore) -> tuple[bool, int | None, int | None, str | None]:
        async with semaphore:
            try:
                return await asyncio.wait_for(checker(url), timeout=settings.health_timeout_seconds + 2)

            except asyncio.TimeoutError:
                return False, None, None, "시간 초과"

            except Exception as e:
                return False, None, None, f"점검 오류 ({type(e).__name__})"


    # 올바르지 않은 주소의 점검 결과 - 아무것도 부르지 않는다
    @staticmethod
    async def services_health_invalid_url() -> tuple[bool, int | None, int | None, str | None]:
        return False, None, None, "주소가 올바르지 않습니다"


    # running 이면서 주소가 있는 배포를 한 번씩 점검 - 결과 저장, health_state 갱신, 인시던트 훅 호출. 점검한 d_id 목록을 돌려준다
    @staticmethod
    async def services_health_check_once(db:AsyncSession, now:datetime|None=None, checker=None) -> list[int]:
        now=now or Health_Service.services_health_now()
        checker=checker or Health_Service.services_health_default_checker

        deploys=await Deploy_Service.services_deploy_get_pollable(db)
        targets=[(d.d_id, Health_Service.services_health_safe_url(d.endpoint, d.health_check_path)) for d in deploys if d.endpoint]

        if not targets:
            return []

        semaphore=asyncio.Semaphore(HEALTH_CONCURRENCY)
        # 주소가 올바르지 않으면 부르지 않고 실패로 기록한다
        results=await asyncio.gather(*[Health_Service.services_health_check_one(url, checker, semaphore) if url is not None
                                       else Health_Service.services_health_invalid_url() for _, url in targets])

        checked=[]
        for (d_id, _), (ok, status_code, latency_ms, detail) in zip(targets, results):
            try:
                await Health_Crud.crud_health_create(db, d_id, ok, status_code, latency_ms, Health_Service.services_health_detail(detail), checked_at=now)

                # 점검하는 사이 멈추거나 지워진 배포는 기록하지 않는다
                if not await Deploy_Service.services_deploy_health_apply(db, d_id, ok, now):
                    await db.rollback()
                    continue

            except Exception as e:
                await db.rollback()
                logger.warning("헬스체크 저장 실패 d_id=%s : %s", d_id, mask_text(str(e))[:200])
                continue

            checked.append(d_id)

            try:
                await Incident_Service.services_incident_on_result(db, d_id, ok)
            except Exception as e:
                await db.rollback()
                logger.warning("인시던트 처리 실패 d_id=%s : %s", d_id, mask_text(str(e))[:200])

        return checked


    # 마지막 성공 이후 연속 실패 횟수 (인시던트를 열지 판단할 때 쓴다)
    @staticmethod
    async def services_health_consecutive_failures(db:AsyncSession, d_id:int) -> int:
        return await Health_Crud.crud_health_count_failures_after_last_ok(db, d_id)


    # 마지막 실패 이후 연속 성공 횟수 (인시던트를 닫을지 판단할 때 쓴다)
    @staticmethod
    async def services_health_consecutive_successes(db:AsyncSession, d_id:int) -> int:
        return await Health_Crud.crud_health_count_successes_after_last_failure(db, d_id)


    # 헬스체크 이력 - 최근 hours 시간, 최신 1440건을 시간순(오래된 것부터)으로
    @staticmethod
    async def services_health_history(db:AsyncSession, d_id:int, hours:int=24, now:datetime|None=None) -> list[Health_Check]:
        if hours < 1 or hours > 168:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail='조회 시간은 1~168시간 사이여야 합니다')

        await Deploy_Service.services_deploy_get_d_id(db, d_id)

        now=now or Health_Service.services_health_now()
        rows=await Health_Crud.crud_health_get_since(db, d_id, now - timedelta(hours=hours), HEALTH_HISTORY_MAX)
        return list(reversed(rows))


    # 오래된 헬스체크 기록 삭제 - HEALTH_RETENTION_DAYS 보다 오래된 것만. 지운 수를 돌려준다
    @staticmethod
    async def services_health_prune(db:AsyncSession, now:datetime|None=None) -> int:
        try:
            now=now or Health_Service.services_health_now()
            deleted=await Health_Crud.crud_health_delete_older_than(db, now - timedelta(days=settings.health_retention_days))
            await db.commit()
            return deleted

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"헬스체크 기록 정리 실패 :{mask_text(str(e))}")


    # 예정 사용 시간 초과 알림 - 시간이 지난 배포를 찾아 알림만 보낸다 (멈추거나 지우지 않는다). 보낸 d_id 목록을 돌려준다
    @staticmethod
    async def services_health_plan_notify(now:datetime|None=None) -> list[int]:
        async with AsyncSessionLocal() as db:
            d_ids=await Deploy_Service.services_deploy_plan_check(db, now)

        for d_id in d_ids:
            Notification_Service.services_notification_deploy_fire(d_id, 'plan_exceeded')

        return d_ids


    # 감시 루프 - 서버가 떠 있는 동안 계속 돈다. 한 번 실패해도 멈추지 않는다 (main.py lifespan 에서 시작)
    @staticmethod
    async def services_health_monitor_loop() -> None:
        passes=0

        while True:
            try:
                async with AsyncSessionLocal() as db:
                    await Health_Service.services_health_check_once(db)
            except Exception as e:
                logger.warning("헬스 감시 한 차례 실패 : %s", mask_text(str(e))[:200])

            # 예정 사용 시간 초과 알림 - 헬스 점검과 따로 감싸서 어느 쪽이 실패해도 서로 막지 않는다
            try:
                await Health_Service.services_health_plan_notify()
            except Exception as e:
                logger.warning("예정 시간 점검 실패 : %s", mask_text(str(e))[:200])

            # 오래된 기록 정리는 가끔만 (첫 차례 포함)
            if passes % HEALTH_PRUNE_EVERY == 0:
                try:
                    async with AsyncSessionLocal() as db:
                        await Health_Service.services_health_prune(db)
                except Exception as e:
                    logger.warning("헬스체크 기록 정리 실패 : %s", mask_text(str(e))[:200])

            passes+=1
            await asyncio.sleep(settings.health_interval_seconds)


    # 감시 루프 시작 - HEALTH_MONITOR_ENABLED 가 꺼져 있으면 띄우지 않고 None
    @staticmethod
    def services_health_monitor_start() -> asyncio.Task | None:
        if not settings.health_monitor_enabled:
            return None

        return asyncio.create_task(Health_Service.services_health_monitor_loop())
