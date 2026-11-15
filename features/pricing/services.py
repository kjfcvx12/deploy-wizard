import json
import logging
import math
import re
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

import httpx

from shared.settings import settings

from features.pricing.scheme import Cost_Component, Cost_Estimate, Cost_Period, Price_Table, Spec_Option

# 가격 파일 읽기와 캐시 (기획 설계 5.1) - 파일은 인증 없는 AWS 공개 가격 파일
# 파싱 실패·누락은 예외가 아니라 None, 네트워크 실패도 낡은 캐시 또는 None 으로 돌려준다 (금액 없음)

logger=logging.getLogger(__name__)

PRICE_URL="https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{service}/current/{region}/index.json"
FETCH_TIMEOUT_SECONDS=30

# 리전 접두사(APN2, USE1, EUW1 ...)는 리전마다 달라 접미사로 고른다 - 접두사는 '영문 대문자 2~4자 + 숫자' 모양만 허용하고(접두사 없는 us-east-1 모양도 허용),
# Outposts-·TS-·Reserved 같은 변형 행은 이 모양이 아니라서 걸러진다
ALB_USAGE_PATTERN=re.compile(r"^(?:[A-Z]{2,4}\d-)?LoadBalancerUsage$")
LCU_USAGE_PATTERN=re.compile(r"^(?:[A-Z]{2,4}\d-)?LCUUsage$")
# 리전 이름 모양 (ap-northeast-2, us-east-1 ...) - 캐시 파일 이름과 URL 에 그대로 들어가므로 이 모양만 받는다
REGION_PATTERN=re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
ALB_FAMILY="Load Balancer-Application"
# 사양 프리셋 (CPU 단위, MiB, 라벨) - 기본 사양은 AWS 문서의 Express 기본값 256/512 (실제 배포에서는 아직 확인 전)
SPEC_PRESETS=[
    ("256", "512", "0.25 vCPU / 0.5 GB"),
    ("512", "1024", "0.5 vCPU / 1 GB"),
    ("1024", "2048", "1 vCPU / 2 GB"),
    ("2048", "4096", "2 vCPU / 4 GB"),
]
DEFAULT_CPU="256"
DEFAULT_MEMORY="512"
# 기간별 금액 계산에 쓰는 (이름, 시간) - 한 달은 730시간
PERIODS=[("1시간", 1), ("1일", 24), ("1주", 168), ("한 달", 730)]
# 자동 증설 기준 지표 (docs/aws-notes.md 의 scalingTarget.autoScalingMetric)
SCALING_METRICS=("AVERAGE_CPU", "AVERAGE_MEMORY", "REQUEST_COUNT_PER_TARGET")


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
                        if math.isfinite(price) and price > 0:
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
        region=settings.aws_region if region is None else region
        if REGION_PATTERN.match(region) is None:
            return None
        fetch=fetch or Pricing_Service.services_pricing_fetch
        now=now or datetime.now(timezone.utc)
        cached=Pricing_Service.services_pricing_cache_read(region)
        if cached is not None and timedelta(0) <= now - cached[0] < timedelta(hours=settings.pricing_cache_hours):
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


    # 사양 프리셋 4개 - Fargate 표준 작업 크기 중 안전한 조합만 (첫 실제 배포에서 Express 수용 여부 확인 전)
    @staticmethod
    def services_pricing_spec_options() -> list[Spec_Option]:
        return [Spec_Option(label=label, cpu=cpu, memory=memory, vcpu=int(cpu) / 1024, memory_gb=int(memory) / 1024) for cpu, memory, label in SPEC_PRESETS]


    # 사양이 프리셋 조합인지 확인 - 둘 다 비면 기본 사양이라 통과, 한쪽만 있거나 프리셋이 아니면 False
    @staticmethod
    def services_pricing_spec_valid(cpu:str|None, memory:str|None) -> bool:
        if cpu is None and memory is None:
            return True
        if cpu is None or memory is None:
            return False
        return any(cpu == preset_cpu and memory == preset_memory for preset_cpu, preset_memory, _ in SPEC_PRESETS)


    # 자동 증설 설정 검사 - 문제가 있으면 한국어 안내 문구, 없으면 None (cap 은 최대 작업 수 상한)
    @staticmethod
    def services_pricing_scaling_valid(min_tasks:int|None, max_tasks:int|None, metric:str|None, target:int|None, cap:int) -> str | None:
        values=(min_tasks, max_tasks, metric, target)
        if all(v is None for v in values):
            return None
        if any(v is None for v in values):
            return "증설 설정은 최소·최대·기준·목표값을 모두 정해야 합니다"
        if min_tasks < 1:
            return "최소 작업 수는 1 이상이어야 합니다"
        if min_tasks > max_tasks:
            return "최소 작업 수는 최대 작업 수보다 클 수 없습니다"
        if max_tasks > cap:
            return f"최대 작업 수는 {cap} 이하여야 합니다 (요금이 크게 늘지 않도록 정한 상한)"
        if metric not in SCALING_METRICS:
            return "증설 기준은 CPU 평균, 메모리 평균, 요청 수 중 하나여야 합니다"
        upper=100000 if metric == "REQUEST_COUNT_PER_TARGET" else 100
        if not 1 <= target <= upper:
            return f"증설 목표값은 1 이상 {upper} 이하여야 합니다"
        return None


    # 사양과 단가 표로 비용 추정 만들기 (순수 함수) - 사양이 None 이면 기본 사양(256/512), 프리셋이 아니면 ValueError
    @staticmethod
    def services_pricing_estimate(table:Price_Table, cpu:str|None=None, memory:str|None=None, planned_hours:float|None=None, max_tasks:int|None=None) -> Cost_Estimate:
        is_default=cpu is None and memory is None
        if is_default:
            cpu, memory=DEFAULT_CPU, DEFAULT_MEMORY
        if not Pricing_Service.services_pricing_spec_valid(cpu, memory):
            raise ValueError("지원하지 않는 사양입니다. 정해진 사양 중에서 골라 주세요")
        option=next(o for o in Pricing_Service.services_pricing_spec_options() if o.cpu == cpu and o.memory == memory)
        fargate=option.vcpu * table.fargate_vcpu_hour + option.memory_gb * table.fargate_gb_hour
        hourly=fargate + table.alb_hour
        arm_hourly=None
        arm_saving=None
        if table.fargate_arm_vcpu_hour is not None and table.fargate_arm_gb_hour is not None:
            arm_raw=option.vcpu * table.fargate_arm_vcpu_hour + option.memory_gb * table.fargate_arm_gb_hour + table.alb_hour
            arm_hourly=round(arm_raw, 4)
            arm_saving=round((hourly - arm_raw) / hourly * 100, 1)
        max_hourly=None
        max_monthly=None
        if max_tasks is not None:
            max_raw=max_tasks * fargate + table.alb_hour
            max_hourly=round(max_raw, 4)
            max_monthly=round(max_raw * PERIODS[-1][1], 2)
        assumptions=[]
        if is_default:
            assumptions.append("기본 사양(AWS 문서 기준 256 CPU 단위 / 512 MiB)으로 계산했습니다. 실제 배포에서 아직 확인하지 않은 값입니다")
        assumptions.append(f"금액은 AWS 가격 목록({table.basis_date} 기준)의 온디맨드 USD 추정치입니다")
        assumptions.append("서비스마다 ALB 가 하나씩 생긴다고 보고 계산한 값입니다 (공유 여부는 확인 전이라 가장 비싼 경우)")
        if max_tasks is not None:
            assumptions.append("최대치는 트래픽이 늘어 작업이 최대 수까지 계속 유지될 때의 금액입니다")
        return Cost_Estimate(
            basis_date=table.basis_date, region=table.region,
            cpu=option.cpu, memory=option.memory, spec_label=option.label, spec_is_default=is_default,
            components=[
                Cost_Component(name="Fargate (vCPU·메모리)", hourly_usd=round(fargate, 4), note=option.label),
                Cost_Component(name="ALB (고정 시간당)", hourly_usd=round(table.alb_hour, 4), note="트래픽에 따른 LCU 요금은 제외"),
            ],
            hourly_usd=round(hourly, 4),
            periods=[Cost_Period(label=label, hours=hours, usd=round(hourly * hours, 2)) for label, hours in PERIODS],
            planned_hours=planned_hours,
            planned_usd=None if planned_hours is None else round(hourly * planned_hours, 2),
            max_tasks=max_tasks, max_hourly_usd=max_hourly, max_monthly_usd=max_monthly,
            arm64_hourly_usd=arm_hourly, arm64_saving_percent=arm_saving,
            assumptions=assumptions,
            not_included=[
                "트래픽에 따른 LCU 요금 (ALB 사용량)",
                "데이터 전송 요금 (인터넷으로 나가는 트래픽)",
                "로그 저장·조회 요금 (CloudWatch Logs)",
                "ECR 이미지 저장 요금",
            ],
        )
