import json
from datetime import datetime, timedelta, timezone

import pytest

from shared.settings import settings

from features.pricing.services import Pricing_Service

# 가격 파일 읽기와 캐시 시험 - 가짜 가격 JSON 과 가짜 fetch 만 쓴다 (진짜 네트워크 없음)

REGION="ap-northeast-2"


# 가짜 가격 파일 만들기 - rows 는 (usagetype, productFamily, 요금, 운영체제 또는 None)
def make_price_file(rows, publication="2026-11-11T23:46:23Z"):
    products={}
    on_demand={}
    for i, (usage, family, price, os_name) in enumerate(rows):
        sku=f"SKU{i}"
        attributes={"usagetype": usage, "regionCode": REGION}
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

ELB_ROWS=[
    ("APN2-LoadBalancerUsage", "Load Balancer-Network", 0.0999, None),
    ("APN2-LoadBalancerUsage", "Load Balancer-Gateway", 0.0125, None),
    ("APN2-LoadBalancerUsage", "Load Balancer-Application", 0.0225, None),
    ("APN2-LCUUsage", "Load Balancer-Network", 0.006, None),
    ("APN2-LCUUsage", "Load Balancer-Application", 0.008, None),
]


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
        return make_price_file(ECS_ROWS) if "AmazonECS" in url else make_price_file(ELB_ROWS)


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
