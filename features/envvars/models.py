from shared.database import Base

from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy import String, Text, TIMESTAMP, ForeignKey, UniqueConstraint, func
from datetime import datetime
from typing import Optional


class Deploy_Env_Var(Base):
    __tablename__ = "deploy_env_vars"
    __table_args__ = (UniqueConstraint("d_id", "name"),)

    d_e_id: Mapped[int] = mapped_column(primary_key=True)

    d_id: Mapped[int] = mapped_column(ForeignKey("deploys.d_id", ondelete="CASCADE"), index=True)

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    required: Mapped[bool] = mapped_column(nullable=False, default=True)
    has_default: Mapped[bool] = mapped_column(nullable=False, default=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default='unknown')
    # database|cache|external_api|secret|config|unknown
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    # code|compose|example|runtime_error|user
    source_hint: Mapped[Optional[str]] = mapped_column(String(255))

    status: Mapped[str] = mapped_column(String(10), nullable=False, default='detected')
    # detected|set|skipped
    storage: Mapped[str] = mapped_column(String(20), nullable=False, default='none')
    # none|plain|secret_store
    # kind=config 이고 storage=plain 일 때만 값이 들어간다. 시크릿 값은 이 표에 절대 넣지 않는다
    plain_value: Mapped[Optional[str]] = mapped_column(Text)
    secret_ref: Mapped[Optional[str]] = mapped_column(String(500))

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now(), onupdate=func.now())
