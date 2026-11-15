import asyncio
import json
import logging
import math
import re
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

import httpx

from shared.settings import settings
from shared.specs import SPEC_PAIRS, specs_pair_valid, specs_env_pair

from features.pricing.scheme import Cost_Component, Cost_Estimate, Cost_Period, Price_Table, Pricing_Plan, Spec_Option

# 가격 파일 읽기와 캐시 (기획 설계 5.1) - 파일은 인증 없는 AWS 공개 가격 파일
# 파싱 실패·누락은 예외가 아니라 None, 네트워크 실패도 낡은 캐시 또는 None 으로 돌려준다 (금액 없음)

logger=logging.getLogger(__name__)

PRICE_URL="https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{service}/current/{region}/index.json"
# 가격 파일은 인증 없는 공개 파일이라 오래 기다릴 이유가 없다 - 연결 5초·읽기 10초, 둘을 합친 한 번의 갱신은 20초까지만
FETCH_TIMEOUT=httpx.Timeout(10, connect=5)
REFRESH_DEADLINE_SECONDS=20
# 내려받는 크기 상한 - ECS 파일이 약 0.8MB 라 5MB 면 넉넉하다 (압축을 푼 뒤 크기로 센다)
MAX_DOWNLOAD_BYTES=5 * 1024 * 1024
# 갱신에 실패한 리전은 이 시간 동안 다시 가져오지 않는다 (낡은 캐시 또는 None 을 바로 돌려준다)
REFRESH_BACKOFF=timedelta(minutes=10)
# 리전별 마지막 갱신 실패 시각과 갱신 잠금 (서버 프로세스 안에서만 - 잠금은 만든 이벤트 루프에 묶여 있다)
REFRESH_FAILED_AT:dict[str, datetime]={}
REFRESH_LOCKS:dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Lock]]={}

# 리전 접두사(APN2, USE1, EUW1 ...)는 리전마다 달라 접미사로 고른다 - 접두사는 '영문 대문자 2~4자 + 숫자' 모양만 허용하고(접두사 없는 us-east-1 모양도 허용),
# Outposts-·TS-·Reserved 같은 변형 행은 이 모양이 아니라서 걸러진다
ALB_USAGE_PATTERN=re.compile(r"^(?:[A-Z]{2,4}\d-)?LoadBalancerUsage$")
LCU_USAGE_PATTERN=re.compile(r"^(?:[A-Z]{2,4}\d-)?LCUUsage$")
FARGATE_VCPU_PATTERN=re.compile(r"^(?:[A-Z]{2,4}\d-)?Fargate-vCPU-Hours:perCPU$")
FARGATE_GB_PATTERN=re.compile(r"^(?:[A-Z]{2,4}\d-)?Fargate-GB-Hours$")
FARGATE_ARM_VCPU_PATTERN=re.compile(r"^(?:[A-Z]{2,4}\d-)?Fargate-ARM-vCPU-Hours:perCPU$")
FARGATE_ARM_GB_PATTERN=re.compile(r"^(?:[A-Z]{2,4}\d-)?Fargate-ARM-GB-Hours$")
# 리전 이름 모양 (ap-northeast-2, us-east-1 ...) - 캐시 파일 이름과 URL 에 그대로 들어가므로 이 모양만 받는다
REGION_PATTERN=re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
ALB_FAMILY="Load Balancer-Application"
# 사양 프리셋 (CPU 단위, MiB, 라벨) - 기본 사양은 AWS 문서의 Express 기본값 256/512 (실제 배포에서는 아직 확인 전)
# 조합 목록은 shared/specs.py 의 SPEC_PAIRS 가 기준이고 여기서는 표시 이름만 붙인다
SPEC_LABELS={
    ("256", "512"): "0.25 vCPU / 0.5 GB",
    ("512", "1024"): "0.5 vCPU / 1 GB",
    ("1024", "2048"): "1 vCPU / 2 GB",
    ("2048", "4096"): "2 vCPU / 4 GB",
}
SPEC_PRESETS=[(cpu, memory, SPEC_LABELS[(cpu, memory)]) for cpu, memory in SPEC_PAIRS]
DEFAULT_CPU="256"
DEFAULT_MEMORY="512"
# 기간별 금액 계산에 쓰는 (이름, 시간) - 한 달은 730시간
PERIODS=[("1시간", 1), ("1일", 24), ("1주", 168), ("한 달", 730)]
# 사용 기간 선택지 (이름, 시간) - 시간이 None 이면 계속 켜 둠
PLANS=[("4시간", 4), ("하루", 24), ("일주일", 168), ("계속", None)]
# 사용 시간 상한 - 1년
MAX_PLANNED_HOURS=8760
# 자동 증설 기준 지표 (docs/aws-notes.md 의 scalingTarget.autoScalingMetric)
SCALING_METRICS=("AVERAGE_CPU", "AVERAGE_MEMORY", "REQUEST_COUNT_PER_TARGET")


class Pricing_Service:

    # 기본 fetch - 가격 파일 URL 의 JSON 을 가져온다 (연결 5초·읽기 10초, 크기 상한을 넘으면 중간에 끊고 실패)
    @staticmethod
    async def services_pricing_fetch(url:str) -> dict:
        body=bytearray()

        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()

                length=response.headers.get("content-length")
                if length is not None and length.isdigit() and int(length) > MAX_DOWNLOAD_BYTES:
                    raise ValueError("가격 파일이 너무 큽니다")

                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_DOWNLOAD_BYTES:
                        raise ValueError("가격 파일이 너무 큽니다")

        return json.loads(bytes(body))


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
            vcpu=find(ecs, lambda usage, attrs: FARGATE_VCPU_PATTERN.fullmatch(usage) is not None, region)
            gb=find(ecs, lambda usage, attrs: FARGATE_GB_PATTERN.fullmatch(usage) is not None, region)
            arm_vcpu=find(ecs, lambda usage, attrs: FARGATE_ARM_VCPU_PATTERN.fullmatch(usage) is not None, region)
            arm_gb=find(ecs, lambda usage, attrs: FARGATE_ARM_GB_PATTERN.fullmatch(usage) is not None, region)
            alb=find(elb, lambda usage, attrs: ALB_USAGE_PATTERN.fullmatch(usage) is not None, region, ALB_FAMILY)
            lcu=find(elb, lambda usage, attrs: LCU_USAGE_PATTERN.fullmatch(usage) is not None, region, ALB_FAMILY)
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


    # 캐시 파일에서 (저장 시각, 단가 표) 읽기 - 없거나 깨졌으면 None. 리전이 다르거나 단가가 유한한 양수가 아니어도 깨진 것으로 본다
    @staticmethod
    def services_pricing_cache_read(region:str) -> tuple[datetime, Price_Table] | None:
        try:
            raw=json.loads((settings.cache_path / f"pricing-{region}.json").read_text(encoding="utf-8"))
            fetched_at=datetime.fromisoformat(raw["fetched_at"])
            if fetched_at.tzinfo is None:
                fetched_at=fetched_at.replace(tzinfo=timezone.utc)
            table=Price_Table(**raw["table"])
            if table.region != region:
                return None
            prices=[table.fargate_vcpu_hour, table.fargate_gb_hour, table.alb_hour]
            prices+=[price for price in (table.fargate_arm_vcpu_hour, table.fargate_arm_gb_hour, table.lcu_hour) if price is not None]
            if not all(math.isfinite(price) and price > 0 for price in prices):
                return None
            return fetched_at, table
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


    # 리전별 갱신 잠금 - 같은 리전의 첫 호출들이 가격 파일을 한 번만 가져오게 한다 (이벤트 루프가 바뀌면 새로 만든다)
    @staticmethod
    def services_pricing_lock(region:str) -> asyncio.Lock:
        loop=asyncio.get_running_loop()
        held=REFRESH_LOCKS.get(region)

        if held is None or held[0] is not loop:
            held=(loop, asyncio.Lock())
            REFRESH_LOCKS[region]=held

        return held[1]


    # 갱신 실패 뒤 쉬는 중인지 - 마지막 실패로부터 10분이 안 지났으면 True
    @staticmethod
    def services_pricing_backoff_active(region:str, now:datetime) -> bool:
        failed_at=REFRESH_FAILED_AT.get(region)
        return failed_at is not None and timedelta(0) <= now - failed_at < REFRESH_BACKOFF


    # 가격 파일 두 개(ECS·ELB)를 동시에 가져와 단가 표로 바꾸기 - 실패하면 예외 (전체 20초 제한)
    @staticmethod
    async def services_pricing_refresh(region:str, fetch:Callable[[str], Awaitable[dict]]) -> Price_Table | None:
        results=await asyncio.wait_for(
            asyncio.gather(fetch(PRICE_URL.format(service="AmazonECS", region=region)),
                           fetch(PRICE_URL.format(service="AWSELB", region=region)), return_exceptions=True),
            timeout=REFRESH_DEADLINE_SECONDS)

        failed=[result for result in results if isinstance(result, BaseException)]
        if failed:
            raise RuntimeError(type(failed[0]).__name__)

        return Pricing_Service.services_pricing_parse(results[0], results[1], region)


    # 단가 표 가져오기 - 캐시가 신선하면 그대로, 아니면 가격 파일을 읽어 갱신. 읽기 실패 시 낡은 캐시, 그것도 없으면 None
    # 실패한 리전은 10분 동안 다시 가져오지 않고(낡은 캐시 또는 None), 같은 리전의 동시 호출은 한 번만 가져온다. 어떤 경우에도 예외를 내보내지 않는다
    @staticmethod
    async def services_pricing_table(region:str|None=None, fetch:Callable[[str], Awaitable[dict]]|None=None, now:datetime|None=None) -> Price_Table | None:
        region=settings.aws_region if region is None else region
        if not isinstance(region, str) or REGION_PATTERN.fullmatch(region) is None:
            return None
        fetch=fetch or Pricing_Service.services_pricing_fetch
        now=now or datetime.now(timezone.utc)
        if now.tzinfo is None:
            now=now.replace(tzinfo=timezone.utc)
        ttl=timedelta(hours=settings.pricing_cache_hours)

        cached=Pricing_Service.services_pricing_cache_read(region)
        if cached is not None and timedelta(0) <= now - cached[0] < ttl:
            return cached[1]
        if Pricing_Service.services_pricing_backoff_active(region, now):
            return cached[1] if cached is not None else None

        async with Pricing_Service.services_pricing_lock(region):
            # 기다리는 사이 다른 호출이 이미 갱신했거나 실패했을 수 있다
            cached=Pricing_Service.services_pricing_cache_read(region)
            if cached is not None and timedelta(0) <= now - cached[0] < ttl:
                return cached[1]
            if Pricing_Service.services_pricing_backoff_active(region, now):
                return cached[1] if cached is not None else None

            try:
                table=await Pricing_Service.services_pricing_refresh(region, fetch)
            except Exception as e:
                logger.warning("가격 파일을 가져오지 못했습니다 (%s)", type(e).__name__)
                table=None

            if table is None:
                REFRESH_FAILED_AT[region]=now
                return cached[1] if cached is not None else None

            REFRESH_FAILED_AT.pop(region, None)
            Pricing_Service.services_pricing_cache_write(table, now)
            return table


    # 사양 프리셋 4개 - Fargate 표준 작업 크기 중 안전한 조합만 (첫 실제 배포에서 Express 수용 여부 확인 전)
    @staticmethod
    def services_pricing_spec_options() -> list[Spec_Option]:
        return [Spec_Option(label=label, cpu=cpu, memory=memory, vcpu=int(cpu) / 1024, memory_gb=int(memory) / 1024) for cpu, memory, label in SPEC_PRESETS]


    # 사양을 정하지 않았을 때의 기본 사양 - (cpu, memory, .env 에서 왔는지). .env 의 ECS_CPU·ECS_MEMORY 가 둘 다 있고 프리셋 조합이면 그 값, 아니면 AWS 문서의 256/512
    @staticmethod
    def services_pricing_default_spec() -> tuple[str, str, bool]:
        pair=specs_env_pair()
        if pair is not None:
            return pair[0], pair[1], True
        return DEFAULT_CPU, DEFAULT_MEMORY, False


    # 사양이 프리셋 조합인지 확인 - 둘 다 비면 기본 사양이라 통과, 한쪽만 있거나 프리셋이 아니면 False
    @staticmethod
    def services_pricing_spec_valid(cpu:str|None, memory:str|None) -> bool:
        if cpu is None and memory is None:
            return True
        if cpu is None or memory is None:
            return False
        return specs_pair_valid(cpu, memory)


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


    # 사양과 단가 표로 비용 추정 만들기 (순수 함수) - 사양이 None 이면 기본 사양(.env 의 유효한 쌍, 없으면 256/512), 프리셋이 아니면 ValueError
    @staticmethod
    def services_pricing_estimate(table:Price_Table, cpu:str|None=None, memory:str|None=None, planned_hours:float|None=None, max_tasks:int|None=None) -> Cost_Estimate:
        is_default=cpu is None and memory is None
        from_env=False
        if is_default:
            cpu, memory, from_env=Pricing_Service.services_pricing_default_spec()
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
        if is_default and from_env:
            assumptions.append(f"사양을 고르지 않으면 이 서버의 .env 설정(ECS_CPU/ECS_MEMORY)인 {option.label}로 만들어져 그 사양으로 계산했습니다")
        elif is_default:
            assumptions.append("기본 사양(AWS 문서 기준 256 CPU 단위 / 512 MiB)으로 계산했습니다. 실제 배포에서 아직 확인하지 않은 값입니다")
        assumptions.append(f"금액은 AWS 가격 목록({table.basis_date} 기준)의 온디맨드 USD 추정치입니다")
        assumptions.append("서비스마다 ALB 가 하나씩 생긴다고 보고 계산한 값입니다 (공유 여부는 확인 전이라 가장 비싼 경우)")
        if max_tasks is not None:
            assumptions.append("최대치는 트래픽이 늘어 작업이 최대 수까지 계속 유지될 때의 금액입니다")
        else:
            assumptions.append("증설을 고르지 않으면 AWS 기본 오토스케일이 작업 수를 늘릴 수 있습니다 (최대 수는 확인 전) — 작업 1개 기준으로 계산했습니다")
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


    # 사용 기간 선택지 - 마지막 "계속"은 기간을 정하지 않은 경우 (hours 없음)
    @staticmethod
    def services_pricing_plans() -> list[Pricing_Plan]:
        return [Pricing_Plan(label=label, hours=hours) for label, hours in PLANS]


    # 비용 추정 요청 값 검사 - 문제가 있으면 한국어 안내 문구, 없으면 None (추정 함수는 범위를 검사하지 않는다)
    @staticmethod
    def services_pricing_request_error(cpu:str|None, memory:str|None, planned_hours:float|None, max_tasks:int|None, cap:int) -> str | None:
        if not Pricing_Service.services_pricing_spec_valid(cpu, memory):
            return "지원하지 않는 사양입니다. CPU와 메모리를 정해진 사양 중에서 함께 골라 주세요"
        if planned_hours is not None:
            if isinstance(planned_hours, float) and not math.isfinite(planned_hours):
                return "사용 시간이 올바른 숫자가 아닙니다"
            if not 0 < planned_hours <= MAX_PLANNED_HOURS:
                return f"사용 시간은 0보다 크고 {MAX_PLANNED_HOURS}시간(1년) 이하여야 합니다"
        if max_tasks is not None and not 1 <= max_tasks <= cap:
            return f"최대 작업 수는 1 이상 {cap} 이하여야 합니다 (요금이 크게 늘지 않도록 정한 상한)"
        return None
