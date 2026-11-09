import asyncio
import contextlib
import logging

from fastapi import FastAPI
from fastapi.concurrency import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from pathlib import Path

from shared.settings import settings
from shared.masking import mask_text
from shared.database import Base, async_engine, AsyncSessionLocal, ensure_columns

# 모델을 import 해야 create_all 이 테이블을 안다
from features.deploys import models as deploy_models
from features.accounts import models as account_models
from features.envvars import models as envvar_models
from features.health import models as health_models
from features.incidents import models as incident_models
from features.notifications import models as notification_models

from features.advice import router as advice
from features.deploys import router as deploys
from features.envvars import router as envvars
from features.deploys.pipeline import Deploy_Pipeline
from features.accounts import router as accounts
from features.watches import router as watches
from features.incidents import router as incidents
from features.notifications import router as notifications
from features.notifications.services import Notification_Service
from features.incidents.services import Incident_Service
from features.incidents.recovery import Recovery_Service
from features.watches.services import Watch_Service
from features.health.services import Health_Service


DIST_DIR=Path(__file__).parent / "dist"

logger=logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app:FastAPI):
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # 이미 있는 deploys 표에는 새 열이 안 생기므로 모자란 열만 더한다
        await conn.run_sync(ensure_columns)

    # 서버가 꺼지면서 끊긴 배포를 실패로 돌려놓는다
    await Deploy_Pipeline.pipeline_recover()

    # 서버가 꺼지면서 끊긴 자동 복구·인시던트 처리를 정리한다 (D1) - 실패해도 서버 시작은 막지 않는다
    try:
        async with AsyncSessionLocal() as db:
            await Recovery_Service.services_recovery_resume(db)
    except Exception as e:
        logger.warning("인시던트 정리 실패 : %s", mask_text(str(e))[:200])

    # 코드 변경 감지 폴링 - 계속 도는 백그라운드 태스크 (M6)
    poll_task=asyncio.create_task(Watch_Service.services_watch_poll_loop())

    # 헬스 감시 루프 - HEALTH_MONITOR_ENABLED 가 꺼져 있으면 None (D1)
    health_task=Health_Service.services_health_monitor_start()

    yield

    # 둘 다 먼저 취소한 뒤 하나씩 기다린다 - 한쪽 종료가 꼬여도 다른 쪽이 남지 않게
    background_tasks=[task for task in (poll_task, health_task) if task is not None]
    for task in background_tasks:
        task.cancel()
    for task in background_tasks:
        with contextlib.suppress(asyncio.CancelledError):
            await task

    # 인시던트 처리 중이던 태스크도 취소하고 기다린다
    await Incident_Service.services_incident_tasks_cancel()
    await Notification_Service.services_notification_tasks_cancel()

    await async_engine.dispose()

app=FastAPI(title="AWS 자동 배포 마법사", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def root():
    return {"message": "ok"}

app.include_router(advice.router)
app.include_router(deploys.router)
app.include_router(envvars.router)
app.include_router(accounts.router)
app.include_router(watches.router)
app.include_router(incidents.router)
app.include_router(notifications.router)


# 빌드된 프론트가 있으면 같이 서빙한다 (npm run build -> dist/)
if DIST_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path:str):
        file=(DIST_DIR / path).resolve()
        # dist 밖의 파일은 절대 내주지 않는다
        if path and file.is_relative_to(DIST_DIR.resolve()) and file.is_file():
            return FileResponse(file)
        return FileResponse(DIST_DIR / "index.html")



#uvicorn main:app --port=8081 --reload
