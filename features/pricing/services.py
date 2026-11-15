import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

import httpx

from shared.settings import settings

from features.pricing.scheme import Price_Table

# 가격 파일 읽기와 캐시 (기획 설계 5.1) - 파일은 인증 없는 AWS 공개 가격 파일
# 파싱 실패·누락은 예외가 아니라 None, 네트워크 실패도 낡은 캐시 또는 None 으로 돌려준다 (금액 없음)

logger=logging.getLogger(__name__)

PRICE_URL="https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{service}/current/{region}/index.json"
FETCH_TIMEOUT_SECONDS=30

# 리전 접두사(APN2, USE1 ...)는 리전마다 달라 접미사로만 고른다 - 접두사 없이 대문자·숫자 한 조각만 허용해 Outposts·TS 변형을 거른다
ALB_USAGE_PATTERN=re.compile(r"^(?:[A-Z0-9]+-)?LoadBalancerUsage$")
LCU_USAGE_PATTERN=re.compile(r"^(?:[A-Z0-9]+-)?LCUUsage$")
ALB_FAMILY="Load Balancer-Application"


class Pricing_Service:

    # 기본 fetch - 가격 파일 URL 의 JSON 을 가져온다 (타임아웃 30초)
    @staticmethod
    async def services_pricing_fetch(url:str) -> dict:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_SECONDS) as client:
            response=await client.get(url)
            response.raise_for_status()
            return response.json()


    # 가격 파일에서 조건에 맞는 첫 상품의 시간당 USD 단가 찾기 - 없거나 깨졌으면 None
    @staticmethod
    def services_pricing_find(data:dict, matches:Callable[[str, dict], bool], region:str, family:str|None=None) -> float | None:
        try:
            products=data["products"]
            on_demand=data["terms"]["OnDemand"]
            for sku, product in products.items():
                attributes=product.get("attributes") or {}
                if not matches(attributes.get("usagetype") or "", attributes):
                    continue
                if attributes.get("regionCode") not in (None, region):
                    continue
                if attributes.get("operatingSystem") not in (None, "Linux"):
                    continue
                if family is not None and product.get("productFamily") != family:
                    continue
                for offer in (on_demand.get(sku) or {}).values():
                    for dimension in (offer.get("priceDimensions") or {}).values():
                        price=float(dimension["pricePerUnit"]["USD"])
                        if price > 0:
                            return price
            return None
        except Exception:
            return None


    # 가격 파일 두 개(ECS·ELB)를 단가 표로 바꾸기 - 필요한 값(x86 vCPU·GB, ALB 시간당)이 하나라도 없으면 None
    @staticmethod
    def services_pricing_parse(ecs:dict, elb:dict, region:str) -> Price_Table | None:
        try:
            find=Pricing_Service.services_pricing_find
            vcpu=find(ecs, lambda usage, attrs: usage.endswith("Fargate-vCPU-Hours:perCPU"), region)
            gb=find(ecs, lambda usage, attrs: usage.endswith("Fargate-GB-Hours") and "ARM" not in usage and "Ephemeral" not in usage, region)
            arm_vcpu=find(ecs, lambda usage, attrs: usage.endswith("Fargate-ARM-vCPU-Hours:perCPU"), region)
            arm_gb=find(ecs, lambda usage, attrs: usage.endswith("Fargate-ARM-GB-Hours"), region)
            alb=find(elb, lambda usage, attrs: ALB_USAGE_PATTERN.match(usage) is not None, region, ALB_FAMILY)
            lcu=find(elb, lambda usage, attrs: LCU_USAGE_PATTERN.match(usage) is not None, region, ALB_FAMILY)
            if vcpu is None or gb is None or alb is None:
                return None
            basis_date=str(ecs["publicationDate"])[:10]
            datetime.strptime(basis_date, "%Y-%m-%d")
            return Price_Table(
                region=region, basis_date=basis_date,
                fargate_vcpu_hour=vcpu, fargate_gb_hour=gb,
                fargate_arm_vcpu_hour=arm_vcpu, fargate_arm_gb_hour=arm_gb,
                alb_hour=alb, lcu_hour=lcu,
            )
        except Exception:
            return None


    # 캐시 파일에서 (저장 시각, 단가 표) 읽기 - 없거나 깨졌으면 None
    @staticmethod
    def services_pricing_cache_read(region:str) -> tuple[datetime, Price_Table] | None:
        try:
            raw=json.loads((settings.cache_path / f"pricing-{region}.json").read_text(encoding="utf-8"))
            fetched_at=datetime.fromisoformat(raw["fetched_at"])
            if fetched_at.tzinfo is None:
                fetched_at=fetched_at.replace(tzinfo=timezone.utc)
            return fetched_at, Price_Table(**raw["table"])
        except Exception:
            return None


    # 캐시 파일에 단가 표와 저장 시각 쓰기 - 쓰기에 실패해도 표는 그대로 쓴다
    @staticmethod
    def services_pricing_cache_write(table:Price_Table, now:datetime) -> None:
        try:
            settings.cache_path.mkdir(parents=True, exist_ok=True)
            body={"fetched_at": now.isoformat(), "table": table.model_dump()}
            (settings.cache_path / f"pricing-{table.region}.json").write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
        except Exception:
            logger.warning("가격 캐시를 저장하지 못했습니다")


    # 단가 표 가져오기 - 캐시가 신선하면 그대로, 아니면 가격 파일을 읽어 갱신. 읽기 실패 시 낡은 캐시, 그것도 없으면 None
    @staticmethod
    async def services_pricing_table(region:str|None=None, fetch:Callable[[str], Awaitable[dict]]|None=None, now:datetime|None=None) -> Price_Table | None:
        region=region or settings.aws_region
        fetch=fetch or Pricing_Service.services_pricing_fetch
        now=now or datetime.now(timezone.utc)
        cached=Pricing_Service.services_pricing_cache_read(region)
        if cached is not None and now - cached[0] < timedelta(hours=settings.pricing_cache_hours):
            return cached[1]
        try:
            ecs=await fetch(PRICE_URL.format(service="AmazonECS", region=region))
            elb=await fetch(PRICE_URL.format(service="AWSELB", region=region))
            table=Pricing_Service.services_pricing_parse(ecs, elb, region)
        except Exception:
            logger.warning("가격 파일을 가져오지 못했습니다")
            table=None
        if table is None:
            return cached[1] if cached is not None else None
        Pricing_Service.services_pricing_cache_write(table, now)
        return table
