from shared.database import Base

from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy import String, Text, TIMESTAMP, ForeignKey, func
from datetime import datetime
from typing import Optional


class Deploy(Base):
    __tablename__ = "deploys"

    d_id: Mapped[int] = mapped_column(primary_key=True)

    repo_url: Mapped[str] = mapped_column(String(255), nullable=False)
    branch: Mapped[Optional[str]] = mapped_column(String(100))
    commit_sha: Mapped[Optional[str]] = mapped_column(String(40))

    language: Mapped[Optional[str]] = mapped_column(String(30))
    support_level: Mapped[Optional[str]] = mapped_column(String(20))
    # official|experimental
    app_dir: Mapped[Optional[str]] = mapped_column(String(255))

    status: Mapped[str] = mapped_column(String(20), nullable=False, default='queued')
    # queued|cloning|analyzing|generating|building|pushing|deploying|running|failed|stopped|deleting|deleted

    dockerfile: Mapped[Optional[str]] = mapped_column(Text)
    dockerfile_source: Mapped[Optional[str]] = mapped_column(String(20))
    fix_count: Mapped[int] = mapped_column(nullable=False, default=0)

    service_name: Mapped[Optional[str]] = mapped_column(String(100))
    service_arn: Mapped[Optional[str]] = mapped_column(String(255))
    repository_name: Mapped[Optional[str]] = mapped_column(String(255))
    image_uri: Mapped[Optional[str]] = mapped_column(String(500))
    port: Mapped[Optional[int]] = mapped_column()
    health_check_path: Mapped[Optional[str]] = mapped_column(String(255))
    endpoint: Mapped[Optional[str]] = mapped_column(String(255))

    error_step: Mapped[Optional[str]] = mapped_column(String(20))
    error_msg: Mapped[Optional[str]] = mapped_column(Text)
    # Explain_Result json
    explain: Mapped[Optional[str]] = mapped_column(Text)

    # M6 - 연결된 계정. 없으면(둘 다 null) 지금까지처럼 개발용 세션·public 클론을 쓴다
    aws_account_id: Mapped[Optional[int]] = mapped_column(ForeignKey("aws_accounts.a_id"))
    github_installation_id: Mapped[Optional[int]] = mapped_column(ForeignKey("github_installations.g_id"))
    auto_redeploy: Mapped[bool] = mapped_column(nullable=False, default=True)
    # 폴링/웹훅이 마지막으로 확인한 원격 커밋 - commit_sha 와 다르면 "새 커밋 있음"
    watch_commit_sha: Mapped[Optional[str]] = mapped_column(String(40))
    watch_checked_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now(), onupdate=func.now())

    # 배포 삭제시 로그·이슈 전부 삭제
    logs : Mapped[list["Deploy_Log"]] = relationship("Deploy_Log", back_populates="deploy", cascade="all, delete-orphan")
    issues : Mapped[list["Deploy_Issue"]] = relationship("Deploy_Issue", back_populates="deploy", cascade="all, delete-orphan")
    # 조회 전용 - 계정 연결이 끊길 때는 services 레이어에서 명시적으로 null 처리한다 (SQLite는 ON DELETE SET NULL을 안 지킨다)
    aws_account : Mapped[Optional["Aws_Account"]] = relationship("Aws_Account", viewonly=True)
    github_installation : Mapped[Optional["Github_Installation"]] = relationship("Github_Installation", viewonly=True)


class Deploy_Log(Base):
    __tablename__ = "deploy_logs"

    d_l_id: Mapped[int] = mapped_column(primary_key=True)

    d_id: Mapped[int] = mapped_column(ForeignKey("deploys.d_id", ondelete="CASCADE"), index=True)

    step: Mapped[str] = mapped_column(String(20), nullable=False)
    level: Mapped[str] = mapped_column(String(10), nullable=False, default='info')
    # info|cmd|warn|error
    message: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())

    # 관계
    deploy: Mapped["Deploy"] = relationship(back_populates="logs")


class Deploy_Issue(Base):
    __tablename__ = "deploy_issues"

    d_i_id: Mapped[int] = mapped_column(primary_key=True)

    d_id: Mapped[int] = mapped_column(ForeignKey("deploys.d_id", ondelete="CASCADE"), index=True)

    step: Mapped[str] = mapped_column(String(20), nullable=False)
    error_msg: Mapped[str] = mapped_column(Text, nullable=False)
    # Explain_Result json
    explain: Mapped[Optional[str]] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())

    # 관계
    deploy: Mapped["Deploy"] = relationship(back_populates="issues")
