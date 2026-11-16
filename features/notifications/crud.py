from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import update, delete, func, type_coerce, String
from datetime import datetime

from shared.ownership import owner_where
from shared.secrets import blind_index

from features.notifications.models import Notification, Notification_Setting, Push_Device, NOTIFICATION_KINDS_VERSION


class Notification_Crud:

    # 알림 한 줄 쌓기
    @staticmethod
    async def crud_notification_create(db:AsyncSession, data:dict) -> Notification:
        db_notification=Notification(**data)
        db.add(db_notification)
        await db.flush()
        return db_notification


    # 알림 설정 조회 - u_id 가 None 이면 id=1 줄(인증 끔·주인 없는 배포), 있으면 그 사용자 줄. 없으면 기본값으로 만든다
    # 사용자 줄을 처음 만들 때 id=1 줄을 먼저 만들어 둔다 - 빈 표에서 사용자 줄이 id=1 을 가져가지 않게
    @staticmethod
    async def crud_notification_setting_get(db:AsyncSession, u_id:int|None=None) -> Notification_Setting:
        if u_id is None:
            query=select(Notification_Setting).where(Notification_Setting.id == 1)
        else:
            query=select(Notification_Setting).where(Notification_Setting.u_id == u_id)

        result=await db.execute(query)
        db_setting=result.scalars().first()

        if db_setting is None:
            if u_id is None:
                db_setting=Notification_Setting(id=1, u_id=None, kinds_version=NOTIFICATION_KINDS_VERSION)
            else:
                await Notification_Crud.crud_notification_setting_get(db, None)
                db_setting=Notification_Setting(u_id=u_id, kinds_version=NOTIFICATION_KINDS_VERSION)
            db.add(db_setting)
            await db.flush()

        return db_setting


    # 같은 알림이 이미 있는지 - 인시던트 또는 배포 + 종류 + 채널 (title 을 주면 제목까지 같은 것만: 새 커밋마다 따로 센다)
    @staticmethod
    async def crud_notification_exists(db:AsyncSession, kind:str, channel:str, i_id:int|None=None, d_id:int|None=None, title:str|None=None) -> bool:
        query=select(Notification.n_id).where(Notification.kind == kind, Notification.channel == channel)

        if i_id is not None:
            query=query.where(Notification.i_id == i_id)
        else:
            query=query.where(Notification.d_id == d_id)

        if title is not None:
            query=query.where(Notification.title == title)

        result=await db.execute(query.limit(1))
        return result.scalars().first() is not None


    # 알림 상태 바꾸기 - 보냄/실패와 오류 문장
    @staticmethod
    async def crud_notification_update_status(db:AsyncSession, db_notification:Notification, status:str, error:str|None, sent_at:datetime|None) -> Notification:
        db_notification.status=status
        db_notification.error=error
        db_notification.sent_at=sent_at
        await db.flush()
        return db_notification


    # 앱 안 알림 목록 - 최신순, after(n_id)보다 오래된 것부터, unread 면 읽지 않은 것만. u_id 가 있으면 그 사용자 것만
    @staticmethod
    async def crud_notification_list_inapp(db:AsyncSession, after:int|None, unread:bool, limit:int, u_id:int|None=None) -> list[Notification]:
        query=owner_where(select(Notification).where(Notification.channel == 'inapp'), Notification.u_id, u_id)

        if after is not None:
            query=query.where(Notification.n_id < after)
        if unread:
            query=query.where(Notification.read_at.is_(None))

        result=await db.execute(query.order_by(Notification.n_id.desc()).limit(limit))
        return result.scalars().all()


    # 읽지 않은 앱 안 알림 수 - u_id 가 있으면 그 사용자 것만
    @staticmethod
    async def crud_notification_unread_count(db:AsyncSession, u_id:int|None=None) -> int:
        query=select(func.count(Notification.n_id)).where(Notification.channel == 'inapp', Notification.read_at.is_(None))
        result=await db.execute(owner_where(query, Notification.u_id, u_id))
        return result.scalar_one()


    # 앱 안 알림 한 건 - 다른 채널의 줄·남의 줄은 없는 것으로 본다
    @staticmethod
    async def crud_notification_get_inapp(db:AsyncSession, n_id:int, u_id:int|None=None) -> Notification | None:
        query=select(Notification).where(Notification.n_id == n_id, Notification.channel == 'inapp')
        result=await db.execute(owner_where(query, Notification.u_id, u_id))
        return result.scalars().first()


    # 한 건 읽음 표시 - 이미 읽었으면 처음 읽은 시각을 그대로 둔다
    @staticmethod
    async def crud_notification_mark_read(db:AsyncSession, db_notification:Notification, read_at:datetime) -> Notification:
        if db_notification.read_at is None:
            db_notification.read_at=read_at
            await db.flush()

        return db_notification


    # 모두 읽음 - 바뀐 줄 수를 돌려준다. u_id 가 있으면 그 사용자 것만
    @staticmethod
    async def crud_notification_mark_all_read(db:AsyncSession, read_at:datetime, u_id:int|None=None) -> int:
        query=update(Notification).where(Notification.channel == 'inapp', Notification.read_at.is_(None))
        result=await db.execute(owner_where(query, Notification.u_id, u_id)
                                .values(read_at=read_at)
                                .execution_options(synchronize_session=False))
        await db.flush()
        return result.rowcount


    # 푸시를 보낼 기기 - (p_d_id, 저장된 토큰 그대로) 목록. 복호화는 서비스가 한 줄씩 한다 (옛 평문 한 줄이 목록 전체를 깨지 않게)
    # u_id 가 있으면 그 사용자 기기만, None 이면 전체
    @staticmethod
    async def crud_notification_device_list_raw(db:AsyncSession, u_id:int|None=None) -> list[tuple[int, str]]:
        query=select(Push_Device.p_d_id, type_coerce(Push_Device.expo_token, String).label("expo_token_raw"))
        result=await db.execute(owner_where(query, Push_Device.u_id, u_id).order_by(Push_Device.p_d_id))
        return [(row.p_d_id, row.expo_token_raw) for row in result.all()]


    # 토큰 블라인드 인덱스로 기기 찾기 (암호화한 열은 == 로 찾지 않는다)
    @staticmethod
    async def crud_notification_device_get_by_bidx(db:AsyncSession, expo_token_bidx:str) -> Push_Device | None:
        result=await db.execute(select(Push_Device).where(Push_Device.expo_token_bidx == expo_token_bidx))
        return result.scalars().first()


    # 기기 번호로 찾기 - u_id 가 있으면 그 사용자 기기만
    @staticmethod
    async def crud_notification_device_get_by_p_d_id(db:AsyncSession, p_d_id:int, u_id:int|None=None) -> Push_Device | None:
        result=await db.execute(owner_where(select(Push_Device).where(Push_Device.p_d_id == p_d_id), Push_Device.u_id, u_id))
        return result.scalars().first()


    # 기기 등록 - 토큰은 암호문으로, 찾기용 블라인드 인덱스를 같이 저장한다
    @staticmethod
    async def crud_notification_device_create(db:AsyncSession, expo_token:str, platform:str, u_id:int|None=None) -> Push_Device:
        db_device=Push_Device(expo_token=expo_token, expo_token_bidx=blind_index("expo_token", expo_token), platform=platform, u_id=u_id)
        db.add(db_device)
        await db.flush()
        return db_device


    # 기기 정보 갱신 - 같은 토큰이 다시 오면 플랫폼과 마지막으로 본 시각을 바꾸고, u_id 가 있으면 그 사용자 기기로 옮긴다
    @staticmethod
    async def crud_notification_device_touch(db:AsyncSession, db_device:Push_Device, platform:str, seen_at:datetime, u_id:int|None=None) -> Push_Device:
        db_device.platform=platform
        db_device.last_seen_at=seen_at
        if u_id is not None:
            db_device.u_id=u_id
        await db.flush()
        return db_device


    # 기기 지우기
    @staticmethod
    async def crud_notification_device_delete(db:AsyncSession, db_device:Push_Device) -> None:
        await db.delete(db_device)
        await db.flush()


    # 토큰들로 기기 지우기 - 더는 쓸 수 없는 토큰 정리 (블라인드 인덱스로 찾는다)
    @staticmethod
    async def crud_notification_device_delete_by_tokens(db:AsyncSession, tokens:list[str]) -> int:
        if not tokens:
            return 0

        bidxs=[blind_index("expo_token", token) for token in tokens]
        result=await db.execute(delete(Push_Device).where(Push_Device.expo_token_bidx.in_(bidxs)).execution_options(synchronize_session=False))
        await db.flush()
        return result.rowcount
