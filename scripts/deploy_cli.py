import sys
import asyncio
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.database import Base, async_engine, AsyncSessionLocal

from features.deploys import models as deploy_models
from features.deploys.crud import Deploy_Crud
from features.deploys.scheme import Deploy_Create
from features.deploys.pipeline import Deploy_Pipeline

from features.repos.services import Repo_Service

# M3 - GitHub 주소만 넣으면 배포된다 (CLI)
# 웹 서버 없이 파이프라인만 돌린다. 로그는 콘솔에 그대로 나온다
#
# python scripts/deploy_cli.py https://github.com/owner/repo
# python scripts/deploy_cli.py https://github.com/owner/repo --branch dev


# 콘솔에 새 로그만 이어서 출력
async def print_logs(d_id:int, after:int) -> int:
    async with AsyncSessionLocal() as db:
        logs=await Deploy_Crud.crud_deploy_log_get_after(db, d_id, after)

    for log in logs:
        mark={"cmd": ">", "warn": "!", "error": "x"}.get(log.level, " ")
        print(f"{mark} [{log.step:<10}] {log.message}")
        after=log.d_l_id

    return after


async def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("repo_url")
    parser.add_argument("--branch", default=None)
    args=parser.parse_args()

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    repo_url=Repo_Service.services_repo_check_url(args.repo_url)
    branch=Repo_Service.services_repo_check_branch(args.branch)

    async with AsyncSessionLocal() as db:
        deploy=await Deploy_Crud.crud_deploy_create(db, Deploy_Create(repo_url=repo_url, branch=branch))
        await db.commit()
        d_id=deploy.d_id

    task=asyncio.create_task(Deploy_Pipeline.pipeline_run(d_id))

    after=0
    while not task.done():
        after=await print_logs(d_id, after)
        await asyncio.sleep(1)
    await print_logs(d_id, after)

    async with AsyncSessionLocal() as db:
        deploy=await Deploy_Crud.crud_deploy_get_by_d_id(db, d_id)

    print()
    if deploy.status == 'running':
        print(f"완료 :{deploy.endpoint}")
    else:
        print(f"실패 ({deploy.error_step}) :{deploy.error_msg}")
        if deploy.explain:
            print(f"\n해설 :{deploy.explain}")

    await async_engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
