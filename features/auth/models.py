from shared.database import Base
from shared.crypto_types import Encrypted_Text

from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy import String, TIMESTAMP, ForeignKey, func
from datetime import datetime
from typing import Optional


# 사용자 - 개인 정보는 Encrypted_Text 로 암호화해 저장하고, 찾기는 블라인드 인덱스(_bidx)로만 한다
class User(Base):
    __tablename__ = "users"

    u_id: Mapped[int] = mapped_column(primary_key=True)

    google_sub: Mapped[str] = mapped_column(Encrypted_Text, nullable=False)
    # blind_index("google_sub", sub)
    google_sub_bidx: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    email: Mapped[str] = mapped_column(Encrypted_Text, nullable=False)
    # blind_index("email", email) - 소문자로 맞춘 뒤
    email_bidx: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[Optional[str]] = mapped_column(Encrypted_Text)
    picture_url: Mapped[Optional[str]] = mapped_column(Encrypted_Text)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default='active')
    # active|deleted
    last_login_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now(), onupdate=func.now())


# 리프레시 토큰 - 원문은 저장하지 않고 SHA-256 hex 만. 로그인 한 번이 한 계열(family_id)이고 회전해도 계열은 같다
class Refresh_Token(Base):
    __tablename__ = "refresh_tokens"

    r_t_id: Mapped[int] = mapped_column(primary_key=True)

    u_id: Mapped[int] = mapped_column(ForeignKey("users.u_id", ondelete="CASCADE"), nullable=False, index=True)
    family_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    platform: Mapped[str] = mapped_column(String(10), nullable=False)
    # web|android (ios 추가 가능)

    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP)
    # 회전으로 이 토큰을 대신한 새 토큰의 r_t_id
    replaced_by: Mapped[Optional[int]] = mapped_column()

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
