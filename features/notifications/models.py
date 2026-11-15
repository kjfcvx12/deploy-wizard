import json

from shared.database import Base

from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy import String, Text, TIMESTAMP, ForeignKey, Index, func
from datetime import datetime
from typing import Optional


# 알림 종류 일곱 가지 - 설정의 kinds 기본값 (모두 켜 둔다)
NOTIFICATION_KINDS=('incident_opened', 'incident_recovered', 'incident_needs_action', 'deploy_succeeded', 'deploy_failed', 'new_commit', 'plan_exceeded')


# 알림 종류 목록의 판 - 설정의 kinds_version 이 비어 있으면(NULL) plan_exceeded 가 생기기 전에 저장된 옛 설정이고, 이 값이면 사용자가 정한 목록이라 그대로 둔다
NOTIFICATION_KINDS_VERSION=2


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_u_id_read_at", "u_id", "read_at"),)

    n_id: Mapped[int] = mapped_column(primary_key=True)

    # 사용자 테이블은 3단계에서 생긴다 - 그 전까지 null
    u_id: Mapped[Optional[int]] = mapped_column()
    # 바로가기용
    d_id: Mapped[Optional[int]] = mapped_column()
    i_id: Mapped[Optional[int]] = mapped_column(ForeignKey("incidents.i_id"))

    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    # incident_opened|incident_recovered|incident_needs_action|deploy_succeeded|deploy_failed|new_commit|plan_exceeded
    channel: Mapped[str] = mapped_column(String(10), nullable=False)
    # inapp|email|push
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    # 마스킹 후 저장
    body: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default='queued')
    # queued|sent|failed
    # 발송 실패 이유 (마스킹 후)
    error: Mapped[Optional[str]] = mapped_column(Text)

    # inapp 만 쓴다
    read_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP)
    sent_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())


class Push_Device(Base):
    __tablename__ = "push_devices"

    p_d_id: Mapped[int] = mapped_column(primary_key=True)

    # 사용자 테이블은 3단계에서 생긴다 - 그 전까지 null
    u_id: Mapped[Optional[int]] = mapped_column()
    # 한 기기에 한 토큰. 응답에는 끝 6자리만 보인다
    expo_token: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    platform: Mapped[str] = mapped_column(String(10), nullable=False)
    # ios|android

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())


class Notification_Setting(Base):
    __tablename__ = "notification_settings"

    # 한 줄뿐인 표 - id 는 항상 1 (사용자 계정이 생기면 users 로 옮긴다)
    id: Mapped[int] = mapped_column(primary_key=True, default=1)

    notify_email: Mapped[bool] = mapped_column(nullable=False, default=True)
    notify_push: Mapped[bool] = mapped_column(nullable=False, default=True)
    # 받을 알림 종류 - json 배열 문자열
    kinds: Mapped[str] = mapped_column(Text, nullable=False, default=lambda: json.dumps(list(NOTIFICATION_KINDS)))
    # kinds 의 판 - NULL 은 옛 설정 (열을 더할 때 기존 줄이 NULL 로 남아야 하므로 기본값을 두지 않고, 새 줄은 crud 가 채운다)
    kinds_version: Mapped[Optional[int]] = mapped_column()
