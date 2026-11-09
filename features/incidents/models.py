from shared.database import Base

from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy import String, Text, TIMESTAMP, ForeignKey, func
from datetime import datetime
from typing import Optional


class Incident(Base):
    __tablename__ = "incidents"

    i_id: Mapped[int] = mapped_column(primary_key=True)

    d_id: Mapped[int] = mapped_column(ForeignKey("deploys.d_id", ondelete="CASCADE"), index=True)

    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    # unhealthy|crash_loop|bad_release|unknown
    # 한 배포에 open|recovering 인시던트는 동시에 하나만 둔다 (services 에서 확인)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default='open')
    # open|recovering|resolved|needs_action
    summary: Mapped[Optional[str]] = mapped_column(String(255))
    # Incident_Explain json - 마스킹 후 저장
    explain: Mapped[Optional[str]] = mapped_column(Text)
    # 원인 수집 결과 요약 - 마스킹 후, 크기 제한
    evidence: Mapped[Optional[str]] = mapped_column(Text)

    detected_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    resolved_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now(), onupdate=func.now())


class Recovery_Action(Base):
    __tablename__ = "recovery_actions"

    r_a_id: Mapped[int] = mapped_column(primary_key=True)

    i_id: Mapped[int] = mapped_column(ForeignKey("incidents.i_id", ondelete="CASCADE"), index=True)

    action: Mapped[str] = mapped_column(String(20), nullable=False)
    # restart|rollback (자동으로 하는 것은 이 둘뿐 - CLAUDE.md Hard rule 3)
    # 되돌리기 대상 릴리스
    d_r_id: Mapped[Optional[int]] = mapped_column(ForeignKey("deploy_releases.d_r_id"))

    result: Mapped[str] = mapped_column(String(10), nullable=False, default='running')
    # running|ok|failed
    # 실패 이유 - 마스킹 후 저장
    detail: Mapped[Optional[str]] = mapped_column(Text)

    started_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    finished_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP)
