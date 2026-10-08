import asyncio
import contextlib

from fastapi import FastAPI
from fastapi.concurrency import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from pathlib import Path

from shared.settings import settings
from shared.database import Base, async_engine

# 모델을 import 해야 create_all 이 테이블을 안다
from features.deploys import models as deploy_models
from features.accounts import models as account_models

from features.deploys import router as deploys
from features.deploys.pipeline import Deploy_Pipeline
from features.accounts import router as accounts
from features.watches import router as watches
from features.watches.services import Watch_Service


DIST_DIR=Path(__file__).parent / "dist"


@asynccontextmanager
async def lifespan(app:FastAPI):
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # 서버가 꺼지면서 끊긴 배포를 실패로 돌려놓는다
    await Deploy_Pipeline.pipeline_recover()

    # 코드 변경 감지 폴링 - 계속 도는 백그라운드 태스크 (M6)
    poll_task=asyncio.create_task(Watch_Service.services_watch_poll_loop())

    yield

    poll_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await poll_task
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

app.include_router(deploys.router)
app.include_router(accounts.router)
app.include_router(watches.router)


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
