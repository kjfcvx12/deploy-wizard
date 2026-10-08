from cryptography.fernet import Fernet, InvalidToken

from shared.settings import settings

# 비밀값 암호화 (M6 기획서 03장) - external_id 같은 연결별 비밀값을 SQLite에 평문으로 두지 않는다
# GitHub App 개인키·웹훅 시크릿처럼 앱 전체에 하나뿐인 값은 여기 대상이 아니다 (.env 에 그대로 둔다)


class Secret_Error(Exception):
    pass


# SECRET_KEY 없이 부르면 바로 알 수 있게
def secret_fernet() -> Fernet:
    if not settings.secret_key:
        raise Secret_Error("SECRET_KEY가 설정되지 않았습니다 (.env 확인)")
    return Fernet(settings.secret_key.encode("utf-8"))


# 암호화
def encrypt_secret(plain:str) -> str:
    return secret_fernet().encrypt(plain.encode("utf-8")).decode("utf-8")


# 복호화 - 키가 바뀌었거나 값이 손상되면 명확한 한국어 에러로
def decrypt_secret(token:str) -> str:
    try:
        return secret_fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        raise Secret_Error("저장된 값을 해독할 수 없습니다. SECRET_KEY가 바뀌었을 수 있습니다.")
