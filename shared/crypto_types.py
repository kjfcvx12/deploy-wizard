from sqlalchemy import Text
from sqlalchemy.types import TypeDecorator

from shared.secrets import encrypt_secret, decrypt_secret

# 암호화 열 타입 - 저장할 때 암호화하고 읽을 때 복호화한다 (저장 계층에서만 일어난다)
# 이 타입의 열은 == 검색에 쓰지 않는다 (같은 값도 매번 다른 암호문이 된다) - 블라인드 인덱스 열을 쓴다


class Encrypted_Text(TypeDecorator):
    impl=Text
    cache_ok=True

    # 저장 - None 은 그대로, 나머지는 암호화
    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return encrypt_secret(value)

    # 읽기 - None 은 그대로, 나머지는 복호화
    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return decrypt_secret(value)
