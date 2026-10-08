import asyncio
import httpx
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import HTTPException, status

from shared.masking import mask_text

from features.deploys.crud import Deploy_Crud
from features.deploys.scheme import Deploy_Create, Deploy_Health
from features.deploys.pipeline import Deploy_Pipeline, PROGRESS_STATUSES

from features.repos.services import Repo_Service
from features.repos.scheme import Repo_Remote
from features.express.services import Express_Service
from features.accounts.services import Aws_Account_Service, Github_Service


class Deploy_Service:

    # 전 배포 조회
    @staticmethod
    async def services_deploy_get_all(db:AsyncSession):
        return await Deploy_Crud.crud_deploy_get_all(db)


    # 배포 d_id 조회
    @staticmethod
    async def services_deploy_get_d_id(db: AsyncSession, d_id: int):
        deploy = await Deploy_Crud.crud_deploy_get_by_d_id(db, d_id)

        if not deploy or deploy.status == 'deleted':
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                detail='해당 id의 배포가 없습니다')

        return deploy


    # 배포 로그 조회
    @staticmethod
    async def services_deploy_get_logs(db: AsyncSession, d_id: int, after: int):
        await Deploy_Service.services_deploy_get_d_id(db, d_id)
        return await Deploy_Crud.crud_deploy_log_get_after(db, d_id, after)


    # AWS 계정 연결 해제 - accounts 기능이 계정을 지울 때 부른다 (기능 간 호출은 services만)
    @staticmethod
    async def services_deploy_unlink_aws_account(db: AsyncSession, a_id: int) -> int:
        return await Deploy_Crud.crud_deploy_unlink_aws_account(db, a_id)


    # GitHub 설치 연결 해제 - accounts 기능이 설치를 지울 때 부른다
    @staticmethod
    async def services_deploy_unlink_github_installation(db: AsyncSession, g_id: int) -> int:
        return await Deploy_Crud.crud_deploy_unlink_github_installation(db, g_id)


    # 폴링 대상 조회 - watches 기능이 감시할 배포 목록을 가져갈 때 부른다
    @staticmethod
    async def services_deploy_get_pollable(db: AsyncSession):
        return await Deploy_Crud.crud_deploy_get_pollable(db)


    # 새 커밋 발견 표시만 - auto_redeploy 꺼져 있을 때 (watches 기능이 부른다)
    @staticmethod
    async def services_deploy_mark_new_commit(db: AsyncSession, d_id: int, commit_sha: str) -> None:
        await Deploy_Crud.crud_deploy_update(db, d_id, {"watch_commit_sha": commit_sha, "watch_checked_at": datetime.now(timezone.utc)})
        await db.commit()


    # 레포+브랜치로 배포 찾기 (웹훅 매칭) - branch가 None인 배포는 "기본 브랜치 추적"이라 default_branch와 비교
    @staticmethod
    async def services_deploy_get_by_repo_branch(db: AsyncSession, repo_url: str, branch: str, default_branch: str | None = None):
        deploys=await Deploy_Crud.crud_deploy_get_by_repo_url(db, repo_url)
        return [d for d in deploys if d.branch == branch or (d.branch is None and branch == default_branch)]


    # 문제 이력 조회 - 다시 배포해도 지워지지 않는 지난 실패들
    @staticmethod
    async def services_deploy_get_issues(db: AsyncSession, d_id: int):
        await Deploy_Service.services_deploy_get_d_id(db, d_id)
        return await Deploy_Crud.crud_deploy_issue_get_by_d_id(db, d_id)


    # 레포 브랜치 목록 조회 - GitHub 설치가 있으면 그 토큰으로 (private 레포도 가능)
    @staticmethod
    async def services_deploy_get_remote(db:AsyncSession, repo_url:str, github_installation_id:int|None=None) -> Repo_Remote:
        try:
            token=await Github_Service.services_github_token_by_g_id(db, github_installation_id) if github_installation_id else None
            return await asyncio.to_thread(Repo_Service.services_repo_remote, repo_url, token)

        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

        except Exception as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"레포를 조회할 수 없습니다 :{mask_text(str(e))}")


    # 배포 생성 - 기록을 만들고 파이프라인을 띄운다
    @staticmethod
    async def services_deploy_create(db:AsyncSession, deploy:Deploy_Create):
        try:
            repo_url=Repo_Service.services_repo_check_url(deploy.repo_url)
            branch=Repo_Service.services_repo_check_branch(deploy.branch)

            new_deploy=await Deploy_Crud.crud_deploy_create(db, Deploy_Create(
                repo_url=repo_url, branch=branch,
                aws_account_id=deploy.aws_account_id, github_installation_id=deploy.github_installation_id))

            await db.commit()
            await db.refresh(new_deploy)

            Deploy_Pipeline.pipeline_start(new_deploy.d_id)

            return new_deploy

        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"배포 등록 실패 :{e}")


    # 다시 배포 - 사용자가 버튼을 눌렀을 때만
    @staticmethod
    async def services_deploy_redeploy(db:AsyncSession, d_id:int):
        try:
            deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)

            if deploy.status in PROGRESS_STATUSES:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail='이미 진행 중인 배포입니다')

            update_deploy=await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "queued"})

            await db.commit()
            await db.refresh(update_deploy)

            Deploy_Pipeline.pipeline_start(d_id)

            return update_deploy

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"다시 배포 실패 :{e}")


    # 멈춤 - 요금이 나가는 ECS 서비스만 내린다. 이미지와 기록은 남겨 [다시 켜기]가 빌드 없이 끝나게 한다. 사용자가 확인한 뒤에만 부른다
    @staticmethod
    async def services_deploy_stop(db:AsyncSession, d_id:int):
        try:
            deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)

            if deploy.status != 'running' or not deploy.service_arn:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail='떠 있는 배포만 멈출 수 있습니다')

            session=await Aws_Account_Service.services_aws_account_build_session(db, deploy.aws_account_id)
            await asyncio.to_thread(Express_Service.services_express_delete, session, deploy.service_arn)

            update_deploy=await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "stopped", "service_arn": None, "endpoint": None})

            await db.commit()
            await db.refresh(update_deploy)
            return update_deploy

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"배포 멈춤 실패 :{mask_text(str(e))}")


    # 다시 켜기 - 멈춘 배포를 남겨 둔 이미지로 다시 띄운다 (클론·빌드·푸시 없이 배포 단계만). 사용자가 버튼을 눌렀을 때만
    @staticmethod
    async def services_deploy_start(db:AsyncSession, d_id:int):
        try:
            deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)

            if deploy.status != 'stopped':
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail='멈춘 배포만 다시 켤 수 있습니다')

            # 이미지가 남아 있으면 배포 단계부터, 없으면(저장소를 따로 지운 경우) 평소처럼 이어하기 규칙을 따른다
            start_step='deploying' if deploy.image_uri else None

            update_deploy=await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "queued"})

            await db.commit()
            await db.refresh(update_deploy)

            Deploy_Pipeline.pipeline_start(d_id, start_step)

            return update_deploy

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"다시 켜기 실패 :{mask_text(str(e))}")


    # 작업 종료 - 요금이 나가는 것을 모두 멈추고, 다음에 그대로 이어서 할 수 있게 기록은 남긴다 (scripts/session_end.py)
    # 떠 있는 서비스는 내리고(running -> stopped), keep_images 가 아니면 올려 둔 이미지도 지운다. 실패한 배포가 남긴 서비스·이미지도 같이 정리한다
    # dry_run 이면 무엇을 할지만 돌려준다. 사용자가 "작업 종료"를 지시했을 때만 실제로 돌린다 (CLAUDE.md "End of session")
    @staticmethod
    async def services_deploy_session_end(db:AsyncSession, keep_images:bool=False, dry_run:bool=False) -> dict:
        report={"stopped": [], "purged": [], "in_progress": [], "failed": []}

        for deploy in await Deploy_Crud.crud_deploy_get_all(db):
            d_id, name=deploy.d_id, f"#{deploy.d_id} {deploy.repo_url}"

            if deploy.status in PROGRESS_STATUSES:
                report["in_progress"].append(name)
                continue

            purge=bool(deploy.repository_name) and not keep_images

            if not deploy.service_arn and not purge:
                continue

            try:
                update_data={}

                if not dry_run:
                    session=await Aws_Account_Service.services_aws_account_build_session(db, deploy.aws_account_id)

                if deploy.service_arn:
                    if not dry_run:
                        await asyncio.to_thread(Express_Service.services_express_delete, session, deploy.service_arn)

                    update_data.update({"service_arn": None, "endpoint": None})
                    if deploy.status == 'running':
                        update_data["status"]='stopped'
                    report["stopped"].append(name)

                if purge:
                    if not dry_run:
                        await asyncio.to_thread(Express_Service.services_express_delete_repository, session, deploy.repository_name)

                    update_data.update({"image_uri": None, "repository_name": None})
                    report["purged"].append(name)

                if not dry_run:
                    await Deploy_Crud.crud_deploy_update(db, d_id, update_data)
                    await db.commit()

            except Exception as e:
                await db.rollback()
                report["failed"].append(f"{name} :{mask_text(str(e))}")

        return report


    # 배포 삭제 - AWS 리소스 정리. 사용자가 확인한 뒤에만 부른다
    @staticmethod
    async def services_deploy_delete(db: AsyncSession, d_id: int) -> dict:
        try:
            deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)

            if deploy.status in PROGRESS_STATUSES:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail='진행 중인 배포는 삭제할 수 없습니다')

            service_arn, repository_name=deploy.service_arn, deploy.repository_name
            deleted=[]

            if service_arn or repository_name:
                session=await Aws_Account_Service.services_aws_account_build_session(db, deploy.aws_account_id)

                if service_arn:
                    await asyncio.to_thread(Express_Service.services_express_delete, session, service_arn)
                    deleted.append(service_arn)

                if repository_name:
                    await asyncio.to_thread(Express_Service.services_express_delete_repository, session, repository_name)
                    deleted.append(repository_name)

            await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "deleted", "endpoint": None})

            await db.commit()
            return {'message':'배포 삭제', 'deleted': deleted}

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"배포 삭제 실패 :{mask_text(str(e))}")


    # 헬스체크 - 이미 공개된 주소를 부르는 것이라 AWS 권한이 필요 없다 (기획서 03장)
    @staticmethod
    async def services_deploy_health(db: AsyncSession, d_id: int) -> Deploy_Health:
        deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)

        if not deploy.endpoint:
            return Deploy_Health(d_id=d_id, health='unknown', detail='아직 주소가 없습니다')

        url=deploy.endpoint.rstrip("/") + (deploy.health_check_path or "/")

        try:
            async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
                response=await client.get(url)

            health='healthy' if response.status_code < 400 else 'unhealthy'
            return Deploy_Health(d_id=d_id, health=health, status_code=response.status_code)

        except Exception as e:
            return Deploy_Health(d_id=d_id, health='unhealthy', detail=str(e)[:200])
