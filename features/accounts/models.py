from shared.database import Base

from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy import String, Text, TIMESTAMP, ForeignKey, func
from datetime import datetime
from typing import Optional


class Aws_Account(Base):
    __tablename__ = "aws_accounts"

    a_id: Mapped[int] = mapped_column(primary_key=True)

    label: Mapped[str] = mapped_column(String(100), nullable=False)
    role_arn: Mapped[Optional[str]] = mapped_column(String(255))
    # sts:AssumeRole 로 검증된 뒤에만 채워진다
    aws_account_id: Mapped[Optional[str]] = mapped_column(String(20))
    # shared.secrets.encrypt_secret 로 암호화. 평문은 생성 직후 응답에만 한 번 실어 보낸다
    external_id_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    region: Mapped[Optional[str]] = mapped_column(String(30))

    status: Mapped[str] = mapped_column(String(20), nullable=False, default='pending')
    # pending|verified|invalid
    last_verified_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP)
    last_error: Mapped[Optional[str]] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now(), onupdate=func.now())


class Github_Installation(Base):
    __tablename__ = "github_installations"

    g_id: Mapped[int] = mapped_column(primary_key=True)

    installation_id: Mapped[int] = mapped_column(nullable=False, unique=True)
    account_login: Mapped[str] = mapped_column(String(100), nullable=False)
    account_type: Mapped[Optional[str]] = mapped_column(String(20))
    # User|Organization
    repository_selection: Mapped[Optional[str]] = mapped_column(String(20))
    # all|selected

    status: Mapped[str] = mapped_column(String(20), nullable=False, default='active')
    # active|suspended|revoked - GitHub 쪽에서 끊기면 다음 토큰 발급 시도가 실패하며 이 값을 갱신한다
    suspended_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now(), onupdate=func.now())


# 연결 블록 - 화면에서 한 묶음으로 다루는 "AWS 계정 하나 + GitHub 설치 하나". 배포할 때 이 블록을 고른다
class Connection(Base):
    __tablename__ = "connections"

    c_id: Mapped[int] = mapped_column(primary_key=True)

    label: Mapped[str] = mapped_column(String(100), nullable=False)
    # 둘 다 아직 연결 전이면 비어 있다 ([+]로 블록부터 만들고 안에서 하나씩 연결한다)
    aws_account_id: Mapped[Optional[int]] = mapped_column(ForeignKey("aws_accounts.a_id"))
    # GitHub 설치는 GitHub 계정마다 하나라서 여러 블록이 같은 설치를 가리킬 수 있다
    github_installation_id: Mapped[Optional[int]] = mapped_column(ForeignKey("github_installations.g_id"))

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now(), onupdate=func.now())
