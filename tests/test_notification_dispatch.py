import json
import ssl
from types import SimpleNamespace

import httpx
import pytest

from shared.settings import settings

from features.notifications import dispatch
from features.notifications.dispatch import dispatch_mail_send, dispatch_mail_configured, dispatch_push_send, dispatch_scrub

# 메일·푸시 발송기 시험 - 진짜 SMTP·Expo 는 부르지 않는다 (가짜 SMTP 클래스, httpx.MockTransport)

AWS_KEY="AKIAABCDEFGHIJKLMNOP"
EXPO_TOKEN="ExponentPushToken[abcdefghijklmnop]"


class Fake_Smtp:
    instances=[]

    def __init__(self, host, port, timeout=None):
        self.host, self.port, self.timeout=host, port, timeout
        self.calls=[]
        self.sent=[]
        Fake_Smtp.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def starttls(self, *, context=None):
        self.context=context
        self.calls.append("starttls")

    def login(self, user, password):
        self.calls.append(("login", user, password))

    def send_message(self, message):
        self.calls.append("send")
        self.sent.append(message)


@pytest.fixture
def smtp(monkeypatch):
    Fake_Smtp.instances=[]
    monkeypatch.setattr(dispatch.smtplib, "SMTP", Fake_Smtp)
    monkeypatch.setattr(settings, "mail_host", "smtp.test")
    monkeypatch.setattr(settings, "mail_port", 2525)
    monkeypatch.setattr(settings, "mail_user", "bot@test")
    monkeypatch.setattr(settings, "mail_password", "pw-for-test")
    monkeypatch.setattr(settings, "mail_from", "wizard@test")
    monkeypatch.setattr(settings, "mail_to", "me@test")
    return Fake_Smtp


def devices(count, prefix="d"):
    return [SimpleNamespace(p_d_id=n, expo_token=f"ExponentPushToken[{prefix}{n:04d}]") for n in range(count)]


def expo_transport(handler_log, tickets_for=None):
    def handler(request):
        messages=json.loads(request.content)
        handler_log.append((str(request.url), messages))
        tickets=tickets_for(messages) if tickets_for else [{"status": "ok", "id": "t"} for _ in messages]
        return httpx.Response(200, json={"data": tickets})

    return httpx.MockTransport(handler)


def test_dispatch_mail_configured_needs_host_and_to(monkeypatch):
    monkeypatch.setattr(settings, "mail_host", None)
    monkeypatch.setattr(settings, "mail_to", "me@test")
    assert dispatch_mail_configured() is False

    monkeypatch.setattr(settings, "mail_host", "smtp.test")
    monkeypatch.setattr(settings, "mail_to", "")
    assert dispatch_mail_configured() is False

    monkeypatch.setattr(settings, "mail_to", "me@test")
    assert dispatch_mail_configured() is True


@pytest.mark.asyncio
async def test_dispatch_mail_send_uses_starttls_login_and_subject(smtp):
    await dispatch_mail_send("[배포 마법사] my-api 문제", "본문 한 줄")

    client=smtp.instances[0]
    assert (client.host, client.port) == ("smtp.test", 2525)
    assert client.timeout == settings.mail_timeout_seconds == 10
    assert client.calls == ["starttls", ("login", "bot@test", "pw-for-test"), "send"]

    message=client.sent[0]
    assert message["Subject"] == "[배포 마법사] my-api 문제"
    assert message["To"] == "me@test" and message["From"] == "wizard@test"
    assert "본문 한 줄" in message.get_content()


@pytest.mark.asyncio
async def test_dispatch_mail_send_skips_login_without_user(smtp, monkeypatch):
    monkeypatch.setattr(settings, "mail_user", None)

    await dispatch_mail_send("제목", "본문")

    assert smtp.instances[0].calls == ["starttls", "send"]


@pytest.mark.asyncio
async def test_dispatch_mail_send_when_unconfigured_does_nothing(monkeypatch):
    monkeypatch.setattr(settings, "mail_host", "")

    def boom(*args, **kwargs):
        raise AssertionError("SMTP 에 연결하면 안 된다")

    monkeypatch.setattr(dispatch.smtplib, "SMTP", boom)

    await dispatch_mail_send("제목", "본문")


@pytest.mark.asyncio
async def test_dispatch_push_send_batches_of_100(monkeypatch):
    log=[]
    monkeypatch.setattr(dispatch, "PUSH_TRANSPORT", expo_transport(log))

    result=await dispatch_push_send(devices(250), "제목", "본문", "deploywizard://incidents/7")

    assert [len(messages) for _, messages in log] == [100, 100, 50]
    assert log[0][0] == settings.expo_push_url
    first=log[0][1][0]
    assert first == {"to": "ExponentPushToken[d0000]", "title": "제목", "body": "본문", "data": {"link": "deploywizard://incidents/7"}}
    assert result.sent == 250 and result.failed == 0 and result.invalid_tokens == [] and result.error is None


@pytest.mark.asyncio
async def test_dispatch_push_send_reports_only_the_unregistered_device(monkeypatch):
    log=[]

    def tickets(messages):
        return [{"status": "error", "message": "x", "details": {"error": "DeviceNotRegistered"}} if message["to"] == "ExponentPushToken[d0003]"
                else {"status": "ok", "id": "t"} for message in messages]

    monkeypatch.setattr(dispatch, "PUSH_TRANSPORT", expo_transport(log, tickets))

    result = await dispatch_push_send(devices(5), "제목", "본문", "deploywizard://deploys/1")

    assert result.invalid_tokens == ["ExponentPushToken[d0003]"]
    assert result.sent == 4 and result.failed == 1


@pytest.mark.asyncio
async def test_dispatch_push_send_http_error_is_reported_not_raised(monkeypatch):
    def handler(request):
        return httpx.Response(500, json={"errors": [{"code": "INTERNAL", "message": f"서버 오류 {AWS_KEY}"}]})

    monkeypatch.setattr(dispatch, "PUSH_TRANSPORT", httpx.MockTransport(handler))

    result=await dispatch_push_send(devices(2), "제목", "본문", "deploywizard://deploys/1")

    assert result.sent == 0 and result.failed == 2
    assert "500" in result.error and AWS_KEY not in result.error


@pytest.mark.asyncio
async def test_dispatch_push_send_network_error_is_reported_and_masked(monkeypatch):
    def handler(request):
        raise httpx.ConnectError(f"연결 실패 {EXPO_TOKEN}")

    monkeypatch.setattr(dispatch, "PUSH_TRANSPORT", httpx.MockTransport(handler))

    result=await dispatch_push_send(devices(1), "제목", "본문", "deploywizard://deploys/1")

    assert result.failed == 1 and result.sent == 0
    assert EXPO_TOKEN not in result.error and "abcdefghijklmnop" not in result.error


@pytest.mark.asyncio
async def test_dispatch_push_send_without_devices_makes_no_request(monkeypatch):
    log=[]
    monkeypatch.setattr(dispatch, "PUSH_TRANSPORT", expo_transport(log))

    result=await dispatch_push_send([], "제목", "본문", "x")

    assert log == [] and result.sent == 0 and result.failed == 0


@pytest.mark.asyncio
async def test_dispatch_push_send_cuts_body_to_120_chars(monkeypatch):
    log=[]
    monkeypatch.setattr(dispatch, "PUSH_TRANSPORT", expo_transport(log))

    await dispatch_push_send(devices(1), "제" * 300, "본" * 500, "x")

    sent=log[0][1][0]
    assert len(sent["body"]) <= 120 and len(sent["title"]) <= 100


def test_dispatch_scrub_masks_keys_expo_tokens_and_mail_password(monkeypatch):
    monkeypatch.setattr(settings, "mail_password", "pw-for-test")

    text=dispatch_scrub(f"키 {AWS_KEY} 토큰 {EXPO_TOKEN} 비밀번호 pw-for-test 끝")

    assert AWS_KEY not in text and "abcdefghijklmnop" not in text and "pw-for-test" not in text
    assert text.startswith("키 ") and text.endswith(" 끝")


@pytest.mark.asyncio
async def test_dispatch_mail_send_verifies_certificate_before_login(smtp):
    await dispatch_mail_send("제목", "본문")

    client=smtp.instances[0]
    assert client.calls.index("starttls") < client.calls.index(("login", "bot@test", "pw-for-test"))
    assert isinstance(client.context, ssl.SSLContext)
    assert client.context.verify_mode == ssl.CERT_REQUIRED and client.context.check_hostname is True


def test_dispatch_scrub_ignores_too_short_mail_password(monkeypatch):
    monkeypatch.setattr(settings, "mail_password", "ab")

    assert dispatch_scrub("abc 배포 table") == "abc 배포 table"

    monkeypatch.setattr(settings, "mail_password", "abcd")
    assert "abcd" not in dispatch_scrub("값 abcd 끝")


@pytest.mark.asyncio
async def test_dispatch_mail_send_strips_line_breaks_from_subject(smtp):
    await dispatch_mail_send("[배포 마법사] svc\r\nBcc: evil@test 제목\n둘째", "본문")

    subject=smtp.instances[0].sent[0]["Subject"]
    assert "\r" not in subject and "\n" not in subject and "Bcc: evil@test" in subject
    assert smtp.instances[0].sent[0]["Bcc"] is None
