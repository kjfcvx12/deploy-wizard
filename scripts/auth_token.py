import sys
import asyncio
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError

from shared.database import AsyncSessionLocal, bootstrap_schema
from shared.masking import mask_text
from shared.settings import settings

# 모델을 import 해야 create_all 이 표를 안다
from features.deploys import models as deploy_models
from features.accounts import models as account_models
from features.envvars import models as envvar_models
from features.health import models as health_models
from features.incidents import models as incident_models
from features.notifications import models as notification_models
from features.auth import models as auth_models

from features.auth.scheme import Api_Token_Create, Api_Token_Read
from features.auth.services import Auth_Service

# MCP 개인 토큰(PAT) - 웹 로그인 화면이 생기기 전에 MCP 용 토큰을 받는 길 (로그인 계획 Task 4)
# DB 는 settings.db_url (.env 의 DB_URL). 사용자는 먼저 Google 로그인(POST /api/auth/google)으로 만들어져 있어야 한다
# 토큰 원문은 create 때 표준 출력에 한 번만 나온다. DB 에는 해시만 남는다
#
# python scripts/auth_token.py create --email <주소> --name mcp [--days 30]
# python scripts/auth_token.py list --email <주소>
# python scripts/auth_token.py revoke --id <a_t_id>


# 안내문에 보여 줄 DB 위치 - sqlite 는 파일 경로, 그 밖은 종류와 호스트만. 사용자 이름·비밀번호·옵션은 싣지 않는다
def script_db_label(db_url:str) -> str:
    try:
        url=make_url(db_url)
    except ArgumentError:
        return "DB 주소를 읽을 수 없습니다"

    if url.get_backend_name() == "sqlite":
        return mask_text(f"sqlite {url.database or ':memory:'}")

    host=f"{url.host}:{url.port}" if url.host and url.port else (url.host or "")
    return mask_text(f"{url.drivername} {host}/{url.database or ''}")


# 이메일로 active 사용자를 찾는다 - 없으면 한국어 오류
async def script_user_u_id(db, email:str) -> int:
    db_user=await Auth_Service.services_auth_user_get_by_email(db, email)
    if db_user is None:
        raise RuntimeError("그 이메일의 사용자가 없습니다. 먼저 Google 로그인을 한 번 해 주세요")
    return db_user.u_id


# HTTPException 을 스크립트용 오류(한국어 문구)로 바꾼다
def script_error(e:HTTPException) -> RuntimeError:
    return RuntimeError(str(e.detail))


# 개인 토큰 발급 - 반환: 토큰 원문
async def script_token_create(email:str, name:str, days:int | None=None) -> str:
    try:
        data=Api_Token_Create(name=name, expires_in_days=days)
    except ValidationError:
        raise RuntimeError("이름은 1~50자, 기간은 1일 이상이어야 합니다") from None

    async with AsyncSessionLocal() as db:
        try:
            issued=await Auth_Service.services_auth_token_create(db, await script_user_u_id(db, email), data)
        except HTTPException as e:
            raise script_error(e) from None
        return issued.token


# 개인 토큰 목록 (폐기 전 것만)
async def script_token_list(email:str) -> list[Api_Token_Read]:
    async with AsyncSessionLocal() as db:
        return await Auth_Service.services_auth_token_list(db, await script_user_u_id(db, email))


# 개인 토큰 폐기
async def script_token_revoke(a_t_id:int) -> None:
    async with AsyncSessionLocal() as db:
        try:
            await Auth_Service.services_auth_token_revoke_local(db, a_t_id)
        except HTTPException as e:
            raise script_error(e) from None


# 명령 하나 실행 - 서버 시작과 같은 표 준비 후
async def script_main(args) -> None:
    await bootstrap_schema()

    if args.command == "create":
        print(await script_token_create(args.email, args.name, args.days))
        print(f"위 토큰은 지금 한 번만 보입니다. MCP 설정에 넣어 두세요 (DB: {script_db_label(settings.db_url)})", file=sys.stderr)
    elif args.command == "list":
        for item in await script_token_list(args.email):
            print(f"{item.a_t_id}\t{item.name}\t…{item.last4}\t만료 {item.expires_at}\t마지막 사용 {item.last_used_at or '-'}")
    else:
        await script_token_revoke(args.id)
        print("개인 토큰을 폐기했습니다")


# 명령줄 인자
def script_args(argv=None):
    parser=argparse.ArgumentParser(description="MCP 개인 토큰 발급·목록·폐기")
    commands=parser.add_subparsers(dest="command", required=True)

    create=commands.add_parser("create", help="새 토큰 발급 (원문은 한 번만 출력)")
    create.add_argument("--email", required=True)
    create.add_argument("--name", default="mcp")
    create.add_argument("--days", type=int, default=None)

    listing=commands.add_parser("list", help="토큰 목록")
    listing.add_argument("--email", required=True)

    revoke=commands.add_parser("revoke", help="토큰 폐기")
    revoke.add_argument("--id", type=int, required=True)

    return parser.parse_args(argv)


if __name__ == "__main__":
    try:
        asyncio.run(script_main(script_args()))
    except RuntimeError as e:
        print(e, file=sys.stderr)
        sys.exit(1)
