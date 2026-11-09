import asyncio
import re
import smtplib
from dataclasses import dataclass, field
from email.message import EmailMessage

import httpx

from shared.settings import settings
from shared.masking import mask_text, MASK

# 알림 발송기 - 메일(SMTP)과 앱 푸시(Expo). 여기서는 보내기만 하고 실패는 호출한 쪽이 기록한다
# 토큰·비밀번호·메일 본문은 로그에 남기지 않는다 (Hard rule 6)

PUSH_BATCH_SIZE=100
PUSH_TITLE_MAX=100
PUSH_BODY_MAX=120
ERROR_MAX=200

EXPO_TOKEN_PATTERN=re.compile(r"(?:Exponent|Expo)PushToken\[[^\]]*\]")

# 시험용 - 지정하면 푸시 요청이 이 transport 로 나간다 (httpx.MockTransport)
PUSH_TRANSPORT=None


# 푸시 발송 결과 - 보낸 수, 못 보낸 수, 더는 쓸 수 없는 토큰, 대표 오류 문장
@dataclass
class Push_Result:
    sent: int = 0
    failed: int = 0
    invalid_tokens: list[str] = field(default_factory=list)
    error: str | None = None


# 글에서 비밀 값 지우기 - 일반 마스킹 + Expo 토큰 + 메일 비밀번호
def dispatch_scrub(text:str|None) -> str:
    cleaned=EXPO_TOKEN_PATTERN.sub(MASK, mask_text(text))

    if settings.mail_password:
        cleaned=cleaned.replace(settings.mail_password, MASK)

    return cleaned


# 메일을 보낼 수 있게 설정돼 있는지 - 서버 주소와 받는 사람이 모두 있어야 한다
def dispatch_mail_configured() -> bool:
    return bool(settings.mail_host and settings.mail_to)


# 메일 보내기 (블로킹) - STARTTLS 후 로그인하고 보낸다. 제한 시간은 MAIL_TIMEOUT_SECONDS
def dispatch_mail_send_blocking(message:EmailMessage) -> None:
    with smtplib.SMTP(settings.mail_host, settings.mail_port, timeout=settings.mail_timeout_seconds) as client:
        client.starttls()

        if settings.mail_user:
            client.login(settings.mail_user, settings.mail_password or "")

        client.send_message(message)


# 메일 보내기 - 설정이 없으면 조용히 건너뛴다. 실패하면 예외를 그대로 올린다 (기록은 호출한 쪽)
async def dispatch_mail_send(subject:str, body:str) -> None:
    if not dispatch_mail_configured():
        return

    recipients=[address.strip() for address in settings.mail_to.split(",") if address.strip()]

    message=EmailMessage()
    message["Subject"]=subject
    message["From"]=settings.mail_from or settings.mail_user or recipients[0]
    message["To"]=", ".join(recipients)
    message.set_content(body)

    await asyncio.to_thread(dispatch_mail_send_blocking, message)


# 푸시 응답 표 한 칸씩 읽기 - ok 면 보낸 것, error 면 못 보낸 것 (DeviceNotRegistered 는 토큰을 버린다)
def dispatch_push_read_tickets(tokens:list[str], tickets, result:Push_Result) -> None:
    if isinstance(tickets, dict):
        tickets=[tickets]
    if not isinstance(tickets, list):
        tickets=[]

    for index, token in enumerate(tokens):
        ticket=tickets[index] if index < len(tickets) and isinstance(tickets[index], dict) else None

        if ticket is not None and ticket.get("status") == "ok":
            result.sent+=1
            continue

        result.failed+=1
        details=(ticket or {}).get("details") or {}

        if details.get("error") == "DeviceNotRegistered":
            result.invalid_tokens.append(token)

        if result.error is None:
            message=(ticket or {}).get("message") or "응답에 결과가 없습니다"
            result.error=dispatch_scrub(f"Expo 전송 거부: {message}")[:ERROR_MAX]


# 푸시 보내기 - 기기마다 한 건씩 100건 묶음으로 Expo 에 POST. 실패는 예외가 아니라 결과에 담는다
async def dispatch_push_send(devices:list, title:str, body:str, link:str, transport=None) -> Push_Result:
    result=Push_Result()
    tokens=[device.expo_token for device in devices]

    if not tokens:
        return result

    clean_title=dispatch_scrub(title)[:PUSH_TITLE_MAX]
    clean_body=dispatch_scrub(body)[:PUSH_BODY_MAX]

    async with httpx.AsyncClient(timeout=settings.expo_push_timeout_seconds, transport=transport or PUSH_TRANSPORT) as client:
        for start in range(0, len(tokens), PUSH_BATCH_SIZE):
            batch=tokens[start:start + PUSH_BATCH_SIZE]
            messages=[{"to": token, "title": clean_title, "body": clean_body, "data": {"link": link}} for token in batch]

            try:
                response=await client.post(settings.expo_push_url, json=messages, headers={"accept": "application/json"})

                if response.status_code >= 400:
                    result.failed+=len(batch)
                    if result.error is None:
                        result.error=dispatch_scrub(f"Expo 응답 오류 HTTP {response.status_code}")[:ERROR_MAX]
                    continue

                dispatch_push_read_tickets(batch, response.json().get("data"), result)

            except Exception as e:
                result.failed+=len(batch)
                if result.error is None:
                    result.error=dispatch_scrub(f"{type(e).__name__}: {e}")[:ERROR_MAX]

    return result
