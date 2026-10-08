from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import update

from features.deploys.models import Deploy, Deploy_Log, Deploy_Issue
from features.deploys.scheme import Deploy_Create


class Deploy_Crud:

    # 모든 배포 조회 (삭제된 것 제외, 최신순)
    @staticmethod
    async def crud_deploy_get_all(db: AsyncSession) -> list[Deploy]:
        result=await db.execute(select(Deploy)
                                .where(Deploy.status != 'deleted')
                                .order_by(Deploy.d_id.desc()))
        return result.scalars().all()


    # 배포 d_id 찾기
    @staticmethod
    async def crud_deploy_get_by_d_id(db:AsyncSession, d_id:int) -> Deploy | None:
        result = await db.execute(select(Deploy).filter(Deploy.d_id == d_id))
        return result.scalars().first()


    # 특정 상태들의 배포 찾기
    @staticmethod
    async def crud_deploy_get_by_status(db:AsyncSession, statuses:list[str]) -> list[Deploy]:
        result = await db.execute(select(Deploy).filter(Deploy.status.in_(statuses)))
        return result.scalars().all()


    # 배포 생성
    @staticmethod
    async def crud_deploy_create(db:AsyncSession, deploy: Deploy_Create) -> Deploy:
        db_deploy=Deploy(**deploy.model_dump(), status='queued')
        db.add(db_deploy)
        await db.flush()
        return db_deploy


    # 배포 업데이트 - 파이프라인이 단계마다 부른다
    @staticmethod
    async def crud_deploy_update(db:AsyncSession, d_id:int, update_data:dict)->Deploy|None:
        db_deploy=await db.get(Deploy, d_id)

        if db_deploy:

            for key, value in update_data.items():
                setattr(db_deploy, key, value)

            await db.flush()
            return db_deploy

        return None


    # 배포 기록 삭제
    @staticmethod
    async def crud_deploy_delete(db:AsyncSession , d_id:int)->Deploy|None:
        db_deploy = await db.get(Deploy, d_id)
        if db_deploy:
            await db.delete(db_deploy)
            await db.flush()
            return db_deploy
        return None


    # 로그 여러 줄 생성
    @staticmethod
    async def crud_deploy_log_create_many(db:AsyncSession, logs:list[dict]) -> int:
        db.add_all([Deploy_Log(**log) for log in logs])
        await db.flush()
        return len(logs)


    # 로그 조회 - after 이후 것만 (폴링용)
    @staticmethod
    async def crud_deploy_log_get_after(db:AsyncSession, d_id:int, after:int=0, size:int=500) -> list[Deploy_Log]:
        query=(select(Deploy_Log)
               .where(Deploy_Log.d_id==d_id, Deploy_Log.d_l_id > after)
               .order_by(Deploy_Log.d_l_id.asc())
               .limit(size))

        result=await db.execute(query)

        return result.scalars().all()


    # 실패 지점 로그 마지막 부분 - 에러 해설 재료
    @staticmethod
    async def crud_deploy_log_get_tail(db:AsyncSession, d_id:int, size:int=80) -> list[Deploy_Log]:
        query=(select(Deploy_Log)
               .where(Deploy_Log.d_id==d_id)
               .order_by(Deploy_Log.d_l_id.desc())
               .limit(size))

        result=await db.execute(query)

        return list(reversed(result.scalars().all()))


    # 문제 이력 남기기 - 실패마다 하나씩, 다시 배포해도 지워지지 않는다
    @staticmethod
    async def crud_deploy_issue_create(db:AsyncSession, d_id:int, step:str, error_msg:str, explain:str|None) -> Deploy_Issue:
        db_issue=Deploy_Issue(d_id=d_id, step=step, error_msg=error_msg, explain=explain)
        db.add(db_issue)
        await db.flush()
        return db_issue


    # 문제 이력 조회 - 최신순
    @staticmethod
    async def crud_deploy_issue_get_by_d_id(db:AsyncSession, d_id:int) -> list[Deploy_Issue]:
        result=await db.execute(select(Deploy_Issue)
                                .where(Deploy_Issue.d_id==d_id)
                                .order_by(Deploy_Issue.d_i_id.desc()))
        return result.scalars().all()


    # AWS 계정 연결이 끊길 때 - 그 계정을 쓰던 배포는 남기고 연결만 뗀다
    @staticmethod
    async def crud_deploy_unlink_aws_account(db:AsyncSession, a_id:int) -> int:
        result=await db.execute(update(Deploy).where(Deploy.aws_account_id==a_id).values(aws_account_id=None))
        return result.rowcount


    # GitHub 설치가 끊길 때 - 그 설치를 쓰던 배포는 남기고 연결만 뗀다
    @staticmethod
    async def crud_deploy_unlink_github_installation(db:AsyncSession, g_id:int) -> int:
        result=await db.execute(update(Deploy).where(Deploy.github_installation_id==g_id).values(github_installation_id=None))
        return result.rowcount


    # 폴링 대상 - 떠 있는 배포만 (진행 중·삭제된 것 제외)
    @staticmethod
    async def crud_deploy_get_pollable(db:AsyncSession) -> list[Deploy]:
        result=await db.execute(select(Deploy).filter(Deploy.status == 'running'))
        return result.scalars().all()


    # 레포 주소로 배포 찾기 (웹훅 매칭용) - 브랜치 비교는 services 레이어에서
    @staticmethod
    async def crud_deploy_get_by_repo_url(db:AsyncSession, repo_url:str) -> list[Deploy]:
        result=await db.execute(select(Deploy).filter(Deploy.repo_url == repo_url, Deploy.status != 'deleted'))
        return result.scalars().all()
