import asyncio
import base64
import hashlib
import hmac
import json
import time

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from features.auth.google import GOOGLE_DISCOVERY_URL, Google_Auth_Error, Google_Identity, Google_Verifier


CLIENT_ID="web-client-id.apps.googleusercontent.com"
JWKS_URI="https://www.googleapis.com/oauth2/v3/certs"
MESSAGE_INVALID="Google 로그인 정보를 확인할 수 없습니다. 다시 로그인해 주세요"


# 시험용 RSA 키 한 쌍
def make_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


# 공개키를 JWKS 항목으로
def jwk_of(private_key:rsa.RSAPrivateKey, kid:str) -> dict:
    jwk=jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True)
    jwk.update({"kid":kid, "alg":"RS256", "use":"sig"})
    return jwk


# 올바른 claims
def make_claims(**override) -> dict:
    claims={"iss":"https://accounts.google.com", "aud":CLIENT_ID, "sub":"1234", "email":"me@example.com", "email_verified":True,
            "name":"Me", "picture":"https://example.com/me.png", "iat":int(time.time()), "exp":int(time.time()) + 3600}
    claims.update(override)
    return claims


# RS256 토큰 서명
def sign(private_key:rsa.RSAPrivateKey, kid:str, claims:dict | None=None) -> str:
    return jwt.encode(claims or make_claims(), private_key, algorithm="RS256", headers={"kid":kid})


# 직접 만든 토큰 조각 (PyJWT 가 만들어 주지 않는 alg=HS256/none 용)
def b64(data:dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()


# 가짜 네트워크 - 발견 문서와 JWKS 를 돌려주고 호출 URL 을 센다
class Fake_Fetch:

    def __init__(self, keys:list[dict]):
        self.keys=keys
        self.calls:list[str]=[]

    async def __call__(self, url:str) -> dict:
        self.calls.append(url)
        if url == GOOGLE_DISCOVERY_URL:
            return {"issuer":"https://accounts.google.com", "jwks_uri":JWKS_URI}
        if url == JWKS_URI:
            return {"keys":self.keys}
        raise AssertionError(f"예상하지 못한 URL {url}")


@pytest.fixture(scope="module")
def key1():
    return make_key()


@pytest.fixture(scope="module")
def key2():
    return make_key()


@pytest.mark.asyncio
async def test_google_verify_ok(key1):
    fetch=Fake_Fetch([jwk_of(key1, "k1")])
    verifier=Google_Verifier(fetch_json=fetch)
    identity=await verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})
    assert identity == Google_Identity(sub="1234", email="me@example.com", name="Me", picture_url="https://example.com/me.png")
    assert fetch.calls == [GOOGLE_DISCOVERY_URL, JWKS_URI]


@pytest.mark.asyncio
async def test_google_verify_accepts_bare_issuer_and_string_verified(key1):
    verifier=Google_Verifier(fetch_json=Fake_Fetch([jwk_of(key1, "k1")]))
    token=sign(key1, "k1", make_claims(iss="accounts.google.com", email_verified="true"))
    identity=await verifier.verifier_google_verify(token, {CLIENT_ID, "other"})
    assert identity.email == "me@example.com"


@pytest.mark.asyncio
async def test_google_verify_caches_jwks(key1):
    fetch=Fake_Fetch([jwk_of(key1, "k1")])
    clock=[1000.0]
    verifier=Google_Verifier(fetch_json=fetch, now=lambda: clock[0])
    await verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})
    assert len(fetch.calls) == 2
    await verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})
    assert len(fetch.calls) == 2
    clock[0]+=3601
    await verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})
    assert len(fetch.calls) == 4


@pytest.mark.asyncio
async def test_google_verify_unknown_kid_refetches_once(key1, key2):
    fetch=Fake_Fetch([jwk_of(key1, "k1")])
    clock=[1000.0]
    verifier=Google_Verifier(fetch_json=fetch, now=lambda: clock[0])
    await verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})
    assert len(fetch.calls) == 2
    # 키가 회전되어 새 kid 가 생겼다 - 쿨다운(60초)이 지난 뒤 JWKS 만 한 번 다시 받는다
    clock[0]+=61
    fetch.keys=[jwk_of(key1, "k1"), jwk_of(key2, "k2")]
    identity=await verifier.verifier_google_verify(sign(key2, "k2"), {CLIENT_ID})
    assert identity.sub == "1234"
    assert fetch.calls[2:] == [JWKS_URI]
    # 다시 받아도 없는 kid 는 401, 요청은 한 번만 더
    clock[0]+=61
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(sign(key2, "k3"), {CLIENT_ID})
    assert info.value.status_code == 401
    assert fetch.calls[3:] == [JWKS_URI]


@pytest.mark.asyncio
async def test_google_verify_unknown_kid_after_fresh_load_does_not_refetch(key1):
    fetch=Fake_Fetch([jwk_of(key1, "k1")])
    verifier=Google_Verifier(fetch_json=fetch, now=lambda: 1000.0)
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(sign(key1, "nope"), {CLIENT_ID})
    assert info.value.status_code == 401
    assert fetch.calls == [GOOGLE_DISCOVERY_URL, JWKS_URI]


# 공개키 PEM 을 HMAC 비밀로 쓴 alg=HS256 토큰 (알고리즘 혼동 공격)
def forge_hs256(public_pem:bytes, kid:str) -> str:
    signing_input=b64({"alg":"HS256", "typ":"JWT", "kid":kid}) + "." + b64(make_claims())
    signature=hmac.new(public_pem, signing_input.encode(), hashlib.sha256).digest()
    return signing_input + "." + base64.urlsafe_b64encode(signature).rstrip(b"=").decode()


# 서명 없는 alg=none 토큰
def forge_none(kid:str) -> str:
    return b64({"alg":"none", "typ":"JWT", "kid":kid}) + "." + b64(make_claims()) + "."


# 거절 사례별 토큰
def build_reject_token(case:str, key1, key2) -> str:
    public_pem=key1.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    if case == "wrong_key":
        return sign(key2, "k1")
    if case == "hs256":
        return forge_hs256(public_pem, "k1")
    if case == "none":
        return forge_none("k1")
    if case == "aud":
        return sign(key1, "k1", make_claims(aud="somebody-else"))
    if case == "iss":
        return sign(key1, "k1", make_claims(iss="https://evil.example"))
    if case == "expired":
        return sign(key1, "k1", make_claims(exp=int(time.time()) - 120))
    if case == "unverified":
        return sign(key1, "k1", make_claims(email_verified=False))
    if case == "unverified_string":
        return sign(key1, "k1", make_claims(email_verified="false"))
    if case == "no_exp":
        claims=make_claims()
        del claims["exp"]
        return sign(key1, "k1", claims)
    if case == "garbage":
        return "not-a-jwt"
    raise AssertionError(case)


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["wrong_key", "hs256", "none", "aud", "iss", "expired", "unverified", "unverified_string", "no_exp", "garbage"])
async def test_google_verify_rejects(case, key1, key2):
    verifier=Google_Verifier(fetch_json=Fake_Fetch([jwk_of(key1, "k1")]))
    token=build_reject_token(case, key1, key2)
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(token, {CLIENT_ID})
    assert info.value.status_code == 401
    assert info.value.message == MESSAGE_INVALID
    assert token not in str(info.value)
    assert token not in repr(info.value)
    assert info.value.__cause__ is None
    assert info.value.__context__ is None or info.value.__suppress_context__


@pytest.mark.asyncio
async def test_google_verify_network_failure_503(key1):
    async def broken(url:str) -> dict:
        raise httpx.ConnectError("boom")
    verifier=Google_Verifier(fetch_json=broken)
    token=sign(key1, "k1")
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(token, {CLIENT_ID})
    assert info.value.status_code == 503
    assert info.value.message == "Google 로그인 서버에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요"
    assert token not in str(info.value)


@pytest.mark.asyncio
async def test_google_verify_no_client_ids(key1):
    fetch=Fake_Fetch([jwk_of(key1, "k1")])
    verifier=Google_Verifier(fetch_json=fetch)
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(sign(key1, "k1"), set())
    assert info.value.status_code == 503
    assert info.value.message == "Google 로그인이 아직 설정되지 않았습니다 (GOOGLE_CLIENT_ID_* 확인)"
    assert fetch.calls == []


@pytest.mark.asyncio
async def test_google_verify_unknown_kid_refetch_has_cooldown(key1, key2):
    fetch=Fake_Fetch([jwk_of(key1, "k1")])
    clock=[1000.0]
    verifier=Google_Verifier(fetch_json=fetch, now=lambda: clock[0])
    await verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})
    assert len(fetch.calls) == 2
    clock[0]+=61
    # 쿨다운이 지난 첫 모르는 kid - JWKS 한 번 더
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(sign(key2, "k3"), {CLIENT_ID})
    assert info.value.status_code == 401
    assert len(fetch.calls) == 3
    # 60초 안의 두 번째 모르는 kid - 네트워크 호출 없이 401
    clock[0]+=30
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(sign(key2, "k4"), {CLIENT_ID})
    assert info.value.status_code == 401
    assert len(fetch.calls) == 3
    # 쿨다운 뒤에는 다시 받는다
    clock[0]+=31
    with pytest.raises(Google_Auth_Error):
        await verifier.verifier_google_verify(sign(key2, "k5"), {CLIENT_ID})
    assert len(fetch.calls) == 4


@pytest.mark.asyncio
async def test_google_verify_unknown_kid_right_after_load_makes_no_call(key1, key2):
    fetch=Fake_Fetch([jwk_of(key1, "k1")])
    verifier=Google_Verifier(fetch_json=fetch, now=lambda: 1000.0)
    await verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(sign(key2, "k2"), {CLIENT_ID})
    assert info.value.status_code == 401
    assert len(fetch.calls) == 2


@pytest.mark.asyncio
async def test_google_verify_concurrent_first_requests_share_one_fetch(key1):
    fetch=Fake_Fetch([jwk_of(key1, "k1")])
    gate=asyncio.Event()

    async def slow(url:str) -> dict:
        await gate.wait()
        return await fetch(url)

    verifier=Google_Verifier(fetch_json=slow, now=lambda: 1000.0)
    tasks=[asyncio.create_task(verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})) for _ in range(5)]
    await asyncio.sleep(0.05)
    gate.set()
    results=await asyncio.gather(*tasks)
    assert all(r.sub == "1234" for r in results)
    assert fetch.calls == [GOOGLE_DISCOVERY_URL, JWKS_URI]


@pytest.mark.asyncio
async def test_google_verify_concurrent_unknown_kid_share_one_fetch(key1, key2):
    fetch=Fake_Fetch([jwk_of(key1, "k1")])
    clock=[1000.0]
    gate=asyncio.Event()
    gate.set()

    async def slow(url:str) -> dict:
        await gate.wait()
        return await fetch(url)

    verifier=Google_Verifier(fetch_json=slow, now=lambda: clock[0])
    await verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})
    clock[0]+=61
    fetch.keys=[jwk_of(key1, "k1"), jwk_of(key2, "k2")]
    gate.clear()
    tasks=[asyncio.create_task(verifier.verifier_google_verify(sign(key2, "k2"), {CLIENT_ID})) for _ in range(5)]
    await asyncio.sleep(0.05)
    gate.set()
    results=await asyncio.gather(*tasks)
    assert all(r.sub == "1234" for r in results)
    assert fetch.calls[2:] == [JWKS_URI]


# email_verified 는 bool true 와 문자열 "true" 만 통과
@pytest.mark.asyncio
@pytest.mark.parametrize("value", [1, "True", "1", "false", False, None, 0, "", [True]])
async def test_google_verify_email_verified_strict_rejects(value, key1):
    verifier=Google_Verifier(fetch_json=Fake_Fetch([jwk_of(key1, "k1")]))
    token=sign(key1, "k1", make_claims(email_verified=value))
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(token, {CLIENT_ID})
    assert info.value.status_code == 401


@pytest.mark.asyncio
async def test_google_verify_email_verified_missing_rejects(key1):
    verifier=Google_Verifier(fetch_json=Fake_Fetch([jwk_of(key1, "k1")]))
    claims=make_claims()
    del claims["email_verified"]
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(sign(key1, "k1", claims), {CLIENT_ID})
    assert info.value.status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [True, "true"])
async def test_google_verify_email_verified_accepts(value, key1):
    verifier=Google_Verifier(fetch_json=Fake_Fetch([jwk_of(key1, "k1")]))
    identity=await verifier.verifier_google_verify(sign(key1, "k1", make_claims(email_verified=value)), {CLIENT_ID})
    assert identity.sub == "1234"


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["email", "sub"])
async def test_google_verify_missing_identity_claim_rejects(missing, key1):
    verifier=Google_Verifier(fetch_json=Fake_Fetch([jwk_of(key1, "k1")]))
    claims=make_claims()
    del claims[missing]
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(sign(key1, "k1", claims), {CLIENT_ID})
    assert info.value.status_code == 401


@pytest.mark.asyncio
async def test_google_verify_discovery_without_jwks_uri_503(key1):
    async def fetch(url:str) -> dict:
        return {"issuer":"https://accounts.google.com"}
    verifier=Google_Verifier(fetch_json=fetch)
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})
    assert info.value.status_code == 503


@pytest.mark.asyncio
async def test_google_verify_jwks_keys_not_a_list_503(key1):
    async def fetch(url:str) -> dict:
        if url == GOOGLE_DISCOVERY_URL:
            return {"jwks_uri":JWKS_URI}
        return {"keys":"not-a-list"}
    verifier=Google_Verifier(fetch_json=fetch)
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})
    assert info.value.status_code == 503


@pytest.mark.asyncio
async def test_google_verify_jwks_fetch_failure_after_discovery_503(key1):
    calls:list[str]=[]

    async def fetch(url:str) -> dict:
        calls.append(url)
        if url == GOOGLE_DISCOVERY_URL:
            return {"jwks_uri":JWKS_URI}
        raise httpx.ConnectError("boom")
    verifier=Google_Verifier(fetch_json=fetch)
    token=sign(key1, "k1")
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(token, {CLIENT_ID})
    assert info.value.status_code == 503
    assert token not in str(info.value)
    assert calls == [GOOGLE_DISCOVERY_URL, JWKS_URI]


@pytest.mark.asyncio
async def test_google_verify_token_without_kid_makes_no_call(key1):
    fetch=Fake_Fetch([jwk_of(key1, "k1")])
    verifier=Google_Verifier(fetch_json=fetch)
    token=jwt.encode(make_claims(), key1, algorithm="RS256")
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(token, {CLIENT_ID})
    assert info.value.status_code == 401
    assert fetch.calls == []


@pytest.mark.asyncio
async def test_google_verify_aud_list_containing_our_client_id(key1):
    verifier=Google_Verifier(fetch_json=Fake_Fetch([jwk_of(key1, "k1")]))
    token=sign(key1, "k1", make_claims(aud=["someone-else", CLIENT_ID]))
    identity=await verifier.verifier_google_verify(token, {CLIENT_ID})
    assert identity.sub == "1234"


@pytest.mark.asyncio
async def test_google_verify_aud_list_without_our_client_id_rejects(key1):
    verifier=Google_Verifier(fetch_json=Fake_Fetch([jwk_of(key1, "k1")]))
    token=sign(key1, "k1", make_claims(aud=["someone-else", "another"]))
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(token, {CLIENT_ID})
    assert info.value.status_code == 401


@pytest.mark.asyncio
async def test_google_verify_stale_keys_served_when_refresh_fails(key1):
    fetch=Fake_Fetch([jwk_of(key1, "k1")])
    clock=[1000.0]
    verifier=Google_Verifier(fetch_json=fetch, now=lambda: clock[0])
    await verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})

    async def broken(url:str) -> dict:
        raise httpx.ConnectError("boom")
    verifier._fetch_json=broken
    # 만료된 캐시를 새로 받다가 실패 - 24시간 안이면 옛 키를 계속 쓴다
    clock[0]+=3601
    identity=await verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})
    assert identity.sub == "1234"
    # 24시간을 넘기면 503
    clock[0]+=86400
    with pytest.raises(Google_Auth_Error) as info:
        await verifier.verifier_google_verify(sign(key1, "k1"), {CLIENT_ID})
    assert info.value.status_code == 503
