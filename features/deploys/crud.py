from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import update, delete, or_, and_
from datetime import datetime

from shared.ownership import owner_where

from features.deploys.models import Deploy, Deploy_Log, Deploy_Issue, Deploy_Release
from features.deploys.scheme import Deploy_Create


class Deploy_Crud:

    # 모든 배포 조회 (삭제된 것 제외, 최신순) - u_id 를 주면 그 사용자 것만 (백그라운드는 주지 않는다)
    @staticmethod
    async def crud_deploy_get_all(db: AsyncSession, u_id:int|None=None) -> list[Deploy]:
        query=(select(Deploy)
               .where(Deploy.status != 'deleted')
               .order_by(Deploy.d_id.desc()))
        result=await db.execute(owner_where(query, Deploy.u_id, u_id))
        return result.scalars().all()


    # 배포 d_id 찾기 - u_id 를 주면 그 사용자 것일 때만
    @staticmethod
    async def crud_deploy_get_by_d_id(db:AsyncSession, d_id:int, u_id:int|None=None) -> Deploy | None:
        result = await db.execute(owner_where(select(Deploy).filter(Deploy.d_id == d_id), Deploy.u_id, u_id))
        return result.scalars().first()


    # 특정 상태들의 배포 찾기
    @staticmethod
    async def crud_deploy_get_by_status(db:AsyncSession, statuses:list[str]) -> list[Deploy]:
        result = await db.execute(select(Deploy).filter(Deploy.status.in_(statuses)))
        return result.scalars().all()


    # 배포 생성 - u_id 는 만든 사용자 (인증 끔이면 None)
    @staticmethod
    async def crud_deploy_create(db:AsyncSession, deploy: Deploy_Create, u_id:int|None=None) -> Deploy:
        db_deploy=Deploy(**deploy.model_dump(), status='queued', u_id=u_id)
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


    # 예정 시간 초과를 따져 볼 배포 - running 이고 예정 시간·시작 시각이 있고 아직 알리지 않은 것
    @staticmethod
    async def crud_deploy_get_plan_candidates(db:AsyncSession) -> list[Deploy]:
        result=await db.execute(select(Deploy).filter(Deploy.status == 'running', Deploy.planned_hours.is_not(None),
                                                      Deploy.running_since.is_not(None), Deploy.plan_notified_at.is_(None)))
        return result.scalars().all()


    # 레포 주소로 배포 찾기 (웹훅 매칭용) - 브랜치 비교는 services 레이어에서
    @staticmethod
    async def crud_deploy_get_by_repo_url(db:AsyncSession, repo_url:str) -> list[Deploy]:
        result=await db.execute(select(Deploy).filter(Deploy.repo_url == repo_url, Deploy.status != 'deleted'))
        return result.scalars().all()


    # 현재(current) 릴리스 조회 - 배포마다 최대 하나
    @staticmethod
    async def crud_deploy_release_get_current(db:AsyncSession, d_id:int) -> Deploy_Release | None:
        result=await db.execute(select(Deploy_Release)
                                .where(Deploy_Release.d_id == d_id, Deploy_Release.state == 'current')
                                .order_by(Deploy_Release.d_r_id.desc()))
        return result.scalars().first()


    # 되돌리기 대상 조회 - 직전(previous) 중 가장 최근 것. 이미지 주소가 빈 행은 쓸 수 없으니 건너뛴다
    @staticmethod
    async def crud_deploy_release_get_previous(db:AsyncSession, d_id:int) -> Deploy_Release | None:
        result=await db.execute(select(Deploy_Release)
                                .where(Deploy_Release.d_id == d_id, Deploy_Release.state == 'previous',
                                       Deploy_Release.image_uri.is_not(None), Deploy_Release.image_uri != '')
                                .order_by(Deploy_Release.d_r_id.desc()))
        return result.scalars().first()


    # 릴리스 상태 한꺼번에 바꾸기 - 배포의 from_state 인 행을 to_state 로 (failed 같은 다른 상태는 건드리지 않는다)
    @staticmethod
    async def crud_deploy_release_move_state(db:AsyncSession, d_id:int, from_state:str, to_state:str) -> int:
        result=await db.execute(update(Deploy_Release)
                                .where(Deploy_Release.d_id == d_id, Deploy_Release.state == from_state)
                                .values(state=to_state))
        return result.rowcount


    # 릴리스 한 줄 쌓기
    @staticmethod
    async def crud_deploy_release_create(db:AsyncSession, d_id:int, commit_sha:str|None, image_uri:str, state:str='current') -> Deploy_Release:
        db_release=Deploy_Release(d_id=d_id, commit_sha=commit_sha, image_uri=image_uri, state=state)
        db.add(db_release)
        await db.flush()
        return db_release


    # 릴리스의 정상 확인 시각 기록 - 비어 있을 때만 채운다
    @staticmethod
    async def crud_deploy_release_mark_healthy(db:AsyncSession, d_r_id:int, healthy_since:datetime) -> int:
        result=await db.execute(update(Deploy_Release)
                                .where(Deploy_Release.d_r_id == d_r_id, Deploy_Release.healthy_since.is_(None))
                                .values(healthy_since=healthy_since))
        return result.rowcount


    # 배포의 state 인 릴리스들의 정상 확인 시각을 비운다 - 이미지를 지운 뒤에는 다시 확인되기 전까지 정상 버전이 아니다
    @staticmethod
    async def crud_deploy_release_clear_healthy(db:AsyncSession, d_id:int, state:str) -> int:
        result=await db.execute(update(Deploy_Release)
                                .where(Deploy_Release.d_id == d_id, Deploy_Release.state == state)
                                .values(healthy_since=None))
        return result.rowcount


    # 릴리스 한 줄의 상태 바꾸기
    @staticmethod
    async def crud_deploy_release_set_state(db:AsyncSession, d_r_id:int, state:str) -> int:
        result=await db.execute(update(Deploy_Release).where(Deploy_Release.d_r_id == d_r_id).values(state=state))
        return result.rowcount


    # 사용자의 배포 전부 (삭제한 것 포함) - 계정 삭제가 기록을 지울 때 쓴다
    @staticmethod
    async def crud_deploy_get_all_by_u_id(db:AsyncSession, u_id:int) -> list[Deploy]:
        result=await db.execute(select(Deploy).where(Deploy.u_id == u_id).order_by(Deploy.d_id))
        return list(result.scalars().all())


    # 사용자의 살아 있는 배포 - 상태가 live_statuses 안이거나, 실패했는데 서비스(service_arn)가 남은 것
    @staticmethod
    async def crud_deploy_get_live_by_u_id(db:AsyncSession, u_id:int, live_statuses:list[str]) -> list[Deploy]:
        result=await db.execute(select(Deploy)
                                .where(Deploy.u_id == u_id,
                                       or_(Deploy.status.in_(live_statuses),
                                           and_(Deploy.status == 'failed', Deploy.service_arn.is_not(None), Deploy.service_arn != '')))
                                .order_by(Deploy.d_id))
        return list(result.scalars().all())


    # 배포들의 로그·이슈·릴리스와 배포 기록 자체를 지운다 (SQLite 는 ON DELETE CASCADE 를 지키지 않아 자식부터 하나씩). 반환: 지운 배포 수
    @staticmethod
    async def crud_deploy_delete_by_d_ids(db:AsyncSession, d_ids:list[int]) -> int:
        if not d_ids:
            return 0

        for model in (Deploy_Log, Deploy_Issue, Deploy_Release):
            await db.execute(delete(model).where(model.d_id.in_(d_ids)).execution_options(synchronize_session=False))

        result=await db.execute(delete(Deploy).where(Deploy.d_id.in_(d_ids)).execution_options(synchronize_session=False))
        await db.flush()
        return result.rowcount
