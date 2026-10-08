import asyncio
import re
import time
import secrets as py_secrets
from datetime import datetime, timezone

import boto3
import httpx
import jwt
from botocore.exceptions import ClientError, ParamValidationError
from fastapi import HTTPException, status

from sqlalchemy.ext.asyncio import AsyncSession

from shared.settings import settings
from shared.aws_session import get_aws_session, get_assumed_session, get_account_id
from shared.secrets import encrypt_secret, decrypt_secret
from shared.masking import mask_text

from features.accounts.crud import Aws_Account_Crud, Github_Installation_Crud, Connection_Crud
from features.accounts.scheme import (Aws_Account_Create, Aws_Account_Setup, Aws_Account_Template_Status, Github_Installation_Check, Github_Repository_Read,
                                      Connection_Create, Connection_Update, Connection_Read)

# 계정 연결 (M6 기획서 03장) - 액세스 키·PAT를 받지 않는다. AWS는 CloudFormation+AssumeRole, GitHub는 App 설치

# cloudformation/deploy_wizard_role.yaml 의 RoleName 과 같아야 한다
# 흔한 이름(ecsTaskExecutionRole)을 쓰면 사용자 계정에 이미 있을 때 스택 생성이 이름 충돌로 실패한다 - 우리 접두어를 붙인다
CFN_EXECUTION_ROLE_NAME="DeployWizardEcsTaskExecutionRole"
CFN_INFRASTRUCTURE_ROLE_NAME="DeployWizardEcsInfrastructureRole"

REGION_PATTERN=re.compile(r"[a-z]{2}(?:-[a-z]+)+-\d")

# 콘솔에서 "템플릿 파일 업로드"를 하면 AWS가 cf-templates-<해시>-<리전> 버킷을 만들고 <시각><난수>-<파일명> 으로 저장한다 (2026-10-06 실제 계정에서 확인)
TEMPLATE_BUCKET_PREFIX="cf-templates-"
TEMPLATE_FILE_NAME="deploy_wizard_role.yaml"

# 템플릿의 권한을 바꿀 때마다 올린다. 템플릿의 template-version 태그 값과 같아야 한다 (테스트가 확인)
# 사용자 계정의 스택은 사용자만 바꿀 수 있다 - 낮은 버전이면 화면이 "스택 업데이트 필요"를 띄운다
# 2: 역할 이름 접두어, S3 템플릿 파일 정리, ecr:DeleteRepository, 버전 태그 (2026-10-06)
TEMPLATE_VERSION=2
TEMPLATE_VERSION_TAG="template-version"


class Aws_Account_Service:

    # 전 AWS 계정 조회
    @staticmethod
    async def services_aws_account_get_all(db:AsyncSession):
        return await Aws_Account_Crud.crud_aws_account_get_all(db)


    # AWS 계정 a_id 조회
    @staticmethod
    async def services_aws_account_get_by_id(db:AsyncSession, a_id:int):
        account=await Aws_Account_Crud.crud_aws_account_get_by_id(db, a_id)

        if not account:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                detail='해당 id의 AWS 계정이 없습니다')

        return account


    # 콘솔 CloudFormation 주소 - 사용자가 메뉴를 찾아 들어가지 않게 바로 연다. 리전은 사용자 입력이라 형식이 맞을 때만 쓴다
    @staticmethod
    def services_aws_account_console_url(region:str|None, page:str="stacks") -> str:
        if not region or not REGION_PATTERN.fullmatch(region):
            region=settings.aws_region

        return f"https://{region}.console.aws.amazon.com/cloudformation/home?region={region}#/{page}"


    # 콘솔의 스택 생성 화면 주소
    @staticmethod
    def services_aws_account_stack_create_url(region:str|None) -> str:
        return Aws_Account_Service.services_aws_account_console_url(region, "stacks/create")


    # 사용자 계정에 깔린 템플릿 버전 - 위임 역할의 태그로 읽는다. 태그가 없거나 읽을 권한이 없으면(버전 표시 전 템플릿) 0
    @staticmethod
    def services_aws_account_template_version(session:boto3.Session, role_arn:str) -> int:
        iam=session.client("iam")

        try:
            role=iam.get_role(RoleName=role_arn.rsplit("/", 1)[-1])["Role"]

        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("AccessDenied", "AccessDeniedException"):
                return 0
            raise

        for tag in role.get("Tags", []):
            if tag["Key"] == TEMPLATE_VERSION_TAG and tag["Value"].isdigit():
                return int(tag["Value"])

        return 0


    # 스택 업데이트가 필요한지 - 화면이 연결된 계정마다 물어보고, 필요하면 안내와 버튼을 띄운다
    @staticmethod
    async def services_aws_account_template_status(db:AsyncSession, a_id:int) -> Aws_Account_Template_Status:
        try:
            account=await Aws_Account_Service.services_aws_account_get_by_id(db, a_id)

            if not account.role_arn:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                    detail='아직 등록된 역할 ARN이 없습니다')

            session=await Aws_Account_Service.services_aws_account_build_session(db, a_id)
            current=await asyncio.to_thread(Aws_Account_Service.services_aws_account_template_version, session, account.role_arn)

            # 남은 템플릿 파일 수 - 목록 권한은 버전 2부터 있다. 못 세면 0 (버튼을 안 보여준다)
            file_count=0
            if current >= 2:
                try:
                    file_count=len(await asyncio.to_thread(Aws_Account_Service.services_aws_account_template_files_list, session))
                except ClientError:
                    file_count=0

            return Aws_Account_Template_Status(
                a_id=a_id, current_version=current, latest_version=TEMPLATE_VERSION, update_needed=current < TEMPLATE_VERSION,
                template_file_count=file_count,
                template_download_url="/api/accounts/aws/template",
                stack_list_url=Aws_Account_Service.services_aws_account_console_url(account.region))

        except HTTPException:
            raise

        except Exception as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"템플릿 버전을 확인하지 못했습니다 :{mask_text(str(e))}")


    # AWS 계정 등록 시작 - external_id 를 만들고, 사용자가 CFN 스택을 만들 때 쓸 값을 한 번만 보여준다
    @staticmethod
    async def services_aws_account_create(db:AsyncSession, payload:Aws_Account_Create) -> Aws_Account_Setup:
        try:
            external_id=py_secrets.token_urlsafe(24)
            our_account_id=await asyncio.to_thread(get_account_id, get_aws_session())

            new_account=await Aws_Account_Crud.crud_aws_account_create(
                db, payload.label, payload.region, encrypt_secret(external_id))

            await db.commit()
            await db.refresh(new_account)

            return Aws_Account_Setup(a_id=new_account.a_id, label=new_account.label, external_id=external_id,
                                     our_account_id=our_account_id, template_download_url="/api/accounts/aws/template",
                                     stack_create_url=Aws_Account_Service.services_aws_account_stack_create_url(payload.region))

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"AWS 계정 등록 실패 :{e}")


    # 파이프라인이 쓸 세션 - 연결된 계정 없으면 개발 세션 그대로 (M1~M5 동작 유지). HTTPException 은 던지지 않는다
    @staticmethod
    async def services_aws_account_build_session(db:AsyncSession, aws_account_id:int|None) -> boto3.Session:
        if aws_account_id is None:
            return get_aws_session()

        account=await Aws_Account_Crud.crud_aws_account_get_by_id(db, aws_account_id)

        if not account or not account.role_arn:
            raise ValueError("AWS 계정 연결이 완료되지 않았습니다")

        external_id=decrypt_secret(account.external_id_encrypted)
        return await asyncio.to_thread(get_assumed_session, account.role_arn, external_id)


    # 연결된 계정의 ECS 실행·인프라 역할 ARN - CFN 템플릿이 그 계정에 고정 이름으로 만든다. 연결 없으면 None (.env 값 사용)
    @staticmethod
    async def services_aws_account_role_arns(db:AsyncSession, aws_account_id:int|None) -> tuple[str, str]|None:
        if aws_account_id is None:
            return None

        account=await Aws_Account_Crud.crud_aws_account_get_by_id(db, aws_account_id)

        if not account or not account.role_arn:
            raise ValueError("AWS 계정 연결이 완료되지 않았습니다")

        prefix=account.role_arn.rsplit("/", 1)[0]
        return f"{prefix}/{CFN_EXECUTION_ROLE_NAME}", f"{prefix}/{CFN_INFRASTRUCTURE_ROLE_NAME}"


    # 역할 ARN 등록 + 검증 - 사용자가 CFN 스택을 만들고 나온 ARN을 붙여넣었을 때
    @staticmethod
    async def services_aws_account_attach_role(db:AsyncSession, a_id:int, role_arn:str):
        try:
            account=await Aws_Account_Service.services_aws_account_get_by_id(db, a_id)
            external_id=decrypt_secret(account.external_id_encrypted)

            try:
                session=await asyncio.to_thread(get_assumed_session, role_arn, external_id)
                verified_account_id=await asyncio.to_thread(get_account_id, session)

                updated=await Aws_Account_Crud.crud_aws_account_update(db, a_id, {
                    "role_arn": role_arn,
                    "aws_account_id": verified_account_id,
                    "status": "verified",
                    "last_verified_at": datetime.now(timezone.utc),
                    "last_error": None,
                })

            except (ClientError, ParamValidationError) as e:
                masked=mask_text(str(e))
                updated=await Aws_Account_Crud.crud_aws_account_update(db, a_id, {
                    "role_arn": role_arn,
                    "status": "invalid",
                    "last_error": masked,
                })
                await db.commit()
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                    detail=f"AWS 역할을 확인하지 못했습니다 :{masked}")

            await db.commit()
            await db.refresh(updated)
            return updated

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"AWS 계정 확인 실패 :{e}")


    # 다시 확인 - 저장된 role_arn 그대로 재검증 ([다시 확인] 버튼)
    @staticmethod
    async def services_aws_account_reverify(db:AsyncSession, a_id:int):
        account=await Aws_Account_Service.services_aws_account_get_by_id(db, a_id)

        if not account.role_arn:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail='아직 등록된 역할 ARN이 없습니다')

        return await Aws_Account_Service.services_aws_account_attach_role(db, a_id, account.role_arn)


    # 콘솔에 올린 우리 템플릿 파일 지우기 - cf-templates-* 버킷 안의 deploy_wizard_role.yaml 만. 버킷과 다른 파일은 우리 것이 아니라 건드리지 않는다
    @staticmethod
    def services_aws_account_template_files_delete(session:boto3.Session) -> int:
        s3=session.client("s3")
        files=Aws_Account_Service.services_aws_account_template_files_list(session)

        for bucket, key in files:
            s3.delete_object(Bucket=bucket, Key=key)

        return len(files)


    # 사용자 계정 S3 에 남아 있는 우리 템플릿 파일 목록 (버킷, 키) - 화면이 [템플릿 파일 삭제]를 보여줄지 정할 때도 쓴다
    @staticmethod
    def services_aws_account_template_files_list(session:boto3.Session) -> list[tuple[str, str]]:
        s3=session.client("s3")
        files=[]

        for bucket in s3.list_buckets()["Buckets"]:
            name=bucket["Name"]

            if not name.startswith(TEMPLATE_BUCKET_PREFIX):
                continue

            for page in s3.get_paginator("list_objects_v2").paginate(Bucket=name):
                files+=[(name, item["Key"]) for item in page.get("Contents", []) if item["Key"].endswith(f"-{TEMPLATE_FILE_NAME}")]

        return files


    # 템플릿 파일 삭제 ([템플릿 파일 삭제] 버튼) - 연결된 계정의 위임 세션으로 지운다. 연결·스택에는 영향 없음
    @staticmethod
    async def services_aws_account_template_cleanup(db:AsyncSession, a_id:int) -> dict:
        try:
            account=await Aws_Account_Service.services_aws_account_get_by_id(db, a_id)

            if not account.role_arn:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                    detail='아직 등록된 역할 ARN이 없습니다')

            session=await Aws_Account_Service.services_aws_account_build_session(db, a_id)
            deleted=await asyncio.to_thread(Aws_Account_Service.services_aws_account_template_files_delete, session)

            return {'message': '템플릿 파일 삭제', 'deleted': deleted}

        except HTTPException:
            raise

        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("AccessDenied", "AccessDeniedException"):
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail='이 연결의 역할에 템플릿 파일을 지울 권한이 없습니다. 최신 템플릿을 내려받아 CloudFormation 스택을 업데이트한 뒤 다시 시도하세요.')

            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"템플릿 파일 삭제 실패 :{mask_text(str(e))}")

        except Exception as e:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"템플릿 파일 삭제 실패 :{mask_text(str(e))}")


    # AWS 계정 연결 삭제 - 쓰던 배포는 남기고 연결만 뗀다
    @staticmethod
    async def services_aws_account_delete(db:AsyncSession, a_id:int) -> dict:
        try:
            await Aws_Account_Service.services_aws_account_get_by_id(db, a_id)

            # deploys 는 순환 임포트를 피하려고 여기서만 불러온다
            from features.deploys.services import Deploy_Service
            await Deploy_Service.services_deploy_unlink_aws_account(db, a_id)
            await Connection_Crud.crud_connection_unlink_aws_account(db, a_id)

            await Aws_Account_Crud.crud_aws_account_delete(db, a_id)

            await db.commit()
            return {'message': 'AWS 계정 연결 삭제'}

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"AWS 계정 삭제 실패 :{mask_text(str(e))}")


class Github_Service:

    # GitHub App 설치 화면 주소 - 사용자가 여기서 레포를 고르고 설치한다
    @staticmethod
    def services_github_install_url(c_id:int|None=None) -> str:
        # 앱 등록은 서비스 운영자가 한 번 하는 일이다. 안 돼 있으면 깨진 GitHub 주소로 보내지 말고 여기서 알린다
        if not settings.github_app_slug:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                                detail='GitHub 연결이 아직 준비되지 않았습니다. 서비스 운영자가 GitHub App을 등록하고 서버의 .env 에 GITHUB_APP_ID, GITHUB_APP_SLUG, 개인 키를 설정해야 합니다.')

        url=f"https://github.com/apps/{settings.github_app_slug}/installations/new"

        # 어느 블록에서 눌렀는지 state 로 실어 보낸다 - GitHub 가 콜백에 그대로 돌려줘서 그 블록에 잇는다
        return f"{url}?state={c_id}" if c_id else url


    # 앱 전체 JWT - 개인키로 서명. 설치별 토큰을 받을 때만 쓴다 (기획서 03장 - 권한은 최소로)
    @staticmethod
    def services_github_app_jwt() -> str:
        now=int(time.time())
        payload={"iat": now - 60, "exp": now + 600, "iss": settings.github_app_id}
        return jwt.encode(payload, settings.github_app_private_key, algorithm="RS256")


    # 설치 정보 조회 - 계정 이름·설치 범위를 알아야 화면에 보여줄 수 있다
    @staticmethod
    async def services_github_installation_fetch(installation_id:int) -> dict:
        app_jwt=Github_Service.services_github_app_jwt()

        async with httpx.AsyncClient() as client:
            response=await client.get(
                f"https://api.github.com/app/installations/{installation_id}",
                headers={"Authorization": f"Bearer {app_jwt}", "Accept": "application/vnd.github+json"})
            response.raise_for_status()
            return response.json()


    # 설치 정보 저장 - GitHub 콜백에서 installation_id 만 받아서 나머지는 조회해 채운다
    @staticmethod
    async def services_github_installation_upsert(db:AsyncSession, installation_id:int):
        try:
            data=await Github_Service.services_github_installation_fetch(installation_id)
            account=data.get("account") or {}

            installation=await Github_Installation_Crud.crud_github_installation_upsert(
                db, installation_id, account.get("login", "unknown"), account.get("type"), data.get("repository_selection"))

            await db.commit()
            await db.refresh(installation)
            return installation

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"GitHub 설치 확인 실패 :{mask_text(str(e))}")


    # 클론에 쓸 짧은 수명 토큰 (~1시간) - 저장하지 않고 매번 새로 받는다. HTTPException 은 던지지 않는다
    @staticmethod
    async def services_github_installation_token(installation_id:int, permissions:dict|None=None) -> str:
        app_jwt=Github_Service.services_github_app_jwt()
        body={"permissions": permissions or {"contents": "read", "metadata": "read"}}

        try:
            async with httpx.AsyncClient() as client:
                response=await client.post(
                    f"https://api.github.com/app/installations/{installation_id}/access_tokens",
                    headers={"Authorization": f"Bearer {app_jwt}", "Accept": "application/vnd.github+json"},
                    json=body)
                response.raise_for_status()
                return response.json()["token"]

        except httpx.HTTPStatusError as e:
            raise ValueError("GitHub 연결이 끊어졌습니다. 다시 설치해 주세요.") from e


    # 배포에 저장된 g_id(우리 번호)로 설치 토큰 받기 - GitHub API 는 GitHub 의 installation_id 를 받으므로 반드시 여기서 바꿔 준다
    # 다른 기능(deploys, watches)은 이 함수만 쓴다. g_id 를 services_github_installation_token 에 그대로 넘기면 404 로 실패한다 (2026-10-07 실제 계정에서 발견)
    @staticmethod
    async def services_github_token_by_g_id(db:AsyncSession, g_id:int) -> str:
        installation=await Github_Installation_Crud.crud_github_installation_get_by_id(db, g_id)

        if not installation:
            raise ValueError("GitHub 연결이 끊어졌습니다. 다시 설치해 주세요.")

        return await Github_Service.services_github_installation_token(installation.installation_id)


    # 연결 확인 - 설치 토큰을 실제로 받아 접근 가능한 레포를 세어 본다 (연결 직후와 [연결 확인] 버튼)
    @staticmethod
    async def services_github_installation_check(db:AsyncSession, g_id:int) -> Github_Installation_Check:
        installation=await Github_Installation_Crud.crud_github_installation_get_by_id(db, g_id)

        if not installation:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                detail='해당 id의 GitHub 설치가 없습니다')

        try:
            token=await Github_Service.services_github_installation_token(installation.installation_id)

            async with httpx.AsyncClient() as client:
                response=await client.get(
                    "https://api.github.com/installation/repositories",
                    headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
                    params={"per_page": 5})
                response.raise_for_status()
                data=response.json()

        except (ValueError, httpx.HTTPError) as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"GitHub 연결을 확인하지 못했습니다 :{mask_text(str(e))}")

        return Github_Installation_Check(
            g_id=g_id, account_login=installation.account_login, repository_selection=installation.repository_selection,
            repository_count=data.get("total_count", 0),
            repositories=[repo["full_name"] for repo in data.get("repositories", [])])


    # 설치가 읽을 수 있는 레포 전부 - 새 배포 폼이 주소 입력창의 목록으로 보여준다 (100개씩, 최대 1000개)
    @staticmethod
    async def services_github_installation_repositories(db:AsyncSession, g_id:int) -> list[Github_Repository_Read]:
        installation=await Github_Installation_Crud.crud_github_installation_get_by_id(db, g_id)

        if not installation:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                detail='해당 id의 GitHub 설치가 없습니다')

        repositories=[]

        try:
            token=await Github_Service.services_github_installation_token(installation.installation_id)

            async with httpx.AsyncClient() as client:
                for page in range(1, 11):
                    response=await client.get(
                        "https://api.github.com/installation/repositories",
                        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
                        params={"per_page": 100, "page": page})
                    response.raise_for_status()
                    data=response.json()
                    found=data.get("repositories", [])
                    repositories+=found

                    if len(found) < 100 or len(repositories) >= data.get("total_count", 0):
                        break

        except (ValueError, httpx.HTTPError) as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"GitHub 레포 목록을 불러오지 못했습니다 :{mask_text(str(e))}")

        return [Github_Repository_Read(full_name=repo["full_name"],
                                       html_url=repo.get("html_url") or f"https://github.com/{repo['full_name']}",
                                       private=repo.get("private", False), default_branch=repo.get("default_branch"))
                for repo in repositories]


    # 전 GitHub 설치 조회
    @staticmethod
    async def services_github_installation_get_all(db:AsyncSession):
        return await Github_Installation_Crud.crud_github_installation_get_all(db)


    # GitHub 연결 삭제 - 앱 제거는 사용자가 github.com에서 직접 한다 (회수 가능하게, 기획서 03장)
    @staticmethod
    async def services_github_installation_delete(db:AsyncSession, g_id:int) -> dict:
        try:
            installation=await Github_Installation_Crud.crud_github_installation_get_by_id(db, g_id)

            if not installation:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                    detail='해당 id의 GitHub 설치가 없습니다')

            # deploys 는 순환 임포트를 피하려고 여기서만 불러온다
            from features.deploys.services import Deploy_Service
            await Deploy_Service.services_deploy_unlink_github_installation(db, g_id)
            await Connection_Crud.crud_connection_unlink_github_installation(db, g_id)

            await Github_Installation_Crud.crud_github_installation_delete(db, g_id)

            await db.commit()
            return {'message': 'GitHub 연결 삭제'}

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"GitHub 연결 삭제 실패 :{mask_text(str(e))}")


# 연결 블록 - 화면이 "AWS 계정 하나 + GitHub 설치 하나"를 한 묶음으로 다룬다
class Connection_Service:

    # 화면용으로 조립 - 블록에 이어진 AWS 계정·GitHub 설치를 함께 담는다
    @staticmethod
    async def services_connection_to_read(db:AsyncSession, connection) -> Connection_Read:
        account=await Aws_Account_Crud.crud_aws_account_get_by_id(db, connection.aws_account_id) if connection.aws_account_id else None
        installation=(await Github_Installation_Crud.crud_github_installation_get_by_id(db, connection.github_installation_id)
                      if connection.github_installation_id else None)

        return Connection_Read(c_id=connection.c_id, label=connection.label, aws=account, github=installation)


    # 연결 블록 c_id 조회
    @staticmethod
    async def services_connection_get_by_id(db:AsyncSession, c_id:int):
        connection=await Connection_Crud.crud_connection_get_by_id(db, c_id)

        if not connection:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                detail='해당 id의 연결 블록이 없습니다')

        return connection


    # 전 블록 조회 - 블록이 하나도 없는데 AWS 계정만 남아 있으면(블록 도입 전에 연결한 것) 여기서 블록을 만들어 준다
    # 블록이 있을 때 어느 블록에도 안 이어진 계정은 그대로 둔다 - 블록의 AWS 상자에서 넘겨 보고 [선택]할 수 있다
    @staticmethod
    async def services_connection_get_all(db:AsyncSession) -> list[Connection_Read]:
        try:
            connections=await Connection_Crud.crud_connection_get_all(db)
            orphans=await Aws_Account_Crud.crud_aws_account_get_all(db) if not connections else []

            if orphans:
                # 데이터가 AWS 하나·GitHub 하나뿐이면 한 쌍으로 본다. 그 밖에는 GitHub 를 사용자가 블록에서 고른다
                installations=await Github_Installation_Crud.crud_github_installation_get_all(db)
                pair_g_id=installations[0].g_id if len(orphans) == 1 and len(installations) == 1 else None

                for account in reversed(orphans):
                    new_connection=await Connection_Crud.crud_connection_create(db, account.label, account.a_id)

                    if pair_g_id:
                        await Connection_Crud.crud_connection_update(db, new_connection.c_id, {"github_installation_id": pair_g_id})

                await db.commit()
                connections=await Connection_Crud.crud_connection_get_all(db)

            return [await Connection_Service.services_connection_to_read(db, connection) for connection in connections]

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"연결 블록 조회 실패 :{mask_text(str(e))}")


    # 블록 생성 ([+] 버튼) - 빈 블록을 만든다. AWS·GitHub 는 블록 안에서 하나씩 연결한다
    @staticmethod
    async def services_connection_create(db:AsyncSession, payload:Connection_Create) -> Connection_Read:
        try:
            new_connection=await Connection_Crud.crud_connection_create(db, payload.label)

            await db.commit()
            await db.refresh(new_connection)
            return await Connection_Service.services_connection_to_read(db, new_connection)

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"연결 블록 생성 실패 :{mask_text(str(e))}")


    # 블록의 AWS 연결 시작 - 블록 이름으로 AWS 계정을 만들어 잇고, 스택을 만들 때 쓸 값을 한 번만 돌려준다
    @staticmethod
    async def services_connection_create_aws(db:AsyncSession, c_id:int) -> Aws_Account_Setup:
        connection=await Connection_Service.services_connection_get_by_id(db, c_id)

        if connection.aws_account_id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                detail='이 블록에는 이미 AWS 계정이 있습니다. 다시 시작하려면 먼저 AWS 연결을 해제하세요.')

        setup=await Aws_Account_Service.services_aws_account_create(db, Aws_Account_Create(label=connection.label))

        try:
            await Connection_Crud.crud_connection_update(db, c_id, {"aws_account_id": setup.a_id})
            await db.commit()
            return setup

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"AWS 계정 연결 실패 :{mask_text(str(e))}")


    # 블록에 AWS 계정·GitHub 설치를 잇거나 뗀다 - 이미 연결한 것을 [선택]하거나 [연결 해제]. 보내지 않은 쪽은 건드리지 않는다
    # AWS 계정도 GitHub 설치처럼 여러 블록이 같은 것을 가리킬 수 있다
    @staticmethod
    async def services_connection_update(db:AsyncSession, c_id:int, payload:Connection_Update) -> Connection_Read:
        try:
            await Connection_Service.services_connection_get_by_id(db, c_id)
            update_data=payload.model_dump(exclude_unset=True)

            if update_data.get("aws_account_id") is not None:
                await Aws_Account_Service.services_aws_account_get_by_id(db, update_data["aws_account_id"])

            if update_data.get("github_installation_id") is not None:
                installation=await Github_Installation_Crud.crud_github_installation_get_by_id(db, update_data["github_installation_id"])

                if not installation:
                    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                        detail='해당 id의 GitHub 설치가 없습니다')

            update_connection=await Connection_Crud.crud_connection_update(db, c_id, update_data)

            await db.commit()
            await db.refresh(update_connection)
            return await Connection_Service.services_connection_to_read(db, update_connection)

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"연결 블록 수정 실패 :{mask_text(str(e))}")


    # GitHub 설치 콜백에서 - state 로 돌아온 블록에 방금 설치를 잇는다. 블록이 없으면 조용히 넘어간다 (설치 자체는 저장됐다)
    @staticmethod
    async def services_connection_link_github(db:AsyncSession, c_id:int, g_id:int) -> None:
        connection=await Connection_Crud.crud_connection_update(db, c_id, {"github_installation_id": g_id})

        if connection:
            await db.commit()


    # 블록 삭제 - 이 블록의 AWS 계정 연결도 함께 지운다(다른 블록이 같이 쓰는 계정은 남긴다). GitHub 설치는 남긴다. AWS 스택·GitHub 앱은 건드리지 않는다
    @staticmethod
    async def services_connection_delete(db:AsyncSession, c_id:int) -> dict:
        connection=await Connection_Service.services_connection_get_by_id(db, c_id)

        if connection.aws_account_id:
            shared=[other for other in await Connection_Crud.crud_connection_get_all(db)
                    if other.c_id != c_id and other.aws_account_id == connection.aws_account_id]

            if not shared:
                await Aws_Account_Service.services_aws_account_delete(db, connection.aws_account_id)

        try:
            await Connection_Crud.crud_connection_delete(db, c_id)

            await db.commit()
            return {'message': '연결 블록 삭제'}

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"연결 블록 삭제 실패 :{mask_text(str(e))}")
