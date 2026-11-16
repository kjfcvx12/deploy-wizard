import asyncio
import time
from typing import Awaitable, Callable

import httpx
import jwt
from pydantic import BaseModel

from shared.settings import settings


GOOGLE_DISCOVERY_URL="https://accounts.google.com/.well-known/openid-configuration"
# Google 이 id_token 의 iss 로 쓰는 두 값 (Google OpenID Connect 문서)
GOOGLE_ISSUERS=("https://accounts.google.com", "accounts.google.com")
GOOGLE_ALGORITHM="RS256"
GOOGLE_LEEWAY_SECONDS=60
# 캐시가 만료된 뒤 새로 받기에 실패해도 옛 키를 더 쓸 수 있는 시간 (24시간)
GOOGLE_JWKS_STALE_SECONDS=86400

MESSAGE_INVALID="Google 로그인 정보를 확인할 수 없습니다. 다시 로그인해 주세요"
MESSAGE_UNREACHABLE="Google 로그인 서버에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요"
MESSAGE_NOT_CONFIGURED="Google 로그인이 아직 설정되지 않았습니다 (GOOGLE_CLIENT_ID_* 확인)"


# Google 검증 실패 - 메시지는 한국어, id_token 은 절대 담지 않는다
class Google_Auth_Error(Exception):

    def __init__(self, message:str, status_code:int):
        super().__init__(message)
        self.message=message
        self.status_code=status_code


# 검증을 통과한 Google 사용자 정보
class Google_Identity(BaseModel):
    sub:str
    email:str
    name:str | None=None
    picture_url:str | None=None


# 기본 네트워크 호출 - GET 후 JSON 으로 돌려준다 (타임아웃 10초)
async def verifier_google_fetch_json(url:str) -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        response=await client.get(url)
        response.raise_for_status()
        return response.json()


class Google_Verifier:

    # 네트워크와 시계를 주입받는다 (시험에서는 가짜를 넣는다)
    def __init__(self, fetch_json:Callable[[str], Awaitable[dict]] | None=None, now:Callable[[], float] | None=None):
        self._fetch_json=fetch_json or verifier_google_fetch_json
        self._now=now or time.time
        self._jwks_uri:str | None=None
        self._keys:dict[str, object]={}
        self._fetched_at:float | None=None
        self._last_attempt_at:float | None=None
        self._lock=asyncio.Lock()

    # 캐시가 아직 유효한지
    def _cache_fresh(self) -> bool:
        if self._fetched_at is None or self._jwks_uri is None:
            return False
        return self._now() - self._fetched_at < settings.google_jwks_cache_seconds

    # 네트워크 호출 - 실패·이상한 응답은 모두 503 으로 바꾼다
    async def _fetch(self, url:str) -> dict:
        try:
            data=await self._fetch_json(url)
        except Exception:
            raise Google_Auth_Error(MESSAGE_UNREACHABLE, 503) from None
        if not isinstance(data, dict):
            raise Google_Auth_Error(MESSAGE_UNREACHABLE, 503)
        return data

    # JWKS 를 받아 kid -> 공개키 표로 바꾼다 (읽을 수 없는 키는 건너뛴다)
    async def _load_keys(self) -> None:
        data=await self._fetch(self._jwks_uri)
        keys:dict[str, object]={}
        raw_keys=data.get("keys")
        if not isinstance(raw_keys, list):
            raise Google_Auth_Error(MESSAGE_UNREACHABLE, 503)
        for jwk in raw_keys:
            try:
                if isinstance(jwk, dict) and isinstance(jwk.get("kid"), str) and jwk.get("kty") == "RSA":
                    keys[jwk["kid"]]=jwt.PyJWK(jwk, GOOGLE_ALGORITHM).key
            except jwt.PyJWTError:
                continue
        self._keys=keys
        self._fetched_at=self._now()

    # 발견 문서에서 jwks_uri 를 얻고 JWKS 를 받는다
    async def _load_all(self) -> None:
        discovery=await self._fetch(GOOGLE_DISCOVERY_URL)
        jwks_uri=discovery.get("jwks_uri")
        if not isinstance(jwks_uri, str) or not jwks_uri.startswith("https://"):
            raise Google_Auth_Error(MESSAGE_UNREACHABLE, 503)
        self._jwks_uri=jwks_uri
        await self._load_keys()

    # 마지막으로 받아 본 지 쿨다운(기본 60초)이 지났는지
    def _cooldown_over(self) -> bool:
        if self._last_attempt_at is None:
            return True
        return self._now() - self._last_attempt_at >= settings.google_jwks_refetch_cooldown_seconds

    # 만료된 캐시를 새로 받는다 - 실패해도 24시간 안이면 옛 키를 계속 쓴다
    async def _refresh_expired(self) -> None:
        stale_ok=bool(self._keys) and self._fetched_at is not None and self._now() - self._fetched_at < settings.google_jwks_cache_seconds + GOOGLE_JWKS_STALE_SECONDS
        if stale_ok and not self._cooldown_over():
            return
        self._last_attempt_at=self._now()
        try:
            await self._load_all()
        except Google_Auth_Error:
            if not stale_ok:
                raise

    # kid 에 맞는 공개키 - 캐시에 없으면 쿨다운 안에서는 받지 않고, 락 안에서 한 번만 받는다
    async def _key_for(self, kid:str) -> object:
        if not (self._cache_fresh() and kid in self._keys):
            async with self._lock:
                if not self._cache_fresh():
                    await self._refresh_expired()
                elif kid not in self._keys and self._cooldown_over():
                    self._last_attempt_at=self._now()
                    await self._load_keys()
        key=self._keys.get(kid)
        if key is None:
            raise Google_Auth_Error(MESSAGE_INVALID, 401)
        return key

    # Google id_token 검증 - 서명·aud·iss·exp·email_verified 를 확인하고 사용자 정보를 돌려준다
    async def verifier_google_verify(self, id_token:str, client_ids:set[str]) -> Google_Identity:
        if not client_ids:
            raise Google_Auth_Error(MESSAGE_NOT_CONFIGURED, 503)
        # 1. 헤더만 먼저 본다 - RS256 이 아니거나 kid 가 없으면 네트워크 호출 전에 거절
        try:
            header=jwt.get_unverified_header(id_token)
        except jwt.PyJWTError:
            raise Google_Auth_Error(MESSAGE_INVALID, 401) from None
        kid=header.get("kid")
        if header.get("alg") != GOOGLE_ALGORITHM or not isinstance(kid, str) or not kid:
            raise Google_Auth_Error(MESSAGE_INVALID, 401)
        # 2. 공개키
        key=await self._key_for(kid)
        # 3. 서명·만료·aud 검증 (알고리즘은 RS256 만 허용)
        try:
            claims=jwt.decode(id_token, key, algorithms=[GOOGLE_ALGORITHM], audience=list(client_ids), leeway=GOOGLE_LEEWAY_SECONDS,
                              options={"require":["exp", "iss", "aud", "sub"]})
        except jwt.PyJWTError:
            raise Google_Auth_Error(MESSAGE_INVALID, 401) from None
        # 4. iss 는 허용 두 값과 직접 비교
        if claims.get("iss") not in GOOGLE_ISSUERS:
            raise Google_Auth_Error(MESSAGE_INVALID, 401)
        # 5. 이메일 확인 여부
        verified=claims.get("email_verified")
        if not (verified is True or verified == "true"):
            raise Google_Auth_Error(MESSAGE_INVALID, 401)
        sub=claims.get("sub")
        email=claims.get("email")
        if not isinstance(sub, str) or not sub or not isinstance(email, str) or not email:
            raise Google_Auth_Error(MESSAGE_INVALID, 401)
        name=claims.get("name")
        picture=claims.get("picture")
        return Google_Identity(sub=sub, email=email,
                               name=name if isinstance(name, str) else None,
                               picture_url=picture if isinstance(picture, str) else None)


# 모듈 전역 검증기 - 시험은 monkeypatch 로 바꾼다
GOOGLE_VERIFIER=Google_Verifier()
