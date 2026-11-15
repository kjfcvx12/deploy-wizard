import json
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

from shared.settings import settings

from features.pricing.scheme import Price_Table
from features.pricing.services import Pricing_Service

# 가격 파일 읽기와 캐시 시험 - 가짜 가격 JSON 과 가짜 fetch 만 쓴다 (진짜 네트워크 없음)

REGION="ap-northeast-2"


# 가짜 가격 파일 만들기 - rows 는 (usagetype, productFamily, 요금, 운영체제 또는 None)
def make_price_file(rows, publication="2026-11-11T23:46:23Z", region=REGION):
    products={}
    on_demand={}
    for i, (usage, family, price, os_name) in enumerate(rows):
        sku=f"SKU{i}"
        attributes={"usagetype": usage, "regionCode": region}
        if os_name:
            attributes["operatingSystem"]=os_name
        products[sku]={"sku": sku, "productFamily": family, "attributes": attributes}
        on_demand[sku]={f"{sku}.JRTCKXETXF": {"priceDimensions": {f"{sku}.JRTCKXETXF.6YS6EN2CT7": {"unit": "Hrs", "pricePerUnit": {"USD": str(price)}}}}}
    return {"publicationDate": publication, "products": products, "terms": {"OnDemand": on_demand}}


ECS_ROWS=[
    ("APN2-Fargate-vCPU-Hours:perCPU", "Compute", 0.04656, None),
    ("APN2-Fargate-GB-Hours", "Compute", 0.00511, None),
    ("APN2-Fargate-ARM-vCPU-Hours:perCPU", "Compute", 0.03725, None),
    ("APN2-Fargate-ARM-GB-Hours", "Compute", 0.00409, None),
    ("APN2-Fargate-Windows-vCPU-Hours:perCPU", "Compute", 0.09, "Windows"),
    ("APN2-Fargate-Windows-GB-Hours", "Compute", 0.02, "Windows"),
    ("APN2-Fargate-EphemeralStorage-GB-Hours", "Compute", 0.00011, None),
]

# ELB 행 만들기 - 진짜 가격 파일처럼 잡음 행(Outposts·TS·Reserved, 요금 0)을 진짜 행보다 앞에 둔다. prefix 는 리전 접두사("APN2-") 또는 접두사 없는 모양("")
def make_elb_rows(prefix):
    return [
        (f"{prefix}Outposts-LoadBalancerUsage", "Load Balancer-Application", 0.0111, None),
        (f"{prefix}TS-LoadBalancerUsage", "Load Balancer-Application", 0.005, None),
        (f"{prefix}Outposts-LCUUsage", "Load Balancer-Application", 0, None),
        (f"{prefix}ReservedLCUUsage", "Load Balancer-Application", 0.0044, None),
        (f"{prefix}LoadBalancerUsage", "Load Balancer-Network", 0.0999, None),
        (f"{prefix}LoadBalancerUsage", "Load Balancer-Gateway", 0.0125, None),
        (f"{prefix}LoadBalancerUsage", "Load Balancer", 0.0333, None),
        (f"{prefix}LoadBalancerUsage", "Load Balancer-Application", 0.0225, None),
        (f"{prefix}LCUUsage", "Load Balancer-Network", 0.006, None),
        (f"{prefix}LCUUsage", "Load Balancer-Application", 0.008, None),
    ]


ELB_ROWS=make_elb_rows("APN2-")


@pytest.fixture
def cache_tmp(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "cache_dir", str(tmp_path))
    return tmp_path


# 가짜 fetch - URL 에 따라 ECS·ELB 파일을 돌려주고 부른 URL 을 기록한다
class Fake_Fetch:

    def __init__(self, error=None):
        self.urls=[]
        self.error=error

    async def __call__(self, url):
        self.urls.append(url)
        if self.error:
            raise self.error
        region=url.split("/current/")[1].split("/")[0]
        return make_price_file(ECS_ROWS, region=region) if "AmazonECS" in url else make_price_file(ELB_ROWS, region=region)


def test_pricing_parse_picks_x86_fargate_and_alb():
    table=Pricing_Service.services_pricing_parse(make_price_file(ECS_ROWS), make_price_file(ELB_ROWS), REGION)
    assert table is not None
    assert table.region == REGION
    assert table.basis_date == "2026-11-11"
    assert table.fargate_vcpu_hour == 0.04656
    assert table.fargate_gb_hour == 0.00511
    assert table.fargate_arm_vcpu_hour == 0.03725
    assert table.fargate_arm_gb_hour == 0.00409


def test_pricing_parse_alb_only_application_family():
    table=Pricing_Service.services_pricing_parse(make_price_file(ECS_ROWS), make_price_file(ELB_ROWS), REGION)
    assert table.alb_hour == 0.0225
    assert table.lcu_hour == 0.008


def test_pricing_parse_alb_ignores_noise_rows_in_both_shapes():
    for prefix, region in (("APN2-", "ap-northeast-2"), ("", "us-east-1")):
        ecs=make_price_file(ECS_ROWS, region=region)
        table=Pricing_Service.services_pricing_parse(ecs, make_price_file(make_elb_rows(prefix), region=region), region)
        assert table is not None
        assert table.alb_hour == 0.0225
        assert table.lcu_hour == 0.008


def test_pricing_parse_rejects_non_finite_price():
    ecs=make_price_file([("APN2-Fargate-vCPU-Hours:perCPU", "Compute", "NaN", None)] + ECS_ROWS[1:])
    assert Pricing_Service.services_pricing_parse(ecs, make_price_file(ELB_ROWS), REGION) is None
    ecs=make_price_file([("APN2-Fargate-vCPU-Hours:perCPU", "Compute", "Infinity", None)] + ECS_ROWS[1:])
    assert Pricing_Service.services_pricing_parse(ecs, make_price_file(ELB_ROWS), REGION) is None


def test_pricing_parse_missing_returns_none():
    ecs_without_vcpu=make_price_file([row for row in ECS_ROWS if "vCPU" not in row[0]])
    assert Pricing_Service.services_pricing_parse(ecs_without_vcpu, make_price_file(ELB_ROWS), REGION) is None
    assert Pricing_Service.services_pricing_parse({}, {}, REGION) is None
    assert Pricing_Service.services_pricing_parse(make_price_file(ECS_ROWS), {}, REGION) is None
    assert Pricing_Service.services_pricing_parse(None, "깨짐", REGION) is None


@pytest.mark.asyncio
async def test_pricing_table_fetches_and_caches(cache_tmp):
    fetch=Fake_Fetch()
    now=datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)
    first=await Pricing_Service.services_pricing_table(fetch=fetch, now=now)
    assert first is not None
    assert first.region == REGION
    assert len(fetch.urls) == 2
    assert any("AmazonECS" in u and REGION in u for u in fetch.urls)
    assert any("AWSELB" in u and REGION in u for u in fetch.urls)
    assert (cache_tmp / "pricing-ap-northeast-2.json").exists()

    second=await Pricing_Service.services_pricing_table(fetch=fetch, now=now + timedelta(hours=23))
    assert second == first
    assert len(fetch.urls) == 2


@pytest.mark.asyncio
async def test_pricing_table_stale_cache_on_fetch_failure(cache_tmp):
    now=datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)
    first=await Pricing_Service.services_pricing_table(fetch=Fake_Fetch(), now=now)

    failing=Fake_Fetch(error=RuntimeError("network down"))
    stale=await Pricing_Service.services_pricing_table(fetch=failing, now=now + timedelta(hours=25))
    assert len(failing.urls) >= 1
    assert stale is not None
    assert stale.basis_date == first.basis_date == "2026-11-11"

    (cache_tmp / "pricing-ap-northeast-2.json").unlink()
    assert await Pricing_Service.services_pricing_table(fetch=failing, now=now + timedelta(hours=25)) is None


@pytest.mark.asyncio
async def test_pricing_table_broken_cache_is_ignored(cache_tmp):
    (cache_tmp / "pricing-ap-northeast-2.json").write_text("{깨진", encoding="utf-8")
    fetch=Fake_Fetch()
    table=await Pricing_Service.services_pricing_table(fetch=fetch)
    assert table is not None
    assert len(fetch.urls) == 2
    assert json.loads((cache_tmp / "pricing-ap-northeast-2.json").read_text(encoding="utf-8"))["table"]["alb_hour"] == 0.0225


@pytest.mark.asyncio
async def test_pricing_table_rejects_bad_region(cache_tmp):
    fetch=Fake_Fetch()
    before=set(cache_tmp.parent.iterdir())
    for bad in ("../../x", "ap-northeast-2/../..", ""):
        assert await Pricing_Service.services_pricing_table(region=bad, fetch=fetch) is None
    assert fetch.urls == []
    assert list(cache_tmp.iterdir()) == []
    assert set(cache_tmp.parent.iterdir()) == before
    good=await Pricing_Service.services_pricing_table(region="us-east-1", fetch=fetch)
    assert good is not None
    assert (cache_tmp / "pricing-us-east-1.json").exists()


@pytest.mark.asyncio
async def test_pricing_table_future_cache_is_stale(cache_tmp):
    now=datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)
    await Pricing_Service.services_pricing_table(fetch=Fake_Fetch(), now=now)
    fetch=Fake_Fetch()
    await Pricing_Service.services_pricing_table(fetch=fetch, now=now - timedelta(hours=2))
    assert len(fetch.urls) == 2


# 비용 추정 시험용 가짜 단가 표 - 값은 시험 안에서만 쓴다 (코드에는 가격 상수가 없다)
def make_table(arm=True):
    return Price_Table(
        region="ap-northeast-2", basis_date="2026-11-11",
        fargate_vcpu_hour=0.04656, fargate_gb_hour=0.00511,
        fargate_arm_vcpu_hour=0.03725 if arm else None, fargate_arm_gb_hour=0.00403 if arm else None,
        alb_hour=0.0225, lcu_hour=0.008,
    )


def test_pricing_spec_options_and_valid():
    options=Pricing_Service.services_pricing_spec_options()
    assert [(o.cpu, o.memory, o.label) for o in options] == [
        ("256", "512", "0.25 vCPU / 0.5 GB"),
        ("512", "1024", "0.5 vCPU / 1 GB"),
        ("1024", "2048", "1 vCPU / 2 GB"),
        ("2048", "4096", "2 vCPU / 4 GB"),
    ]
    assert [(o.vcpu, o.memory_gb) for o in options] == [(0.25, 0.5), (0.5, 1.0), (1.0, 2.0), (2.0, 4.0)]
    assert Pricing_Service.services_pricing_spec_valid(None, None) is True
    assert Pricing_Service.services_pricing_spec_valid("256", "512") is True
    assert Pricing_Service.services_pricing_spec_valid("512", "1024") is True
    assert Pricing_Service.services_pricing_spec_valid("256", None) is False
    assert Pricing_Service.services_pricing_spec_valid(None, "512") is False
    assert Pricing_Service.services_pricing_spec_valid("256", "2048") is False
    assert Pricing_Service.services_pricing_spec_valid("300", "512") is False


def test_pricing_estimate_default_spec():
    estimate=Pricing_Service.services_pricing_estimate(make_table())
    assert estimate.hourly_usd == 0.0367
    assert estimate.spec_is_default is True
    assert (estimate.cpu, estimate.memory, estimate.spec_label) == ("256", "512", "0.25 vCPU / 0.5 GB")
    assert estimate.basis_date == "2026-11-11"
    assert estimate.region == "ap-northeast-2"
    assert estimate.currency == "USD"
    assert len(estimate.components) == 2
    assert round(sum(c.hourly_usd for c in estimate.components), 4) == estimate.hourly_usd
    periods={p.label: p for p in estimate.periods}
    assert [p.label for p in estimate.periods] == ["1시간", "1일", "1주", "한 달"]
    assert [p.hours for p in estimate.periods] == [1, 24, 168, 730]
    assert periods["1일"].usd == 0.88
    # 0.036695 x 730 = 26.78735 -> 26.79 (과제 설명서의 26.78 은 계산과 달라 계산값을 쓴다)
    assert periods["한 달"].usd == 26.79
    assert any("기본 사양" in a for a in estimate.assumptions)
    assert any("2026-11-11" in a for a in estimate.assumptions)
    for word in ("LCU", "데이터 전송", "로그", "ECR"):
        assert any(word in n for n in estimate.not_included), word


def test_pricing_estimate_1024_2048():
    estimate=Pricing_Service.services_pricing_estimate(make_table(), "1024", "2048")
    assert estimate.hourly_usd == 0.0793
    assert estimate.spec_label == "1 vCPU / 2 GB"
    assert estimate.spec_is_default is False
    assert not any("기본 사양" in a for a in estimate.assumptions)


def test_pricing_estimate_planned_hours():
    table=make_table()
    assert Pricing_Service.services_pricing_estimate(table, planned_hours=8).planned_usd == 0.29
    assert Pricing_Service.services_pricing_estimate(table, planned_hours=8).planned_hours == 8
    assert Pricing_Service.services_pricing_estimate(table).planned_usd is None


def test_pricing_estimate_max_tasks():
    table=make_table()
    four=Pricing_Service.services_pricing_estimate(table, max_tasks=4)
    assert four.max_tasks == 4
    assert four.max_hourly_usd == round(4*0.01419+0.0225, 4) == 0.0793
    assert four.max_monthly_usd == round((4*0.014195+0.0225)*730, 2)
    none=Pricing_Service.services_pricing_estimate(table)
    assert none.max_hourly_usd is None and none.max_monthly_usd is None
    one=Pricing_Service.services_pricing_estimate(table, max_tasks=1)
    assert one.max_hourly_usd == one.hourly_usd


def test_pricing_scaling_valid():
    check=Pricing_Service.services_pricing_scaling_valid
    assert check(None, None, None, None, 4) is None
    assert check(1, 3, "AVERAGE_CPU", 60, 4) is None
    assert check(1, 3, "AVERAGE_MEMORY", 100, 4) is None
    assert check(1, 3, "REQUEST_COUNT_PER_TARGET", 100000, 4) is None
    for bad in (
        (1, None, None, None),
        (1, 3, "AVERAGE_CPU", None),
        (3, 1, "AVERAGE_CPU", 60),
        (0, 3, "AVERAGE_CPU", 60),
        (1, 5, "AVERAGE_CPU", 60),
        (1, 3, "FOO", 60),
        (1, 3, "AVERAGE_CPU", 0),
        (1, 3, "AVERAGE_CPU", 101),
        (1, 3, "AVERAGE_MEMORY", 101),
        (1, 3, "REQUEST_COUNT_PER_TARGET", 0),
        (1, 3, "REQUEST_COUNT_PER_TARGET", 100001),
    ):
        message=check(*bad, 4)
        assert isinstance(message, str) and message, bad
    assert check(1, 5, "AVERAGE_CPU", 60, 4) != check(1, 3, "FOO", 60, 4)


def test_pricing_estimate_arm64_comparison():
    estimate=Pricing_Service.services_pricing_estimate(make_table())
    assert estimate.arm64_hourly_usd == 0.0338
    assert estimate.arm64_saving_percent == 7.8
    no_arm=Pricing_Service.services_pricing_estimate(make_table(arm=False))
    assert no_arm.arm64_hourly_usd is None
    assert no_arm.arm64_saving_percent is None


def test_pricing_estimate_rejects_non_preset():
    with pytest.raises(ValueError):
        Pricing_Service.services_pricing_estimate(make_table(), "300", "512")
    with pytest.raises(ValueError):
        Pricing_Service.services_pricing_estimate(make_table(), "256", None)


# ---- 가격 API (GET /api/pricing/options, POST /api/pricing/estimate) ----

@pytest_asyncio.fixture
async def client():
    import main

    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as c:
        yield c


# 단가 표를 가짜로 바꾼다 - None 이면 가격을 못 얻은 경우
def patch_table(monkeypatch, table):
    async def fake_table(region=None, fetch=None, now=None):
        return table

    monkeypatch.setattr(Pricing_Service, "services_pricing_table", staticmethod(fake_table))


@pytest.mark.asyncio
async def test_pricing_options_endpoint(client):
    response=await client.get("/api/pricing/options")

    assert response.status_code == 200
    body=response.json()
    assert len(body["specs"]) == 4
    assert body["specs"][0]["cpu"] == "256"
    assert body["specs"][0]["memory"] == "512"
    assert [p["label"] for p in body["plans"]] == ["4시간", "하루", "일주일", "계속"]
    assert [p["hours"] for p in body["plans"]] == [4, 24, 168, None]


@pytest.mark.asyncio
async def test_pricing_estimate_endpoint_ok(client, monkeypatch):
    patch_table(monkeypatch, make_table())

    response=await client.post("/api/pricing/estimate", json={"cpu": "1024", "memory": "2048", "planned_hours": 24})

    assert response.status_code == 200
    body=response.json()
    assert body["hourly_usd"] == 0.0793
    # (0.04656 + 2 x 0.00511 + 0.0225) x 24 = 1.90272 -> 1.9
    assert body["planned_usd"] == 1.9
    assert body["planned_hours"] == 24
    assert body["spec_is_default"] is False


@pytest.mark.asyncio
async def test_pricing_estimate_endpoint_defaults_and_max_tasks(client, monkeypatch):
    patch_table(monkeypatch, make_table())

    response=await client.post("/api/pricing/estimate", json={})
    assert response.status_code == 200
    assert response.json()["spec_is_default"] is True

    # 빈 글자·공백만 있는 사양은 비어 있는 것으로 본다
    response=await client.post("/api/pricing/estimate", json={"cpu": "", "memory": "  "})
    assert response.status_code == 200
    assert response.json()["spec_is_default"] is True

    response=await client.post("/api/pricing/estimate", json={"max_tasks": settings.max_tasks_cap})
    assert response.status_code == 200
    assert response.json()["max_tasks"] == settings.max_tasks_cap
    assert response.json()["max_hourly_usd"] is not None


# 한국어 detail 인지 - 한글이 한 글자라도 있으면 된다
def has_korean(detail):
    return isinstance(detail, str) and any("가" <= ch <= "힣" for ch in detail)


@pytest.mark.asyncio
async def test_pricing_estimate_endpoint_bad_input(client, monkeypatch):
    patch_table(monkeypatch, make_table())

    bad_bodies=[
        {"cpu": "300", "memory": "512"},
        {"cpu": "256"},
        {"memory": "512"},
        {"cpu": "256", "memory": ""},
        {"cpu": "256", "memory": "2048"},
        {"planned_hours": 0},
        {"planned_hours": -1},
        {"planned_hours": 9000},
        {"planned_hours": 8760.5},
        {"planned_hours": 10**400},
        {"max_tasks": 0},
        {"max_tasks": -1},
        {"max_tasks": settings.max_tasks_cap + 1},
    ]
    for body in bad_bodies:
        response=await client.post("/api/pricing/estimate", json=body)
        assert response.status_code == 400, body
        assert has_korean(response.json()["detail"]), body

    # 경계값은 통과한다
    for body in ({"planned_hours": 8760}, {"planned_hours": 0.5}, {"max_tasks": 1}):
        response=await client.post("/api/pricing/estimate", json=body)
        assert response.status_code == 200, body


@pytest.mark.asyncio
async def test_pricing_estimate_endpoint_rejects_non_finite_hours(client, monkeypatch):
    patch_table(monkeypatch, make_table())

    for literal in ("NaN", "Infinity", "-Infinity"):
        response=await client.post("/api/pricing/estimate", content=f'{{"planned_hours": {literal}}}'.encode(),
                                   headers={"content-type": "application/json"})
        assert response.status_code == 400, literal
        assert has_korean(response.json()["detail"]), literal


@pytest.mark.asyncio
async def test_pricing_estimate_endpoint_rejects_wrong_json_types(client, monkeypatch):
    patch_table(monkeypatch, make_table())

    for body in ({"max_tasks": True}, {"max_tasks": 2.0}, {"max_tasks": "2"}, {"planned_hours": True},
                 {"planned_hours": "24"}, {"cpu": 256, "memory": "512"}):
        response=await client.post("/api/pricing/estimate", json=body)
        assert 400 <= response.status_code < 500, body
        assert response.status_code != 200, body


@pytest.mark.asyncio
async def test_pricing_estimate_endpoint_503_without_prices(client, monkeypatch):
    patch_table(monkeypatch, None)

    response=await client.post("/api/pricing/estimate", json={"cpu": "256", "memory": "512"})

    assert response.status_code == 503
    assert response.json()["detail"] == "가격 정보를 가져오지 못했습니다. 잠시 뒤 다시 시도하세요"
