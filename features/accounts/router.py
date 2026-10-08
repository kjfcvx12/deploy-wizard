from pathlib import Path

from fastapi import APIRouter, Depends, status
from fastapi.responses import FileResponse, RedirectResponse

from sqlalchemy.ext.asyncio import AsyncSession

from shared.database import get_db

from features.accounts.scheme import (Aws_Account_Create, Aws_Account_Setup, Aws_Account_Role_Attach, Aws_Account_Read,
                                      Aws_Account_Template_Status, Github_Installation_Read, Github_Installation_Check, Github_Repository_Read,
                                      Connection_Create, Connection_Update, Connection_Read)
from features.accounts.services import Aws_Account_Service, Github_Service, Connection_Service


router=APIRouter(prefix='/api/accounts', tags=['Accounts'])

TEMPLATE_PATH=Path(__file__).parent / "cloudformation" / "deploy_wizard_role.yaml"


# POST AWS 계정 등록 시작 - external_id 발급
@router.post('/aws', response_model=Aws_Account_Setup, status_code=status.HTTP_201_CREATED)
async def router_aws_account_create(payload:Aws_Account_Create, db:AsyncSession=Depends(get_db)):
    return await Aws_Account_Service.services_aws_account_create(db, payload)


# GET 전 AWS 계정 조회
@router.get('/aws', response_model=list[Aws_Account_Read])
async def router_aws_account_get_all(db:AsyncSession=Depends(get_db)):
    return await Aws_Account_Service.services_aws_account_get_all(db)


# GET CloudFormation 템플릿 다운로드
@router.get('/aws/template', include_in_schema=False)
async def router_aws_account_template():
    return FileResponse(TEMPLATE_PATH, filename="deploy_wizard_role.yaml", media_type="application/x-yaml")


# GET AWS 계정 a_id 조회
@router.get('/aws/{a_id}', response_model=Aws_Account_Read)
async def router_aws_account_get_by_id(a_id:int, db:AsyncSession=Depends(get_db)):
    return await Aws_Account_Service.services_aws_account_get_by_id(db, a_id)


# PATCH 역할 ARN 등록 + 검증
@router.patch('/aws/{a_id}/role-arn', response_model=Aws_Account_Read)
async def router_aws_account_attach_role(a_id:int, payload:Aws_Account_Role_Attach, db:AsyncSession=Depends(get_db)):
    return await Aws_Account_Service.services_aws_account_attach_role(db, a_id, payload.role_arn)


# POST 다시 확인 - 저장된 role_arn 으로 재검증
@router.post('/aws/{a_id}/reverify', response_model=Aws_Account_Read)
async def router_aws_account_reverify(a_id:int, db:AsyncSession=Depends(get_db)):
    return await Aws_Account_Service.services_aws_account_reverify(db, a_id)


# GET 스택 업데이트가 필요한지 - 사용자 계정에 깔린 템플릿 버전과 최신 버전 비교
@router.get('/aws/{a_id}/template-status', response_model=Aws_Account_Template_Status)
async def router_aws_account_template_status(a_id:int, db:AsyncSession=Depends(get_db)):
    return await Aws_Account_Service.services_aws_account_template_status(db, a_id)


# DELETE 콘솔에 올린 템플릿 파일 삭제 - 사용자 계정 S3 의 deploy_wizard_role.yaml 만
@router.delete('/aws/{a_id}/template-files', response_model=dict)
async def router_aws_account_template_cleanup(a_id:int, db:AsyncSession=Depends(get_db)):
    return await Aws_Account_Service.services_aws_account_template_cleanup(db, a_id)


# DELETE AWS 계정 연결 삭제
@router.delete('/aws/{a_id}', response_model=dict)
async def router_aws_account_delete(a_id:int, db:AsyncSession=Depends(get_db)):
    return await Aws_Account_Service.services_aws_account_delete(db, a_id)


# GET GitHub App 설치 화면 주소 - c_id 를 주면 설치가 끝난 뒤 그 블록에 이어진다
@router.get('/github/install-url', response_model=dict)
async def router_github_install_url(c_id:int|None=None):
    return {"url": Github_Service.services_github_install_url(c_id)}


# GET GitHub App 설치 콜백 - installation_id 를 받아 저장하고(state 의 블록에 잇고) 화면으로 돌려보낸다
@router.get('/github/callback', include_in_schema=False)
async def router_github_callback(installation_id:int, setup_action:str|None=None, state:str|None=None,
                                 db:AsyncSession=Depends(get_db)):
    installation=await Github_Service.services_github_installation_upsert(db, installation_id)

    if state and state.isdigit():
        await Connection_Service.services_connection_link_github(db, int(state), installation.g_id)

    return RedirectResponse(url="/accounts?connected=github")


# GET 전 연결 블록 조회 - 블록마다 AWS 계정과 GitHub 설치를 함께
@router.get('/connections', response_model=list[Connection_Read])
async def router_connection_get_all(db:AsyncSession=Depends(get_db)):
    return await Connection_Service.services_connection_get_all(db)


# POST 연결 블록 생성 ([+] 버튼) - 빈 블록
@router.post('/connections', response_model=Connection_Read, status_code=status.HTTP_201_CREATED)
async def router_connection_create(payload:Connection_Create, db:AsyncSession=Depends(get_db)):
    return await Connection_Service.services_connection_create(db, payload)


# POST 블록의 AWS 연결 시작 - external_id 발급
@router.post('/connections/{c_id}/aws', response_model=Aws_Account_Setup, status_code=status.HTTP_201_CREATED)
async def router_connection_create_aws(c_id:int, db:AsyncSession=Depends(get_db)):
    return await Connection_Service.services_connection_create_aws(db, c_id)


# PATCH 블록에 GitHub 설치를 잇거나 뗀다
@router.patch('/connections/{c_id}', response_model=Connection_Read)
async def router_connection_update(c_id:int, payload:Connection_Update, db:AsyncSession=Depends(get_db)):
    return await Connection_Service.services_connection_update(db, c_id, payload)


# DELETE 연결 블록 삭제 (이 블록의 AWS 계정 연결 포함, GitHub 설치는 남긴다)
@router.delete('/connections/{c_id}', response_model=dict)
async def router_connection_delete(c_id:int, db:AsyncSession=Depends(get_db)):
    return await Connection_Service.services_connection_delete(db, c_id)


# GET GitHub 연결 확인 - 설치 토큰을 실제로 받아 접근 가능한 레포 수를 돌려준다
@router.get('/github/{g_id}/check', response_model=Github_Installation_Check)
async def router_github_installation_check(g_id:int, db:AsyncSession=Depends(get_db)):
    return await Github_Service.services_github_installation_check(db, g_id)


# GET GitHub 설치가 읽을 수 있는 레포 목록 - 새 배포 폼의 주소 목록
@router.get('/github/{g_id}/repositories', response_model=list[Github_Repository_Read])
async def router_github_installation_repositories(g_id:int, db:AsyncSession=Depends(get_db)):
    return await Github_Service.services_github_installation_repositories(db, g_id)


# GET 전 GitHub 설치 조회
@router.get('/github', response_model=list[Github_Installation_Read])
async def router_github_installation_get_all(db:AsyncSession=Depends(get_db)):
    return await Github_Service.services_github_installation_get_all(db)


# DELETE GitHub 연결 삭제
@router.delete('/github/{g_id}', response_model=dict)
async def router_github_installation_delete(g_id:int, db:AsyncSession=Depends(get_db)):
    return await Github_Service.services_github_installation_delete(db, g_id)
