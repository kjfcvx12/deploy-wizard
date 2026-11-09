from pydantic import BaseModel, ConfigDict
from datetime import datetime

NOTIFICATION_CHANNELS=('inapp', 'email', 'push')
NOTIFICATION_STATUSES=('queued', 'sent', 'failed')


# 알림 한 건 - 앱 안 목록·API 응답
class Notification_Read(BaseModel):
    n_id: int
    d_id: int | None = None
    i_id: int | None = None
    kind: str
    channel: str
    title: str
    body: str
    status: str
    read_at: datetime | None = None
    sent_at: datetime | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# 앱 기기 - 토큰은 끝 6자리만 보여 준다 (Hard rule 6)
class Device_Read(BaseModel):
    p_d_id: int
    platform: str
    token_tail: str
    created_at: datetime
    last_seen_at: datetime
