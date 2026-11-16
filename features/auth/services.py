import secrets as py_secrets
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, Request, status

from sqlalchemy.ext.asyncio import AsyncSession

from shared.database import get_db
from shared.settings import settings
from shared.secrets import blind_index, token_hash
from shared.masking import mask_text

from features.auth import google
from features.auth.google import Google_Auth_Error
from features.auth.crud import Auth_Crud
from features.auth.models import User
from features.auth.scheme import LOGIN_PLATFORMS, Auth_Token, User_Read, Current_User, Api_Token_Create, Api_Token_Read, Api_Token_Issued

# 로그인 (로그인 계획 Task 3) - Google id_token 으로 사용자를 찾거나 만들고, 액세스 JWT + 회전하는 리프레시 토큰을 준다
# 토큰 원문·id_token·이메일은 로그·오류 문구에 싣지 않는다. 리프레시 토큰은 SHA-256 hex 만 저장한다

ACCESS_ALGORITHM="HS256"
ACCESS_ISSUER="deploy-wizard"
ACCESS_AUDIENCE="deploy-wizard-api"
ACCESS_TYPE="access"
REFRESH_PREFIX="dwr_"
PAT_PREFIX="dwp_"
# 개인 토큰 마지막 사용 시각 갱신 간격 (매 요청마다 쓰지 않게)
PAT_TOUCH_SECONDS=60

# 인증 없이 열린 경로 (로그인 계획 Task 4). 여기에 없는 /api 경로는 모두 services_auth_current_user 를 거쳐야 한다 (tests/test_auth_current_user.py 가 지킨다)
# 웹훅은 서명(GITHUB_WEBHOOK_SECRET), GitHub 콜백은 서명된 state(Task 6), 템플릿은 사용자 정보 없는 정적 파일
PUBLIC_PATHS={"/api/health", "/api/watches/webhook", "/api/accounts/github/callback", "/api/accounts/aws/template",
              "/api/auth/google", "/api/auth/refresh", "/api/auth/logout"}

MESSAGE_EXPIRED="로그인이 만료되었습니다. 다시 로그인해 주세요"
MESSAGE_LOGIN_REQUIRED="로그인이 필요합니다"
MESSAGE_NOT_ALLOWED="로그인이 허용된 계정이 아닙니다"
MESSAGE_ORIGIN="허용되지 않은 출처입니다"
MESSAGE_PAT_MANAGE="개인 토큰으로는 개인 토큰을 관리할 수 없습니다. 로그인해서 관리해 주세요"
MESSAGE_PAT_NOT_FOUND="개인 토큰을 찾을 수 없습니다"
MESSAGE_JWT_KEY_MISSING="로그인 설정이 완료되지 않았습니다 (AUTH_JWT_KEY 확인)"
MESSAGE_DELETE_CONFIRM="계정을 삭제하려면 confirm 에 true 를 보내야 합니다"
MESSAGE_DELETE_LIVE="먼저 멈추거나 삭제해야 하는 서비스가 있습니다"
MESSAGE_DELETE_DONE="계정을 삭제했습니다. AWS CloudFormation 스택과 GitHub 앱 설치는 직접 지워 주세요"
# 탈퇴한 사용자 행에 남기는 값 - 개인 정보 대신 (암호화 열은 NOT NULL 이라 비울 수 없다). 블라인드 인덱스는 사용자마다 달라 같은 Google 계정이 새 사용자로 다시 가입할 수 있다
DELETED_VALUE="deleted"


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


    # 401 - 로그인이 필요하다 (Bearer 로 다시 보내라는 헤더를 붙인다)
    @staticmethod
    def services_auth_unauthorized() -> HTTPException:
        return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=MESSAGE_LOGIN_REQUIRED,
                             headers={"WWW-Authenticate": "Bearer"})


    # Authorization: Bearer 에서 토큰을 꺼낸다 - 없거나 다른 방식이면 401
    @staticmethod
    def services_auth_bearer_pick(request:Request) -> str:
        scheme, _, token=(request.headers.get("authorization") or "").partition(" ")
        token=token.strip()
        if scheme.lower() != "bearer" or not token:
            raise Auth_Service.services_auth_unauthorized()
        return token


    # 개인 토큰 확인 - 해시로 찾고 폐기·만료면 401. 마지막 사용 시각은 1분에 한 번까지만 갱신한다. 반환: u_id
    @staticmethod
    async def services_auth_pat_check(db:AsyncSession, raw:str) -> int:
        now=Auth_Service.services_auth_now()
        db_token=await Auth_Crud.crud_api_token_get_by_hash(db, token_hash(raw))
        if db_token is None or db_token.revoked_at is not None or (db_token.expires_at is not None and db_token.expires_at <= now):
            raise Auth_Service.services_auth_unauthorized()

        # 갱신할 때만 UPDATE 하고 바로 커밋한다 - 건너뛸 때 UPDATE 를 보내면 쓰기 트랜잭션이 요청 끝까지 열려 SQLite 쓰기 잠금을 붙든다
        before=now - timedelta(seconds=PAT_TOUCH_SECONDS)
        if db_token.last_used_at is None or db_token.last_used_at < before:
            await Auth_Crud.crud_api_token_touch(db, db_token.a_t_id, now, before)
            await db.commit()
        return db_token.u_id


    # Bearer 토큰으로 사용자 확인 - dwp_ 면 개인 토큰, 아니면 액세스 JWT. 사용자가 없거나 active 가 아니면 401
    # 개인 토큰은 오래 살아서 허용 목록(AUTH_ALLOWED_EMAILS)도 매번 다시 본다 (리프레시와 같은 규칙)
    @staticmethod
    async def services_auth_bearer_user(request:Request, db:AsyncSession) -> Current_User:
        try:
            raw=Auth_Service.services_auth_bearer_pick(request)

            if raw.startswith(PAT_PREFIX):
                u_id=await Auth_Service.services_auth_pat_check(db, raw)
                via="pat"
            else:
                u_id=Auth_Service.services_auth_access_decode(raw)
                via="access"

            db_user=await Auth_Crud.crud_user_get_by_u_id(db, u_id)
            if db_user is None or db_user.status != "active":
                raise Auth_Service.services_auth_unauthorized()
            if via == "pat" and db_user.email not in settings.auth_allowed_email_set:
                raise Auth_Service.services_auth_unauthorized()

            return Current_User(u_id=u_id, via=via)

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"로그인 확인 실패 :{mask_text(str(e))[:200]}")


    # 현재 사용자 - 모든 보호 라우트가 Depends 로 쓰는 단 하나의 함수. AUTH_ENABLED=false 면 지금처럼 사용자 없이(필터 없음)
    @staticmethod
    async def services_auth_current_user(request:Request, db:AsyncSession=Depends(get_db)) -> Current_User:
        if not settings.auth_enabled:
            return Current_User(u_id=None, via="off")
        return await Auth_Service.services_auth_bearer_user(request, db)


    # 로그인 사용자가 꼭 필요한 곳(/api/me·개인 토큰) - 꺼진 모드에서도 Bearer 를 확인한다
    @staticmethod
    async def services_auth_login_user(request:Request, db:AsyncSession=Depends(get_db),
                                       user:Current_User=Depends(services_auth_current_user.__func__)) -> Current_User:
        if user.u_id is not None:
            return user
        return await Auth_Service.services_auth_bearer_user(request, db)


    # 사용자 u_id 가 꼭 있어야 한다 - 없으면 401
    @staticmethod
    def services_auth_require_user(user:Current_User) -> int:
        if user.u_id is None:
            raise Auth_Service.services_auth_unauthorized()
        return user.u_id


    # 개인 토큰 관리는 로그인(액세스 토큰)으로만 - 개인 토큰으로는 403 (새어 나간 토큰이 스스로 늘어나지 않게)
    @staticmethod
    def services_auth_require_access(user:Current_User) -> int:
        u_id=Auth_Service.services_auth_require_user(user)
        if user.via == "pat":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=MESSAGE_PAT_MANAGE)
        return u_id


    # 서버 시작 검사 - 암호화 열·블라인드 인덱스는 어느 모드에서나 쓰므로 SECRET_KEY·BLIND_INDEX_KEY 는 항상, AUTH_JWT_KEY 는 로그인을 켰을 때만 필요하다
    @staticmethod
    def services_auth_startup_check() -> None:
        missing=[name for name, value in (("SECRET_KEY", settings.secret_key), ("BLIND_INDEX_KEY", settings.blind_index_key)) if not value]
        if missing:
            raise RuntimeError(f"서버를 시작하려면 .env 에 {', '.join(missing)} 가 필요합니다. "
                               f"SECRET_KEY 생성: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\" / "
                               f"BLIND_INDEX_KEY 생성: python -c \"import secrets; print(secrets.token_urlsafe(48))\"")

        if settings.auth_enabled and not settings.auth_jwt_key:
            raise RuntimeError("로그인을 켜려면 .env 에 AUTH_JWT_KEY 가 필요합니다 (AUTH_ENABLED=true). "
                               "생성: python -c \"import secrets; print(secrets.token_urlsafe(48))\"")
        return None


    # 이메일로 사용자 찾기 - 블라인드 인덱스로만 (스크립트용). active 인 사용자만
    @staticmethod
    async def services_auth_user_get_by_email(db:AsyncSession, email:str) -> User | None:
        for db_user in await Auth_Crud.crud_user_get_all_by_email_bidx(db, blind_index("email", email)):
            if db_user.status == "active":
                return db_user
        return None


    # 사용자 이메일 (복호화한 값) - 알림 메일 받는 사람. 없거나 탈퇴한 사용자면 None. 주소는 로그·오류에 싣지 않는다
    @staticmethod
    async def services_auth_user_email(db:AsyncSession, u_id:int) -> str | None:
        db_user=await Auth_Crud.crud_user_get_by_u_id(db, u_id)
        if db_user is None or db_user.status != "active":
            return None
        return db_user.email


    # 개인 토큰 발급 - 원문은 이 응답에만, DB 에는 해시와 끝 4자리. 기간은 기본 AUTH_PAT_DEFAULT_DAYS, 상한 AUTH_PAT_MAX_DAYS
    @staticmethod
    async def services_auth_token_create(db:AsyncSession, u_id:int, data:Api_Token_Create) -> Api_Token_Issued:
        try:
            days=data.expires_in_days or settings.auth_pat_default_days
            if days > settings.auth_pat_max_days:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                    detail=f"개인 토큰 기간은 최대 {settings.auth_pat_max_days}일입니다")

            raw=PAT_PREFIX + py_secrets.token_urlsafe(32)
            now=Auth_Service.services_auth_now()
            db_token=await Auth_Crud.crud_api_token_create(db, u_id, data.name, token_hash(raw), raw[-4:], now + timedelta(days=days))

            await db.commit()
            await db.refresh(db_token)
            return Api_Token_Issued(**Api_Token_Read.model_validate(db_token).model_dump(), token=raw)

        except HTTPException:
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"개인 토큰 발급 실패 :{mask_text(str(e))[:200]}")


    # 개인 토큰 목록 - 폐기 전 것만, 원문 없이
    @staticmethod
    async def services_auth_token_list(db:AsyncSession, u_id:int) -> list[Api_Token_Read]:
        return [Api_Token_Read.model_validate(db_token) for db_token in await Auth_Crud.crud_api_token_get_all_by_u_id(db, u_id)]


    # 개인 토큰 폐기 - 남의 것·없는 것·이미 폐기한 것은 404 (존재를 숨긴다)
    @staticmethod
    async def services_auth_token_revoke(db:AsyncSession, u_id:int, a_t_id:int) -> dict:
        db_token=await Auth_Crud.crud_api_token_get_by_a_t_id(db, a_t_id)
        if db_token is None or db_token.u_id != u_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=MESSAGE_PAT_NOT_FOUND)

        return await Auth_Service.services_auth_token_revoke_local(db, a_t_id)


    # 개인 토큰 폐기 (소유자 확인 없이) - 소유자를 이미 확인한 곳과 로컬 스크립트(scripts/auth_token.py)만 쓴다
    @staticmethod
    async def services_auth_token_revoke_local(db:AsyncSession, a_t_id:int) -> dict:
        try:
            won=await Auth_Crud.crud_api_token_revoke(db, a_t_id, Auth_Service.services_auth_now())
            if won != 1:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=MESSAGE_PAT_NOT_FOUND)

            await db.commit()
            return {"message": "개인 토큰을 폐기했습니다"}

        except HTTPException:
            await db.rollback()
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"개인 토큰 폐기 실패 :{mask_text(str(e))[:200]}")


    # 계정 삭제 확인 - 본문이 {"confirm": true} 일 때만 통과, 그 밖은 모두 400 (깨진 JSON·없는 본문 포함)
    @staticmethod
    def services_auth_delete_confirm(body) -> None:
        if not isinstance(body, dict) or body.get("confirm") is not True:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=MESSAGE_DELETE_CONFIRM)


    # 살아 있는 배포가 있으면 409 - 목록(d_id·서비스 이름)을 detail 문자열에 담는다 (dict detail 관례가 없다)
    @staticmethod
    def services_auth_delete_live_check(live:list) -> None:
        if live:
            names=", ".join(f"#{deploy.d_id} {deploy.service_name or deploy.repo_url}" for deploy in live)
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{MESSAGE_DELETE_LIVE}: {names}")


    # 계정 삭제 - 기록만 지우고 AWS·GitHub 는 한 번도 부르지 않는다 (Hard rule 3, 03장). 한 트랜잭션으로 한 번만 커밋하고, 하나라도 실패하면 전부 되돌린다
    # 사용자 행은 남기되 개인 정보를 지우고 status="deleted" (같은 Google 계정은 새 사용자로 다시 가입), 리프레시·개인 토큰은 모두 폐기한다
    @staticmethod
    async def services_auth_account_delete(db:AsyncSession, u_id:int) -> dict:
        # 다른 기능의 services 는 이 파일을 import 하거나(notifications) 되불러오므로(deploys) 순환을 피하려고 여기서만 불러온다
        from features.deploys.services import Deploy_Service
        from features.accounts.services import Aws_Account_Service
        from features.notifications.services import Notification_Service

        try:
            db_user=await Auth_Crud.crud_user_get_by_u_id(db, u_id)
            if db_user is None or db_user.status != "active":
                raise Auth_Service.services_auth_unauthorized()

            # 1. 살아 있는 배포가 있으면 막는다 (요금이 계속 나가므로 먼저 멈추거나 삭제)
            Auth_Service.services_auth_delete_live_check(await Deploy_Service.services_deploy_live_for_user(db, u_id))

            # 2. 기록 삭제 - 기능마다 flush 만, 커밋은 아래에서 한 번
            deploys=await Deploy_Service.services_deploy_forget_user(db, u_id)
            accounts=await Aws_Account_Service.services_account_forget_user(db, u_id)
            notifications=await Notification_Service.services_notification_forget_user(db, u_id)

            # 3. 그 사이에 살아난 배포가 없는지 한 번 더 - 있으면 전부 되돌린다
            Auth_Service.services_auth_delete_live_check(await Deploy_Service.services_deploy_live_for_user(db, u_id))

            # 4. 토큰 폐기 + 사용자 행 익명화
            now=Auth_Service.services_auth_now()
            await Auth_Crud.crud_refresh_token_revoke_all_by_u_id(db, u_id, now)
            await Auth_Crud.crud_api_token_revoke_all_by_u_id(db, u_id, now)
            deleted_bidx=blind_index(DELETED_VALUE, str(u_id))
            await Auth_Crud.crud_user_update(db, db_user, {"status": "deleted", "name": None, "picture_url": None,
                                                          "google_sub": DELETED_VALUE, "email": DELETED_VALUE,
                                                          "google_sub_bidx": deleted_bidx, "email_bidx": deleted_bidx})

            await db.commit()
            return {"message": MESSAGE_DELETE_DONE, "deleted": {"deploys": deploys, "accounts": accounts, "notifications": notifications}}

        except HTTPException:
            await db.rollback()
            raise

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"계정 삭제 실패 :{mask_text(str(e))[:200]}")
