from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import update, or_

from features.auth.models import User, Refresh_Token, Api_Token


class Auth_Crud:

    # 사용자 u_id 찾기
    @staticmethod
    async def crud_user_get_by_u_id(db:AsyncSession, u_id:int) -> User | None:
        result=await db.execute(select(User).filter(User.u_id == u_id))
        return result.scalars().first()


    # 사용자를 google_sub 블라인드 인덱스로 찾기
    @staticmethod
    async def crud_user_get_by_google_sub_bidx(db:AsyncSession, google_sub_bidx:str) -> User | None:
        result=await db.execute(select(User).filter(User.google_sub_bidx == google_sub_bidx))
        return result.scalars().first()


    # 사용자를 이메일 블라인드 인덱스로 찾기 - 유일하지 않을 수 있어 목록으로
    @staticmethod
    async def crud_user_get_all_by_email_bidx(db:AsyncSession, email_bidx:str) -> list[User]:
        result=await db.execute(select(User).filter(User.email_bidx == email_bidx).order_by(User.u_id))
        return list(result.scalars().all())


    # 사용자 생성
    @staticmethod
    async def crud_user_create(db:AsyncSession, data:dict) -> User:
        db_user=User(**data)
        db.add(db_user)
        await db.flush()
        return db_user


    # 사용자 업데이트
    @staticmethod
    async def crud_user_update(db:AsyncSession, db_user:User, update_data:dict) -> User:
        for key, value in update_data.items():
            setattr(db_user, key, value)

        await db.flush()
        return db_user


    # 리프레시 토큰 생성 - 원문이 아니라 해시만 받는다
    @staticmethod
    async def crud_refresh_token_create(db:AsyncSession, u_id:int, family_id:str, token_hash:str, platform:str, expires_at:datetime) -> Refresh_Token:
        db_token=Refresh_Token(u_id=u_id, family_id=family_id, token_hash=token_hash, platform=platform, expires_at=expires_at)
        db.add(db_token)
        await db.flush()
        return db_token


    # 리프레시 토큰을 해시로 찾기
    @staticmethod
    async def crud_refresh_token_get_by_hash(db:AsyncSession, token_hash:str) -> Refresh_Token | None:
        result=await db.execute(select(Refresh_Token).filter(Refresh_Token.token_hash == token_hash))
        return result.scalars().first()


    # 리프레시 토큰 하나 폐기 - 아직 폐기 전일 때만 바꾼다. 반환: 바뀐 행 수 (동시 요청 중 1 을 받은 쪽만 이긴다)
    @staticmethod
    async def crud_refresh_token_revoke(db:AsyncSession, r_t_id:int, now:datetime) -> int:
        result=await db.execute(update(Refresh_Token)
                                .where(Refresh_Token.r_t_id == r_t_id, Refresh_Token.revoked_at.is_(None))
                                .values(revoked_at=now)
                                .execution_options(synchronize_session=False))
        return result.rowcount


    # 회전 기록 - 옛 토큰이 어느 새 토큰으로 바뀌었는지
    @staticmethod
    async def crud_refresh_token_set_replaced_by(db:AsyncSession, r_t_id:int, replaced_by:int) -> int:
        result=await db.execute(update(Refresh_Token)
                                .where(Refresh_Token.r_t_id == r_t_id)
                                .values(replaced_by=replaced_by)
                                .execution_options(synchronize_session=False))
        return result.rowcount


    # 계열 전체 폐기 - 아직 살아 있는 것만. 반환: 바뀐 행 수
    @staticmethod
    async def crud_refresh_token_revoke_family(db:AsyncSession, family_id:str, now:datetime) -> int:
        result=await db.execute(update(Refresh_Token)
                                .where(Refresh_Token.family_id == family_id, Refresh_Token.revoked_at.is_(None))
                                .values(revoked_at=now)
                                .execution_options(synchronize_session=False))
        return result.rowcount


    # 개인 토큰 생성 - 원문이 아니라 해시와 끝 4자리만 받는다
    @staticmethod
    async def crud_api_token_create(db:AsyncSession, u_id:int, name:str, token_hash:str, last4:str, expires_at:datetime | None) -> Api_Token:
        db_token=Api_Token(u_id=u_id, name=name, token_hash=token_hash, last4=last4, expires_at=expires_at)
        db.add(db_token)
        await db.flush()
        return db_token


    # 개인 토큰을 해시로 찾기
    @staticmethod
    async def crud_api_token_get_by_hash(db:AsyncSession, token_hash:str) -> Api_Token | None:
        result=await db.execute(select(Api_Token).filter(Api_Token.token_hash == token_hash))
        return result.scalars().first()


    # 개인 토큰 a_t_id 찾기
    @staticmethod
    async def crud_api_token_get_by_a_t_id(db:AsyncSession, a_t_id:int) -> Api_Token | None:
        result=await db.execute(select(Api_Token).filter(Api_Token.a_t_id == a_t_id))
        return result.scalars().first()


    # 사용자의 살아 있는(폐기 전) 개인 토큰 목록 - 최근 것부터
    @staticmethod
    async def crud_api_token_get_all_by_u_id(db:AsyncSession, u_id:int) -> list[Api_Token]:
        result=await db.execute(select(Api_Token)
                                .filter(Api_Token.u_id == u_id, Api_Token.revoked_at.is_(None))
                                .order_by(Api_Token.a_t_id.desc()))
        return list(result.scalars().all())


    # 개인 토큰 폐기 - 아직 폐기 전일 때만. 반환: 바뀐 행 수
    @staticmethod
    async def crud_api_token_revoke(db:AsyncSession, a_t_id:int, now:datetime) -> int:
        result=await db.execute(update(Api_Token)
                                .where(Api_Token.a_t_id == a_t_id, Api_Token.revoked_at.is_(None))
                                .values(revoked_at=now)
                                .execution_options(synchronize_session=False))
        return result.rowcount


    # 개인 토큰 마지막 사용 시각 - 마지막 갱신이 기준 시각(before)보다 오래됐을 때만 바꾼다. 반환: 바뀐 행 수
    @staticmethod
    async def crud_api_token_touch(db:AsyncSession, a_t_id:int, now:datetime, before:datetime) -> int:
        result=await db.execute(update(Api_Token)
                                .where(Api_Token.a_t_id == a_t_id,
                                       or_(Api_Token.last_used_at.is_(None), Api_Token.last_used_at < before))
                                .values(last_used_at=now)
                                .execution_options(synchronize_session=False))
        return result.rowcount
