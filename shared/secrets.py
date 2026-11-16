import hashlib
import hmac

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from shared.settings import settings

# 비밀값 암호화 (M6 기획서 03장) - external_id 같은 연결별 비밀값을 SQLite에 평문으로 두지 않는다
# GitHub App 개인키·웹훅 시크릿처럼 앱 전체에 하나뿐인 값은 여기 대상이 아니다 (.env 에 그대로 둔다)
# 로그인 계획 - 키 회전(SECRET_KEYS_OLD)·블라인드 인덱스(BLIND_INDEX_KEY)·토큰 해시도 여기서 맡는다


class Secret_Error(Exception):
    pass


# SECRET_KEY 없이 부르면 바로 알 수 있게 - 첫 키(SECRET_KEY)로 암호화하고, 이어서 SECRET_KEYS_OLD(쉼표)로도 복호화한다
def secret_fernet() -> MultiFernet:
    if not settings.secret_key:
        raise Secret_Error("SECRET_KEY가 설정되지 않았습니다 (.env 확인)")

    keys=[settings.secret_key]
    if settings.secret_keys_old:
        keys+=[key.strip() for key in settings.secret_keys_old.split(",") if key.strip()]

    try:
        return MultiFernet([Fernet(key.encode("utf-8")) for key in keys])
    except ValueError:
        raise Secret_Error("SECRET_KEY 또는 SECRET_KEYS_OLD 형식이 올바르지 않습니다 (.env 확인)")


# 암호화
def encrypt_secret(plain:str) -> str:
    return secret_fernet().encrypt(plain.encode("utf-8")).decode("utf-8")


# 복호화 - 키가 바뀌었거나 값이 손상되면 명확한 한국어 에러로
def decrypt_secret(token:str) -> str:
    try:
        return secret_fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        raise Secret_Error("저장된 값을 해독할 수 없습니다. SECRET_KEY가 바뀌었을 수 있습니다.")


# 키 회전 - 옛 키로 만든 암호문을 현재 키(SECRET_KEY)로 다시 암호화한다
def secret_rotate(token:str) -> str:
    try:
        return secret_fernet().rotate(token.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        raise Secret_Error("저장된 값을 해독할 수 없습니다. SECRET_KEY가 바뀌었을 수 있습니다.")


# 암호문인지 판별 - 복호화되면 True, 아니면(키 없음 포함) 예외 없이 False
def secret_is_encrypted(value:str) -> bool:
    try:
        secret_fernet().decrypt(value.encode("utf-8"))
        return True
    except Exception:
        return False


# 블라인드 인덱스 - 암호화한 열을 == 로 찾기 위한 HMAC-SHA256 hex (입력은 strip, email 은 소문자로 맞춘다)
def blind_index(kind:str, value:str) -> str:
    if not settings.blind_index_key:
        raise Secret_Error("BLIND_INDEX_KEY가 설정되지 않았습니다 (.env 확인)")

    normalized=value.strip()
    if kind == "email":
        normalized=normalized.lower()

    message=f"{kind}\x00{normalized}".encode("utf-8")
    return hmac.new(settings.blind_index_key.encode("utf-8"), message, hashlib.sha256).hexdigest()


# 토큰 해시 - 리프레시·개인 토큰은 원문 대신 SHA-256 hex 만 저장한다
def token_hash(token:str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
