from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import update

from features.accounts.models import Aws_Account, Github_Installation, Connection


class Aws_Account_Crud:

    # 전 AWS 계정 조회 (최신순)
    @staticmethod
    async def crud_aws_account_get_all(db:AsyncSession) -> list[Aws_Account]:
        result=await db.execute(select(Aws_Account).order_by(Aws_Account.a_id.desc()))
        return result.scalars().all()


    # AWS 계정 a_id 찾기
    @staticmethod
    async def crud_aws_account_get_by_id(db:AsyncSession, a_id:int) -> Aws_Account | None:
        result=await db.execute(select(Aws_Account).filter(Aws_Account.a_id == a_id))
        return result.scalars().first()


    # AWS 계정 생성 - role_arn 은 아직 없는 pending 상태로
    @staticmethod
    async def crud_aws_account_create(db:AsyncSession, label:str, region:str|None, external_id_encrypted:str) -> Aws_Account:
        db_account=Aws_Account(label=label, region=region, external_id_encrypted=external_id_encrypted, status='pending')
        db.add(db_account)
        await db.flush()
        return db_account


    # AWS 계정 업데이트 - role_arn 등록, 검증 결과 저장에 쓴다
    @staticmethod
    async def crud_aws_account_update(db:AsyncSession, a_id:int, update_data:dict) -> Aws_Account | None:
        db_account=await db.get(Aws_Account, a_id)

        if db_account:
            for key, value in update_data.items():
                setattr(db_account, key, value)

            await db.flush()
            return db_account

        return None


    # AWS 계정 삭제
    @staticmethod
    async def crud_aws_account_delete(db:AsyncSession, a_id:int) -> Aws_Account | None:
        db_account=await db.get(Aws_Account, a_id)
        if db_account:
            await db.delete(db_account)
            await db.flush()
            return db_account
        return None


class Github_Installation_Crud:

    # 전 GitHub 설치 조회 (최신순)
    @staticmethod
    async def crud_github_installation_get_all(db:AsyncSession) -> list[Github_Installation]:
        result=await db.execute(select(Github_Installation).order_by(Github_Installation.g_id.desc()))
        return result.scalars().all()


    # GitHub 설치 g_id 찾기
    @staticmethod
    async def crud_github_installation_get_by_id(db:AsyncSession, g_id:int) -> Github_Installation | None:
        result=await db.execute(select(Github_Installation).filter(Github_Installation.g_id == g_id))
        return result.scalars().first()


    # GitHub installation_id 로 찾기 (콜백·웹훅에서 쓴다)
    @staticmethod
    async def crud_github_installation_get_by_installation_id(db:AsyncSession, installation_id:int) -> Github_Installation | None:
        result=await db.execute(select(Github_Installation).filter(Github_Installation.installation_id == installation_id))
        return result.scalars().first()


    # 설치 정보 upsert - 이미 있으면 계정 정보만 갱신
    @staticmethod
    async def crud_github_installation_upsert(db:AsyncSession, installation_id:int, account_login:str,
                                              account_type:str|None, repository_selection:str|None) -> Github_Installation:
        db_installation=await Github_Installation_Crud.crud_github_installation_get_by_installation_id(db, installation_id)

        if db_installation:
            db_installation.account_login=account_login
            db_installation.account_type=account_type
            db_installation.repository_selection=repository_selection
            db_installation.status='active'
            db_installation.suspended_at=None
        else:
            db_installation=Github_Installation(installation_id=installation_id, account_login=account_login,
                                                account_type=account_type, repository_selection=repository_selection)
            db.add(db_installation)

        await db.flush()
        return db_installation


    # 설치 상태 갱신 - 토큰 발급 실패로 suspended/revoked 를 알게 됐을 때
    @staticmethod
    async def crud_github_installation_update_status(db:AsyncSession, g_id:int, status:str, suspended_at=None) -> Github_Installation | None:
        db_installation=await db.get(Github_Installation, g_id)
        if db_installation:
            db_installation.status=status
            db_installation.suspended_at=suspended_at
            await db.flush()
            return db_installation
        return None


    # 설치 삭제
    @staticmethod
    async def crud_github_installation_delete(db:AsyncSession, g_id:int) -> Github_Installation | None:
        db_installation=await db.get(Github_Installation, g_id)
        if db_installation:
            await db.delete(db_installation)
            await db.flush()
            return db_installation
        return None


class Connection_Crud:

    # 전 연결 블록 조회 (만든 순)
    @staticmethod
    async def crud_connection_get_all(db:AsyncSession) -> list[Connection]:
        result=await db.execute(select(Connection).order_by(Connection.c_id))
        return result.scalars().all()


    # 연결 블록 c_id 찾기
    @staticmethod
    async def crud_connection_get_by_id(db:AsyncSession, c_id:int) -> Connection | None:
        result=await db.execute(select(Connection).filter(Connection.c_id == c_id))
        return result.scalars().first()


    # 연결 블록 생성 - 보통 빈 블록으로 만들고, 블록 도입 전 AWS 계정을 옮길 때만 aws_account_id 를 준다
    @staticmethod
    async def crud_connection_create(db:AsyncSession, label:str, aws_account_id:int|None=None) -> Connection:
        db_connection=Connection(label=label, aws_account_id=aws_account_id)
        db.add(db_connection)
        await db.flush()
        return db_connection


    # 연결 블록 업데이트 - AWS 계정·GitHub 설치를 잇거나 뗀다
    @staticmethod
    async def crud_connection_update(db:AsyncSession, c_id:int, update_data:dict) -> Connection | None:
        db_connection=await db.get(Connection, c_id)

        if db_connection:
            for key, value in update_data.items():
                setattr(db_connection, key, value)

            await db.flush()
            return db_connection

        return None


    # 연결 블록 삭제
    @staticmethod
    async def crud_connection_delete(db:AsyncSession, c_id:int) -> Connection | None:
        db_connection=await db.get(Connection, c_id)
        if db_connection:
            await db.delete(db_connection)
            await db.flush()
            return db_connection
        return None


    # AWS 계정이 지워질 때 - 그 계정을 가리키던 블록에서 뗀다
    @staticmethod
    async def crud_connection_unlink_aws_account(db:AsyncSession, a_id:int) -> None:
        await db.execute(update(Connection).where(Connection.aws_account_id == a_id).values(aws_account_id=None))
        await db.flush()


    # GitHub 설치가 지워질 때 - 그 설치를 가리키던 블록에서 뗀다
    @staticmethod
    async def crud_connection_unlink_github_installation(db:AsyncSession, g_id:int) -> None:
        await db.execute(update(Connection).where(Connection.github_installation_id == g_id).values(github_installation_id=None))
        await db.flush()
