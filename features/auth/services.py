import secrets as py_secrets
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import HTTPException, status

from sqlalchemy.ext.asyncio import AsyncSession

from shared.settings import settings
from shared.secrets import blind_index, token_hash
from shared.masking import mask_text

from features.auth import google
from features.auth.google import Google_Auth_Error
from features.auth.crud import Auth_Crud
from features.auth.models import User
from features.auth.scheme import LOGIN_PLATFORMS, Auth_Token, User_Read

# 로그인 (로그인 계획 Task 3) - Google id_token 으로 사용자를 찾거나 만들고, 액세스 JWT + 회전하는 리프레시 토큰을 준다
# 토큰 원문·id_token·이메일은 로그·오류 문구에 싣지 않는다. 리프레시 토큰은 SHA-256 hex 만 저장한다

ACCESS_ALGORITHM="HS256"
ACCESS_ISSUER="deploy-wizard"
ACCESS_AUDIENCE="deploy-wizard-api"
ACCESS_TYPE="access"
REFRESH_PREFIX="dwr_"

MESSAGE_EXPIRED="로그인이 만료되었습니다. 다시 로그인해 주세요"
MESSAGE_LOGIN_REQUIRED="로그인이 필요합니다"
MESSAGE_NOT_ALLOWED="로그인이 허용된 계정이 아닙니다"
MESSAGE_ORIGIN="허용되지 않은 출처입니다"
MESSAGE_JWT_KEY_MISSING="로그인 설정이 완료되지 않았습니다 (AUTH_JWT_KEY 확인)"


class Auth_Service:

    # 지금 시각 (UTC, DB 에 맞춰 시간대 없이)
    @staticmethod
    def services_auth_now() -> datetime:
        return datetime.now(timezone.utc).replace(tzinfo=None)


    # 플랫폼의 Google 클라이언트 ID - 그 플랫폼 것만 aud 로 받는다 (설정이 없으면 빈 모음 -> 검증기가 503)
    @staticmethod
    def services_auth_client_ids(platform:str) -> set[str]:
        name=LOGIN_PLATFORMS.get(platform)
        value=getattr(settings, name, None) if name else None
        return {value.strip()} if isinstance(value, str) and value.strip() else set()


    # 쿠키로 온 요청의 출처 확인 - Origin 이 CORS 허용 목록에 있어야 한다 (없거나 밖이면 403)
    @staticmethod
    def services_auth_origin_check(origin:str | None) -> None:
        if not origin or origin not in settings.cors_origin_list:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=MESSAGE_ORIGIN)


    # 액세스 토큰 발급 - HS256, 클레임 sub(u_id 문자열)·typ·iss·aud·iat·exp
    @staticmethod
    def services_auth_access_issue(u_id:int, now:datetime | None=None) -> str:
        if not settings.auth_jwt_key:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=MESSAGE_JWT_KEY_MISSING)

        now=now or datetime.now(timezone.utc)
        if now.tzinfo is None:
            now=now.replace(tzinfo=timezone.utc)
        issued_at=int(now.timestamp())

        claims={"sub": str(u_id), "typ": ACCESS_TYPE, "iss": ACCESS_ISSUER, "aud": ACCESS_AUDIENCE,
                "iat": issued_at, "exp": issued_at + settings.auth_access_seconds}
        return jwt.encode(claims, settings.auth_jwt_key, algorithm=ACCESS_ALGORITHM)


    # 액세스 토큰 확인 - 서명·만료·iss·aud·typ 이 맞으면 u_id, 아니면 401
    @staticmethod
    def services_auth_access_decode(token:str) -> int:
        unauthorized=HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=MESSAGE_LOGIN_REQUIRED,
                                   headers={"WWW-Authenticate": "Bearer"})
        if not settings.auth_jwt_key or not token:
            raise unauthorized

        try:
            claims=jwt.decode(token, settings.auth_jwt_key, algorithms=[ACCESS_ALGORITHM], audience=ACCESS_AUDIENCE, issuer=ACCESS_ISSUER,
                              options={"require": ["exp", "iat", "sub", "typ", "iss", "aud"]})
        except jwt.PyJWTError:
            raise unauthorized from None

        sub=claims.get("sub")
        if claims.get("typ") != ACCESS_TYPE or not isinstance(sub, str) or not sub.isdigit():
            raise unauthorized

        return int(sub)


    # 리프레시 토큰 발급 - 원문은 돌려주기만 하고 DB 에는 해시만 넣는다 (flush 까지)
    @staticmethod
    async def services_auth_refresh_issue(db:AsyncSession, u_id:int, family_id:str, platform:str, now:datetime):
        raw=REFRESH_PREFIX + py_secrets.token_urlsafe(32)
        db_token=await Auth_Crud.crud_refresh_token_create(db, u_id, family_id, token_hash(raw), platform,
                                                         now + timedelta(days=settings.auth_refresh_days))
        return db_token, raw


    # 응답 모양 - 리프레시 원문은 일단 본문에 넣고, 웹이면 라우터가 쿠키로 옮긴다
    @staticmethod
    def services_auth_token_build(db_user:User, raw:str) -> Auth_Token:
        return Auth_Token(access_token=Auth_Service.services_auth_access_issue(db_user.u_id),
                          expires_in=settings.auth_access_seconds,
                          refresh_token=raw,
                          user=User_Read.model_validate(db_user))


    # Google 로그인 - 검증 -> 허용 목록 -> 사용자 찾기/만들기 -> 새 계열로 토큰 발급
    @staticmethod
    async def services_auth_google_login(db:AsyncSession, id_token:str, platform:str) -> tuple[Auth_Token, str]:
        try:
            # 1. Google 검증 (그 플랫폼의 클라이언트 ID 만 aud 로)
            try:
                identity=await google.GOOGLE_VERIFIER.verifier_google_verify(id_token, Auth_Service.services_auth_client_ids(platform))
            except Google_Auth_Error as e:
                raise HTTPException(status_code=e.status_code, detail=e.message) from None

            # 2. 허용 목록 (D-L1)
            email=identity.email.strip().lower()
            if email not in settings.auth_allowed_email_set:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=MESSAGE_NOT_ALLOWED)

            # 3. 사용자 찾기/만들기 - 있으면 이메일·이름·사진을 최신으로
            now=Auth_Service.services_auth_now()
            profile={"email": email, "email_bidx": blind_index("email", email),
                     "name": identity.name, "picture_url": identity.picture_url, "last_login_at": now}

            db_user=await Auth_Crud.crud_user_get_by_google_sub_bidx(db, blind_index("google_sub", identity.sub))
            if db_user is None:
                db_user=await Auth_Crud.crud_user_create(db, {**profile, "google_sub": identity.sub,
                                                               "google_sub_bidx": blind_index("google_sub", identity.sub), "status": "active"})
            elif db_user.status != "active":
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=MESSAGE_NOT_ALLOWED)
            else:
                db_user=await Auth_Crud.crud_user_update(db, db_user, profile)

            # 4. 새 계열의 리프레시 토큰
            _, raw=await Auth_Service.services_auth_refresh_issue(db, db_user.u_id, py_secrets.token_hex(16), platform, now)

            await db.commit()
            await db.refresh(db_user)
            return Auth_Service.services_auth_token_build(db_user, raw), raw

        except HTTPException:
            await db.rollback()
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"로그인 실패 :{mask_text(str(e))[:200]}")


    # 리프레시 - 회전한다. 이미 폐기된 토큰이 다시 오면 그 계열 전체를 폐기하고 401
    @staticmethod
    async def services_auth_refresh(db:AsyncSession, refresh_token:str | None) -> tuple[Auth_Token, str]:
        expired=HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=MESSAGE_EXPIRED)
        try:
            if not refresh_token:
                raise expired

            now=Auth_Service.services_auth_now()
            db_token=await Auth_Crud.crud_refresh_token_get_by_hash(db, token_hash(refresh_token))
            if db_token is None:
                raise expired

            # 1. 재사용 - 도난을 의심해 계열 전체를 끊는다 (폐기를 남긴 뒤 401)
            if db_token.revoked_at is not None:
                await Auth_Crud.crud_refresh_token_revoke_family(db, db_token.family_id, now)
                await db.commit()
                raise expired

            if db_token.expires_at <= now:
                raise expired

            # 2. 사용자가 살아 있고 아직 허용 목록에 있어야 한다 (D-L1) - 아니면 그 계열도 끊는다
            db_user=await Auth_Crud.crud_user_get_by_u_id(db, db_token.u_id)
            if db_user is None or db_user.status != "active" or db_user.email not in settings.auth_allowed_email_set:
                await Auth_Crud.crud_refresh_token_revoke_family(db, db_token.family_id, now)
                await db.commit()
                raise expired

            # 3. 옛 토큰 폐기 - 영향 행이 1 인 요청만 이긴다 (동시 요청의 나머지는 401, 재사용이 아니므로 계열은 그대로 둔다)
            won=await Auth_Crud.crud_refresh_token_revoke(db, db_token.r_t_id, now)
            if won != 1:
                raise expired

            # 4. 같은 계열의 새 토큰 + 회전 기록
            new_token, raw=await Auth_Service.services_auth_refresh_issue(db, db_user.u_id, db_token.family_id, db_token.platform, now)
            await Auth_Crud.crud_refresh_token_set_replaced_by(db, db_token.r_t_id, new_token.r_t_id)

            await db.commit()
            return Auth_Service.services_auth_token_build(db_user, raw), raw

        except HTTPException:
            await db.rollback()
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"로그인 연장 실패 :{mask_text(str(e))[:200]}")


    # 로그아웃 - 그 토큰의 계열을 폐기한다. 없거나 모르는 토큰이어도 조용히 끝낸다 (멱등)
    @staticmethod
    async def services_auth_logout(db:AsyncSession, refresh_token:str | None) -> None:
        try:
            if not refresh_token:
                return None

            db_token=await Auth_Crud.crud_refresh_token_get_by_hash(db, token_hash(refresh_token))
            if db_token is None:
                return None

            await Auth_Crud.crud_refresh_token_revoke_family(db, db_token.family_id, Auth_Service.services_auth_now())
            await db.commit()
            return None

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"로그아웃 실패 :{mask_text(str(e))[:200]}")


    # 내 정보 - 없거나 탈퇴한 사용자면 401
    @staticmethod
    async def services_auth_me(db:AsyncSession, u_id:int) -> User_Read:
        db_user=await Auth_Crud.crud_user_get_by_u_id(db, u_id)
        if db_user is None or db_user.status != "active":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=MESSAGE_LOGIN_REQUIRED,
                                headers={"WWW-Authenticate": "Bearer"})
        return User_Read.model_validate(db_user)
