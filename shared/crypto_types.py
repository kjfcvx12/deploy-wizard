from sqlalchemy import Text
from sqlalchemy.types import TypeDecorator

from shared.secrets import encrypt_secret, decrypt_secret, Secret_Error

# 암호화 열 타입 - 저장할 때 암호화하고 읽을 때 복호화한다 (저장 계층에서만 일어난다)
# 이 타입의 열은 == 검색에 쓰지 않는다 (같은 값도 매번 다른 암호문이 된다) - 블라인드 인덱스 열을 쓴다

# Fernet 암호문은 언제나 이 글자로 시작한다 (버전 바이트 0x80 + 시각). 아니면 이전 전 평문이다
FERNET_PREFIX="gAAAAA"
# 평문이 남은 옛 DB - 평문을 그대로 돌려주면 암호문과 섞여 저장되므로 읽기를 멈추고 이전 방법을 알린다 (값은 싣지 않는다)
MESSAGE_PLAINTEXT="암호화 전 값이 DB 에 남아 있습니다. 서버를 끄고 python scripts/migrate_login.py backup → encrypt --yes 를 실행하세요"


class Encrypted_Text(TypeDecorator):
    impl=Text
    cache_ok=True

    # 저장 - None 은 그대로, 나머지는 암호화
    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return encrypt_secret(value)

    # 읽기 - None 은 그대로, 나머지는 복호화. 암호문 모양이 아니면(이전 전 평문) 이전을 안내하는 오류
    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if not value.startswith(FERNET_PREFIX):
            raise Secret_Error(MESSAGE_PLAINTEXT)
        return decrypt_secret(value)
