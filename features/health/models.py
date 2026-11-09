from shared.database import Base

from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy import String, TIMESTAMP, ForeignKey, func
from datetime import datetime
from typing import Optional


class Health_Check(Base):
    __tablename__ = "health_checks"

    h_c_id: Mapped[int] = mapped_column(primary_key=True)

    d_id: Mapped[int] = mapped_column(ForeignKey("deploys.d_id", ondelete="CASCADE"), index=True)

    ok: Mapped[bool] = mapped_column(nullable=False)
    # 응답이 없으면 null
    status_code: Mapped[Optional[int]] = mapped_column()
    latency_ms: Mapped[Optional[int]] = mapped_column()
    # 시간 초과, 연결 거부 등 (마스킹 후 저장)
    detail: Mapped[Optional[str]] = mapped_column(String(255))

    checked_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now(), index=True)
