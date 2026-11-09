import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator
from datetime import datetime

from features.notifications.models import NOTIFICATION_KINDS

NOTIFICATION_CHANNELS=('inapp', 'email', 'push')
NOTIFICATION_STATUSES=('queued', 'sent', 'failed')
EXPO_TOKEN_FORMAT=re.compile(r"^(Exponent|Expo)PushToken\[.+\]$")


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


# 기기 등록 요청 - Expo 푸시 토큰 형식만 받는다 (검증 오류 응답에서 입력값(토큰)은 router 의 오류 처리기가 뺀다)
class Device_Create(BaseModel):
    expo_token: str = Field(max_length=255)
    platform: Literal['ios', 'android']

    model_config = ConfigDict(extra='forbid')

    # 토큰 형식 확인 - ExponentPushToken[...] 또는 ExpoPushToken[...]
    @field_validator('expo_token')
    @classmethod
    def scheme_device_token_check(cls, value:str) -> str:
        if not EXPO_TOKEN_FORMAT.match(value):
            raise ValueError('Expo 푸시 토큰 형식이 올바르지 않습니다')
        return value


# 알림 설정 - 받을 채널과 알림 종류
class Notification_Setting_Read(BaseModel):
    notify_email: bool
    notify_push: bool
    kinds: list[str]


# 알림 설정 일부 수정 - 보낸 항목만 바꾼다. 모르는 항목·모르는 종류는 거절
class Notification_Setting_Update(BaseModel):
    notify_email: StrictBool | None = None
    notify_push: StrictBool | None = None
    kinds: list[str] | None = None

    model_config = ConfigDict(extra='forbid')

    # 알림 종류 확인 - 정해진 여섯 가지만, 중복은 한 번으로
    @field_validator('kinds')
    @classmethod
    def scheme_setting_kinds_check(cls, value:list[str]|None) -> list[str]|None:
        if value is None:
            return value

        unknown=[kind for kind in value if kind not in NOTIFICATION_KINDS]
        if unknown:
            raise ValueError('알 수 없는 알림 종류가 있습니다')

        return list(dict.fromkeys(value))
