import asyncio
import logging
import math
import httpx
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import HTTPException, status

from shared.masking import mask_text
from shared.settings import settings

from features.deploys.crud import Deploy_Crud
from features.deploys.scheme import Deploy_Create, Deploy_Health, Deploy_Settings_Update
from features.deploys.pipeline import Deploy_Pipeline, PROGRESS_STATUSES

from features.repos.services import Repo_Service
from features.repos.scheme import Repo_Remote
from features.express.services import Express_Service
from features.accounts.services import Aws_Account_Service, Github_Service
from features.envvars.services import Env_Service
from features.incidents.services import Incident_Service
from features.pricing.services import Pricing_Service, MAX_PLANNED_HOURS

logger=logging.getLogger(__name__)


# 자동 복구 중에 배포가 바뀌어 되돌린 결과를 기록하지 않을 때 (409 의 detail)
DEPLOY_CHANGED_DETAIL="복구 중에 배포가 변경되어 기록을 반영하지 않았습니다"


class Deploy_Service:

    # 전 배포 조회
    @staticmethod
    async def services_deploy_get_all(db:AsyncSession):
        deploys=await Deploy_Crud.crud_deploy_get_all(db)
        pending=await Env_Service.services_env_pending_many(db, [d.d_id for d in deploys])

        open_states=await Incident_Service.services_incident_open_states(db, [d.d_id for d in deploys])

        for deploy in deploys:
            deploy.env_pending=pending[deploy.d_id]
            deploy.open_incident_id, deploy.open_incident_status=open_states[deploy.d_id]

        return deploys


    # 배포 d_id 조회
    @staticmethod
    async def services_deploy_get_d_id(db: AsyncSession, d_id: int):
        deploy = await Deploy_Crud.crud_deploy_get_by_d_id(db, d_id)

        if not deploy or deploy.status == 'deleted':
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                detail='해당 id의 배포가 없습니다')

        deploy.env_pending=await Env_Service.services_env_pending_count(db, d_id)
        deploy.open_incident_id, deploy.open_incident_status=(await Incident_Service.services_incident_open_states(db, [d_id]))[d_id]
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


    # 예정 사용 시간 검사 - 비어 있으면 통과, 유한한 수이고 0 보다 크고 1년(8760시간) 이하여야 한다. 아니면 400
    @staticmethod
    def services_deploy_check_planned_hours(planned_hours:float|None) -> None:
        if planned_hours is None:
            return

        if isinstance(planned_hours, float) and not math.isfinite(planned_hours):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail='예정 사용 시간이 올바른 숫자가 아닙니다')

        if not 0 < planned_hours <= MAX_PLANNED_HOURS:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"예정 사용 시간은 0보다 크고 {MAX_PLANNED_HOURS}시간(1년) 이하여야 합니다")


    # 만들 때 받은 사양·증설·예정 시간 검사 - 가격 기능의 규칙을 그대로 쓴다. 문제가 있으면 한국어 400
    @staticmethod
    def services_deploy_check_options(deploy:Deploy_Create) -> None:
        if not Pricing_Service.services_pricing_spec_valid(deploy.cpu, deploy.memory):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail='사양이 올바르지 않습니다. CPU와 메모리를 정해진 사양 중에서 함께 골라 주세요')

        Deploy_Service.services_deploy_check_planned_hours(deploy.planned_hours)

        message=Pricing_Service.services_pricing_scaling_valid(deploy.min_tasks, deploy.max_tasks, deploy.scale_metric,
                                                               deploy.scale_target, settings.max_tasks_cap)
        if message:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=message)


    # 배포 생성 - 기록을 만들고 파이프라인을 띄운다
    @staticmethod
    async def services_deploy_create(db:AsyncSession, deploy:Deploy_Create):
        try:
            repo_url=Repo_Service.services_repo_check_url(deploy.repo_url)
            branch=Repo_Service.services_repo_check_branch(deploy.branch)
            Deploy_Service.services_deploy_check_options(deploy)

            new_deploy=await Deploy_Crud.crud_deploy_create(db, Deploy_Create(
                repo_url=repo_url, branch=branch,
                aws_account_id=deploy.aws_account_id, github_installation_id=deploy.github_installation_id,
                cpu=deploy.cpu, memory=deploy.memory, min_tasks=deploy.min_tasks, max_tasks=deploy.max_tasks,
                scale_metric=deploy.scale_metric, scale_target=deploy.scale_target,
                planned_hours=None if deploy.planned_hours is None else float(deploy.planned_hours)))

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


    # 이어서 배포 - 환경변수 입력을 마친 배포를 배포 단계부터 다시 돌린다. 사용자가 버튼을 눌렀을 때만
    @staticmethod
    async def services_deploy_env_continue(db:AsyncSession, d_id:int):
        try:
            deploy=await Deploy_Service.services_deploy_get_d_id(db, d_id)

            if deploy.status != 'needs_input':
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail='입력이 필요한 상태의 배포만 이어서 배포할 수 있습니다')

            missing=await Env_Service.services_env_pending_names(db, d_id)

            if missing:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail=f"필수 환경변수에 값이 없습니다 :{', '.join(missing)}")

            update_deploy=await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "queued"})

            await db.commit()
            await db.refresh(update_deploy)
            update_deploy.env_pending=0

            # 이전 작업이 아직 정리 중이면 시작되지 않는다 - queued 로 굳지 않게 입력 대기로 되돌린다
            if not Deploy_Pipeline.pipeline_start(d_id, 'deploying'):
                await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "needs_input"})
                await db.commit()
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail='잠시 후 다시 눌러 주세요 (이전 작업을 정리하는 중입니다)')

            return update_deploy

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"이어서 배포 실패 :{mask_text(str(e))}")


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

            update_deploy=await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "stopped", "service_arn": None, "endpoint": None, "running_since": None})

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

                    update_data.update({"service_arn": None, "endpoint": None, "running_since": None})
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
                    # 이미지를 지웠으니 직전 버전(previous)은 되돌릴 곳이 아니다 - current 는 같은 태그로 다시 빌드되니 두되,
                    # 정상 확인 시각은 비운다 (다시 켠 뒤 첫 정상 점검에서 채워진다. 안 비우면 새 버전이 나온 뒤 이 죽은 이미지가 되돌리기 대상이 된다)
                    if purge:
                        await Deploy_Crud.crud_deploy_release_move_state(db, d_id, 'previous', 'old')
                        await Deploy_Crud.crud_deploy_release_clear_healthy(db, d_id, 'current')
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

            await Deploy_Crud.crud_deploy_update(db, d_id, {"status": "deleted", "endpoint": None, "running_since": None})

            # 저장소를 지웠으면 직전 버전(previous)의 이미지도 없다 - 되돌리기 대상에서 뺀다
            if repository_name:
                await Deploy_Crud.crud_deploy_release_move_state(db, d_id, 'previous', 'old')

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


    # 릴리스 기록 - 배포가 running 에 닿을 때 파이프라인이 부른다. 직전 previous 는 old, 지금 current 는 previous, 새 줄이 current (되돌리기 대상은 previous 하나뿐)
    # 같은 커밋·이미지가 다시 running 이 된 것(멈춤 후 다시 켜기 등)은 새 버전이 아니라 쌓지 않는다
    @staticmethod
    async def services_deploy_release_record(db: AsyncSession, d_id: int):
        try:
            deploy=await Deploy_Crud.crud_deploy_get_by_d_id(db, d_id)

            if not deploy or deploy.status == 'deleted':
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                    detail='해당 id의 배포가 없습니다')

            if not deploy.image_uri:
                return None

            current=await Deploy_Crud.crud_deploy_release_get_current(db, d_id)

            if current and current.image_uri == deploy.image_uri and current.commit_sha == deploy.commit_sha:
                return current

            await Deploy_Crud.crud_deploy_release_move_state(db, d_id, 'previous', 'old')
            await Deploy_Crud.crud_deploy_release_move_state(db, d_id, 'current', 'previous')
            new_release=await Deploy_Crud.crud_deploy_release_create(db, d_id, deploy.commit_sha, deploy.image_uri, 'current')

            await db.commit()
            await db.refresh(new_release)

            # 새 버전이 나왔으니 확인을 기다리던 지난 문제는 닫는다 (실패해도 릴리스 기록은 이미 끝났다)
            try:
                await Incident_Service.services_incident_close_needs_action(db, d_id)
            except Exception as e:
                logger.warning("지난 인시던트 종료 실패 d_id=%s : %s", d_id, mask_text(str(e))[:200])

            return new_release

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"릴리스 기록 실패 :{mask_text(str(e))}")


    # 현재 릴리스 조회 - 인시던트가 "새 버전 배포 직후인가"를 볼 때 쓴다. 없으면 None
    @staticmethod
    async def services_deploy_release_current(db: AsyncSession, d_id: int):
        return await Deploy_Crud.crud_deploy_release_get_current(db, d_id)


    # 되돌리기 대상 조회 - 직전 정상 버전(previous) 중 이미지 주소가 있는 가장 최근 것. 없으면 None
    @staticmethod
    async def services_deploy_release_previous(db: AsyncSession, d_id: int):
        return await Deploy_Crud.crud_deploy_release_get_previous(db, d_id)


    # 자동 되돌리기 대상 - 직전 버전(previous) 중 정상 확인된 적이 있고 이미지 주소가 있는 것만. 정상이었던 적 없는 버전은 되돌릴 곳이 아니다
    @staticmethod
    async def services_deploy_release_rollback_target(db: AsyncSession, d_id: int):
        previous=await Deploy_Service.services_deploy_release_previous(db, d_id)

        if previous is None or previous.healthy_since is None or not previous.image_uri:
            return None

        # 지금 떠 있는 이미지와 같은 버전으로는 되돌릴 이유가 없다
        deploy=await Deploy_Crud.crud_deploy_get_by_d_id(db, d_id)
        if deploy is not None:
            await db.refresh(deploy)
            if deploy.image_uri == previous.image_uri:
                return None

        return previous


    # 되돌린 결과 반영 - 배포의 이미지·커밋을 이전 버전으로, 나쁜 릴리스는 failed, 이전 버전은 current. 나쁜 커밋은 bad_commit_sha 에 남겨 자동 재배포를 막는다
    @staticmethod
    async def services_deploy_apply_rollback(db: AsyncSession, d_id: int, release, expected_image_uri: str | None = None):
        try:
            if release is None or release.d_id != d_id or release.state != 'previous' or not release.image_uri:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail='되돌릴 수 있는 이전 버전이 아닙니다')

            deploy=await Deploy_Crud.crud_deploy_get_by_d_id(db, d_id)

            if not deploy or deploy.status == 'deleted':
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                    detail='해당 id의 배포가 없습니다')

            # expected_image_uri 가 있으면 복구하는 사이 배포가 바뀌지 않았을 때만 반영한다 (새 배포의 상태를 덮어쓰지 않게)
            await db.refresh(deploy)
            if expected_image_uri is not None and (deploy.status != 'running' or deploy.image_uri != expected_image_uri):
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=DEPLOY_CHANGED_DETAIL)

            current=await Deploy_Crud.crud_deploy_release_get_current(db, d_id)
            bad_commit_sha=(current.commit_sha if current and current.commit_sha else None) or deploy.commit_sha

            if current is not None:
                await Deploy_Crud.crud_deploy_release_set_state(db, current.d_r_id, 'failed')
            await Deploy_Crud.crud_deploy_release_set_state(db, release.d_r_id, 'current')

            await Deploy_Crud.crud_deploy_update(db, d_id, {"image_uri": release.image_uri, "commit_sha": release.commit_sha,
                                                            "bad_commit_sha": bad_commit_sha})
            await db.commit()
            await db.refresh(deploy)
            return deploy

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"되돌리기 반영 실패 :{mask_text(str(e))}")


    # 감시가 이 커밋을 자동으로 다시 배포해도 되는가 - 되돌리며 기억한 나쁜 커밋이면 막고(True), 그보다 새 커밋이 오면 막힘을 풀고 통과(False)
    # deploy 는 방금 읽은 배포 행 (bad_commit_sha 가 없으면 DB 를 건드리지 않는다)
    @staticmethod
    async def services_deploy_watch_blocked(db: AsyncSession, deploy, commit_sha: str) -> bool:
        bad_commit_sha=getattr(deploy, "bad_commit_sha", None)

        if not bad_commit_sha:
            return False

        if commit_sha == bad_commit_sha:
            return True

        await Deploy_Crud.crud_deploy_update(db, deploy.d_id, {"bad_commit_sha": None})
        await db.commit()
        return False


    # 배포별 설정 변경 - 보낸 항목만 바꾼다 (자동 재배포, 자동 복구, 예정 사용 시간)
    # 예정 사용 시간은 null 을 보내면 계획을 지운다. 보낼 때마다 시간 초과 알림 기록(plan_notified_at)을 비워 알림을 다시 켠다
    @staticmethod
    async def services_deploy_settings_update(db: AsyncSession, d_id: int, body: Deploy_Settings_Update):
        try:
            await Deploy_Service.services_deploy_get_d_id(db, d_id)

            changes=body.model_dump(exclude_none=True, exclude={"planned_hours"})

            if "planned_hours" in body.model_fields_set:
                Deploy_Service.services_deploy_check_planned_hours(body.planned_hours)
                changes["planned_hours"]=None if body.planned_hours is None else float(body.planned_hours)
                changes["plan_notified_at"]=None

            if not changes:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                    detail='변경할 설정을 하나 이상 보내 주세요')

            await Deploy_Crud.crud_deploy_update(db, d_id, changes)
            await db.commit()

            return await Deploy_Service.services_deploy_get_d_id(db, d_id)

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"설정 변경 실패 :{mask_text(str(e))}")


    # 예정 사용 시간 초과 점검 - 알림만 한다 (멈추거나 지우지 않는다). 시간이 지난 배포에 알림 기록(plan_notified_at)을 남기고 d_id 를 돌려준다
    # 정확히 경계(지난 시간 == 예정 시간)에서도 포함한다. 알림 기록이 있으면 다시 돌려주지 않는다 (멈췄다 켜거나 예정 시간을 바꾸면 비워진다)
    @staticmethod
    async def services_deploy_plan_check(db: AsyncSession, now: datetime | None = None) -> list[int]:
        try:
            now=now or datetime.now(timezone.utc).replace(tzinfo=None)

            due=[d for d in await Deploy_Crud.crud_deploy_get_plan_candidates(db)
                 if now - d.running_since >= timedelta(hours=d.planned_hours)]

            for deploy in due:
                await Deploy_Crud.crud_deploy_update(db, deploy.d_id, {"plan_notified_at": now})

            await db.commit()
            return [d.d_id for d in due]

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"예정 시간 점검 실패 :{mask_text(str(e))}")


    # 헬스체크 결과 반영 - running 인 배포만. health_state·last_health_at 을 갱신하고, 정상이면 current 릴리스의 healthy_since 를 처음 한 번 채운다
    # 이미 running 이 아니면 아무것도 쓰지 않고 False (커밋하지 않는다)
    @staticmethod
    async def services_deploy_health_apply(db: AsyncSession, d_id: int, ok: bool, checked_at: datetime) -> bool:
        deploy=await Deploy_Crud.crud_deploy_get_by_d_id(db, d_id)

        if not deploy:
            return False

        # 세션이 이미 들고 있는 객체는 점검하는 사이 바뀐 상태를 모른다 - DB 의 지금 값으로 새로 읽는다
        await db.refresh(deploy)

        if deploy.status != 'running':
            return False

        await Deploy_Crud.crud_deploy_update(db, d_id, {"health_state": 'healthy' if ok else 'unhealthy', "last_health_at": checked_at})

        if ok:
            current=await Deploy_Crud.crud_deploy_release_get_current(db, d_id)
            if current and current.healthy_since is None:
                await Deploy_Crud.crud_deploy_release_mark_healthy(db, current.d_r_id, checked_at)

        await db.commit()
        return True
