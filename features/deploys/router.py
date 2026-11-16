from fastapi import APIRouter, Depends, Query, status

from sqlalchemy.ext.asyncio import AsyncSession

from shared.database import get_db

from features.auth.scheme import Current_User
from features.auth.services import Auth_Service
from features.deploys.scheme import Deploy_Read, Deploy_Create, Deploy_Log_Read, Deploy_Issue_Read, Deploy_Health, Deploy_Settings_Update
from features.deploys.services import Deploy_Service

from features.health.scheme import Health_Check_Read
from features.health.services import Health_Service

from features.repos.scheme import Repo_Remote


router=APIRouter(prefix='/api/deploys',tags=['Deploy'])


# GET 전 배포 조회
@router.get('', response_model=list[Deploy_Read])
async def router_deploy_get_all(db: AsyncSession=Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Deploy_Service.services_deploy_get_all(db, user.u_id)


# GET 레포 브랜치 목록 조회
@router.get('/remote', response_model=Repo_Remote)
async def router_deploy_get_remote(repo_url:str, github_installation_id:int|None=None, db:AsyncSession=Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Deploy_Service.services_deploy_get_remote(db, repo_url, github_installation_id, user.u_id)


# POST 배포 생성
@router.post('', response_model=Deploy_Read, status_code=status.HTTP_201_CREATED)
async def router_deploy_create(deploy:Deploy_Create, db:AsyncSession=Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Deploy_Service.services_deploy_create(db, deploy, user.u_id)


# GET 특정 id 배포 조회
@router.get('/{d_id}', response_model=Deploy_Read)
async def router_deploy_get_d_id(d_id: int, db: AsyncSession = Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Deploy_Service.services_deploy_get_d_id(db, d_id, user.u_id)


# GET 배포 로그 조회 (after 이후 것만)
@router.get('/{d_id}/logs', response_model=list[Deploy_Log_Read])
async def router_deploy_get_logs(d_id: int, after: int = 0, db: AsyncSession = Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Deploy_Service.services_deploy_get_logs(db, d_id, after, user.u_id)


# GET 문제 이력 조회 (다시 배포해도 지워지지 않는다)
@router.get('/{d_id}/issues', response_model=list[Deploy_Issue_Read])
async def router_deploy_get_issues(d_id: int, db: AsyncSession = Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Deploy_Service.services_deploy_get_issues(db, d_id, user.u_id)


# GET 배포 헬스체크
@router.get('/{d_id}/health', response_model=Deploy_Health)
async def router_deploy_health(d_id: int, db: AsyncSession = Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Deploy_Service.services_deploy_health(db, d_id, user.u_id)


# GET 헬스체크 이력 - 시간순, 최대 1440건
@router.get('/{d_id}/health-history', response_model=list[Health_Check_Read])
async def router_deploy_health_history(d_id: int, hours: int = Query(24, ge=1, le=168), db: AsyncSession = Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Health_Service.services_health_history(db, d_id, hours, u_id=user.u_id)


# PATCH 배포별 설정 변경 (자동 재배포, 자동 복구)
@router.patch('/{d_id}/settings', response_model=Deploy_Read)
async def router_deploy_settings_update(d_id: int, body: Deploy_Settings_Update, db: AsyncSession = Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Deploy_Service.services_deploy_settings_update(db, d_id, body, user.u_id)


# POST 다시 배포
@router.post('/{d_id}/redeploy', response_model=Deploy_Read)
async def router_deploy_redeploy(d_id: int, db: AsyncSession = Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Deploy_Service.services_deploy_redeploy(db, d_id, user.u_id)


# POST 환경변수 입력을 마치고 이어서 배포
@router.post('/{d_id}/env/continue', response_model=Deploy_Read)
async def router_deploy_env_continue(d_id: int, db: AsyncSession = Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Deploy_Service.services_deploy_env_continue(db, d_id, user.u_id)


# POST 멈춤 - 요금이 나가는 ECS 서비스만 내린다 (이미지·기록은 유지)
@router.post('/{d_id}/stop', response_model=Deploy_Read)
async def router_deploy_stop(d_id: int, db: AsyncSession = Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Deploy_Service.services_deploy_stop(db, d_id, user.u_id)


# POST 다시 켜기 - 멈춘 배포를 남겨 둔 이미지로 다시 띄운다
@router.post('/{d_id}/start', response_model=Deploy_Read)
async def router_deploy_start(d_id: int, db: AsyncSession = Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Deploy_Service.services_deploy_start(db, d_id, user.u_id)


# DELETE 배포 삭제 (AWS 리소스 정리)
@router.delete('/{d_id}', response_model=dict)
async def router_deploy_delete(d_id: int, db: AsyncSession = Depends(get_db), user:Current_User=Depends(Auth_Service.services_auth_current_user)):
    return await Deploy_Service.services_deploy_delete(db, d_id, user.u_id)
