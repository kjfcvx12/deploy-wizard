# 배포 전 비용 확인 — 백엔드·MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 분석 결과에 AWS 공개 가격 파일 기반 비용 추정을 넣고, 사양(CPU·메모리)·자동 증설 설정·예정 사용 시간을 배포에 저장·적용하며, 예정 시간을 넘기면 알림만 보내고, MCP 미리보기에도 같은 비용을 보여 준다.

**Architecture:** 새 기능 폴더 `features/pricing/`(가격 파일 읽기·캐시·계산). `advice`·`deploys`·MCP는 `pricing`의 services 만 부른다. 배포 옵션은 `deploys` 열 9개(`cpu`, `memory`, `min_tasks`, `max_tasks`, `scale_metric`, `scale_target`, `planned_hours`, `running_since`, `plan_notified_at`)로 저장하고, 헬스 감시 루프가 예정 시간 초과를 찾아 알림을 한 번 보낸다.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0(async), httpx, pytest(`httpx.MockTransport`·`ASGITransport`).

**Spec:** `docs/superpowers/specs/2026-11-16-cost-confirm-design.md` (실행자는 둘 다 읽는다)

## Global Constraints

- 브랜치 `feat/cost-backend` (`test`에서). 끝나면 `test`에 `--no-ff` 로컬 병합. push·`main`은 소유자의 명시적 허락 후에만.
- **가격 숫자를 코드에 상수로 적지 않는다.** 가격은 공개 가격 파일(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<서비스>/current/<region>/index.json`, 서비스 `AmazonECS`·`AWSELB`)에서만 읽는다. 테스트의 가짜 가격은 테스트 안에만 둔다.
- 새 AWS API 호출 금지(Hard rule 2): 이 계획은 Express `create_express_gateway_service`에 **이미 문서화된** `cpu`·`memory`(문자열: CPU 단위 / MiB) 인자만 더 넘긴다 (botocore 1.43.126 서비스 모델로 확인됨, `docs/aws-notes.md` 표). 자동 멈춤·삭제 없음(Hard rule 3).
- 자동 증설은 Express `scalingTarget{minTaskCount,maxTaskCount,autoScalingMetric,autoScalingTargetValue}`만 쓴다 (botocore 1.43.126 모델·`docs/aws-notes.md`로 확인된 구조). 지표는 `AVERAGE_CPU`|`AVERAGE_MEMORY`|`REQUEST_COUNT_PER_TARGET`. 우리 상한 `settings.max_tasks_cap`(`MAX_TASKS_CAP`, 기본 4). 값이 모두 비어 있으면 `scalingTarget`을 보내지 않는다.
- 사양은 프리셋만: CPU 단위 / MiB = `256/512`, `512/1024`, `1024/2048`, `2048/4096`. 기본(미선택)은 AWS 기본에 맡기고 비용은 `256/512`로 계산하며 "AWS 문서 기준 기본값, 실제 확인 전"을 가정 목록에 넣는다.
- 금액은 USD. 시간당은 소수 4자리, 기간 금액은 소수 2자리로 반올림 (계산은 반올림 전 값으로).
- 이름: 클래스 Pascal_Snake(`Pricing_Service`), 함수 `<계층>_<도메인>_<동작>`(`services_pricing_estimate`), 함수 위 한 줄 한국어 주석, docstring 없음, 기존 `=` 공백 유지, 사용자에게 보이는 문자열 한국어, 파일은 기존 파일의 줄바꿈(CRLF)을 보존한다. 기능 간 호출은 services 로만, `shared/*` → `features/*` 금지.
- API 변경은 같은 Task 안에서 `docs/api-spec.md`를 고친다. 상태값은 바뀌지 않는다.
- 테스트는 AWS·실제 네트워크 없이 `pytest`로(가격 파일은 가짜 JSON·`MockTransport`). pytest는 한 번에 하나만, 전체 실행은 마지막 Task에서 한 번.
- 소유자 지시: 질문은 `AskUserQuestion`으로만, 실제 AWS 비용이 드는 실행 전에는 반드시 다시 묻는다.

## Review Focus

1. 같은 `usagetype`을 가진 NLB·Gateway LB 가격이 ALB 로 잘못 뽑히지 않는가 (상품군 필터), Windows·ARM 행이 x86 로 섞이지 않는가 → Task 1.
2. 가격 파일을 못 받을 때(네트워크 오류·깨진 JSON·상품 누락) 예외가 아니라 "금액 없음"이 되고, 낡은 캐시는 기준일과 함께 쓰이는가 → Task 1, 3.
3. 프리셋 밖 `cpu`/`memory`, 한쪽만 보낸 경우, `planned_hours`가 0·음수·`NaN`·매우 큼 → 400 → Task 2, 4.
4. 예정 시간 알림이 정확히 한 번만 나가고(재시작·재감시 반복에도), 멈춤 후 다시 켜면 처음부터 다시 세는가 → Task 5.
5. MCP: 미리보기와 다른 사양·계획으로 확인 토큰이 통하지 않는가 → Task 6.
6. 증설 설정: `min>max`, `max>상한`, 지표 오타, 목표값 범위 밖, 일부 값만 보낸 경우 → 400 / 비어 있으면 `scalingTarget`을 보내지 않는가 / 최대 금액이 `max_tasks`로 곱해지는가 → Task 2, 4.
7. 기존 배포 행(새 열이 `NULL`)과 기존 DB(`ENSURE_COLUMNS`)에서 아무것도 깨지지 않는가 → Task 4.

---

### Task 1: 가격 표 읽기와 캐시

**Files:**
- Create: `features/pricing/__init__.py`, `features/pricing/scheme.py`, `features/pricing/services.py`
- Modify: `shared/settings.py` (`pricing_cache_hours:int=Field(24, alias="PRICING_CACHE_HOURS")`)
- Test: `tests/test_pricing.py`

**Interfaces:**
- Produces (`scheme.py`): `Price_Table(BaseModel)`: `region:str`, `basis_date:str`, `fargate_vcpu_hour:float`, `fargate_gb_hour:float`, `fargate_arm_vcpu_hour:float|None`, `fargate_arm_gb_hour:float|None`, `alb_hour:float`, `lcu_hour:float|None`.
- Produces (`services.py`, `class Pricing_Service`, `@staticmethod`):
  - `services_pricing_parse(ecs:dict, elb:dict, region:str) -> Price_Table | None` — 필요한 값(x86 vCPU·GB, ALB 시간당)이 하나라도 없으면 `None`. `basis_date`는 ECS 파일 `publicationDate`의 날짜(`YYYY-MM-DD`).
  - `async services_pricing_table(region:str|None=None, fetch:Callable[[str], Awaitable[dict]]|None=None, now:datetime|None=None) -> Price_Table | None` — `region` 기본은 `settings.aws_region`. `fetch` 기본은 httpx 로 URL 의 JSON 을 가져오는 함수(타임아웃 30초).

- [ ] **Step 1: 실패하는 테스트.** 가짜 가격 JSON(테스트 안에서 만든 최소 구조: `products{sku:{productFamily, attributes{usagetype, regionCode, operatingSystem}}}`, `terms{OnDemand{sku:{offer:{priceDimensions:{r:{unit, pricePerUnit{USD}}}}}}}`, `publicationDate`)으로:
  - `test_pricing_parse_picks_x86_fargate_and_alb` — x86 vCPU `0.04656`·GB `0.00511`(`usagetype` 접미사 `Fargate-vCPU-Hours:perCPU`, `Fargate-GB-Hours`), ARM(`Fargate-ARM-vCPU-Hours:perCPU`, `Fargate-ARM-GB-Hours`), Windows 행, ephemeral 행이 섞여 있어도 x86 값만 `fargate_vcpu_hour/_gb_hour`, ARM 값은 `fargate_arm_*`. `basis_date == "2026-11-11"`.
  - `test_pricing_parse_alb_only_application_family` — 같은 `…LoadBalancerUsage` 접미사에 상품군 `Load Balancer-Application`(0.0225), `Load Balancer-Network`(0.0225 대신 0.0999로 둔다), `Load Balancer-Gateway`(0.0125)가 있어도 `alb_hour == 0.0225`, `lcu_hour`는 Application 의 `…LCUUsage`.
  - `test_pricing_parse_missing_returns_none` — ECS 파일에 vCPU 단가가 없으면 `None`; 깨진 구조(`{}`)도 `None` (예외 없음).
  - `test_pricing_table_fetches_and_caches` — 첫 호출은 `fetch`를 ECS·ELB 두 번 부르고 `cache_path/"pricing-ap-northeast-2.json"`을 만든다. 24시간 안의 두 번째 호출은 `fetch` 0번.
  - `test_pricing_table_stale_cache_on_fetch_failure` — 캐시가 25시간 지났고 `fetch`가 예외 → 낡은 캐시의 표(`basis_date` 그대로)를 돌려준다. 캐시도 없고 `fetch` 실패 → `None`.
  - (경로는 `monkeypatch.setattr(settings, "cache_dir", str(tmp_path))`로 임시 폴더.)
- [ ] **Step 2:** `.venv/Scripts/python.exe -m pytest tests/test_pricing.py -q` → 실패(모듈 없음).
- [ ] **Step 3:** 구현. 값 선택은 `usagetype.endswith(접미사)` + `attributes.regionCode == region`(있을 때) + OS 가 있으면 `Linux`, 상품군은 `product["productFamily"]`. 요금은 `terms.OnDemand` 의 첫 `priceDimensions` USD. 캐시 파일에는 `fetched_at`(ISO)과 `Price_Table` 을 저장.
- [ ] **Step 4:** 같은 명령 → 통과.
- [ ] **Step 5:** 커밋 `feat(pricing): 가격 파일 읽기와 캐시`.

### Task 2: 사양 프리셋과 비용 추정 (순수 함수)

**Files:**
- Modify: `features/pricing/scheme.py`, `features/pricing/services.py`
- Test: `tests/test_pricing.py`

**Interfaces:**
- Consumes: Task 1 `Price_Table`.
- Produces (`scheme.py`): `Spec_Option`(`label:str`, `cpu:str`, `memory:str`, `vcpu:float`, `memory_gb:float`), `Cost_Component`(`name:str`, `hourly_usd:float`, `note:str|None=None`), `Cost_Period`(`label:str`, `hours:float`, `usd:float`), `Cost_Estimate`(`basis_date:str`, `region:str`, `currency:str="USD"`, `cpu:str`, `memory:str`, `spec_label:str`, `spec_is_default:bool`, `components:list[Cost_Component]`, `hourly_usd:float`, `periods:list[Cost_Period]`, `planned_hours:float|None`, `planned_usd:float|None`, `max_tasks:int|None`, `max_hourly_usd:float|None`, `max_monthly_usd:float|None`, `arm64_hourly_usd:float|None`, `arm64_saving_percent:float|None`, `assumptions:list[str]`, `not_included:list[str]`).
- Produces (`Pricing_Service`):
  - `services_pricing_spec_options() -> list[Spec_Option]` — 프리셋 4개 (`256/512` "0.25 vCPU / 0.5 GB", `512/1024` "0.5 vCPU / 1 GB", `1024/2048` "1 vCPU / 2 GB", `2048/4096` "2 vCPU / 4 GB").
  - `services_pricing_scaling_valid(min_tasks:int|None, max_tasks:int|None, metric:str|None, target:int|None, cap:int) -> str|None` — 오류 문구 또는 `None`. 모두 `None`이면 통과, 일부만 있으면 "증설 설정은 최소·최대·기준·목표값을 모두 정해야 합니다", `1<=min<=max<=cap`, 지표는 셋 중 하나, 목표값은 CPU·메모리 기준 1~100, 요청 수 기준 1~100000.
  - `services_pricing_spec_valid(cpu:str|None, memory:str|None) -> bool` — 둘 다 None 이면 True, 한쪽만이면 False, 둘 다 있으면 프리셋 조합일 때만 True.
  - `services_pricing_estimate(table:Price_Table, cpu:str|None=None, memory:str|None=None, planned_hours:float|None=None, max_tasks:int|None=None) -> Cost_Estimate` — 사양이 None 이면 `256/512`와 `spec_is_default=True`. 메모리 GB = MiB/1024. 구성 요소 2개: `Fargate (vCPU·메모리)`, `ALB (고정 시간당)`. 기간: `1시간`(1), `1일`(24), `1주`(168), `한 달`(730). 프리셋이 아닌 값은 `ValueError`.

- [ ] **Step 1: 실패하는 테스트** (표는 테스트 안의 `Price_Table(region="ap-northeast-2", basis_date="2026-11-11", fargate_vcpu_hour=0.04656, fargate_gb_hour=0.00511, fargate_arm_vcpu_hour=0.03725, fargate_arm_gb_hour=0.00403, alb_hour=0.0225, lcu_hour=0.008)`):
  - `test_pricing_spec_options_and_valid` — 4개, 라벨 위 값 그대로. `valid(None,None)`, `valid("256","512")`, `valid("512","1024")` True; `valid("256",None)`, `valid("256","2048")`(프리셋 아님), `valid("300","512")` False.
  - `test_pricing_estimate_default_spec` — 기본: `hourly_usd == 0.0367` (0.25×0.04656 + 0.5×0.00511 + 0.0225 = 0.03669), `spec_is_default` True, 구성 요소 합 = 시간당, 기간 `한 달` usd `26.79`, `1일` usd `0.88`, `assumptions`에 `기본 사양` 문구, `not_included`에 `LCU`·`데이터 전송`·`로그`·`ECR` 가 각각 들어 있다.
  - `test_pricing_estimate_1024_2048` — `("1024","2048")` → `hourly_usd == 0.0793`, `spec_label == "1 vCPU / 2 GB"`, `spec_is_default` False.
  - `test_pricing_estimate_planned_hours` — `planned_hours=8` + 기본 사양 → `planned_usd == 0.29`; `None`이면 `planned_usd is None`.
  - `test_pricing_estimate_max_tasks` — 기본 사양 `max_tasks=4` → `max_hourly_usd == round(4*0.01419+0.0225, 4)`(=0.0793), `max_monthly_usd == round((4*0.01419+0.0225)*730, 2)`; `max_tasks=None`이면 둘 다 `None`; `max_tasks=1`이면 시간당 합계와 같다.
  - `test_pricing_scaling_valid` — `services_pricing_scaling_valid(min_tasks, max_tasks, metric, target, cap)`가 모두 비면 `None`, `(1,3,"AVERAGE_CPU",60,4)` `None`, 일부만·`min>max`·`max>cap`·지표 `FOO`·CPU 목표 0 또는 101·요청 수 목표 0 은 한국어 문자열.
  - `test_pricing_estimate_arm64_comparison` — 기본 사양: `arm64_hourly_usd == 0.0338`, `arm64_saving_percent == 7.8`; ARM 단가가 없는 표에서는 둘 다 `None`.
  - `test_pricing_estimate_rejects_non_preset` — `("300","512")` → `ValueError`.
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현(소수 반올림은 위 Global Constraints). **Step 4:** 통과. **Step 5:** 커밋 `feat(pricing): 사양 프리셋과 비용 추정`.

### Task 3: 가격 API와 분석 비용 연결

**Files:**
- Create: `features/pricing/router.py`
- Modify: `main.py`(라우터 등록), `features/advice/scheme.py`(`Advice_Cost` 확장), `features/advice/services.py`(분석 끝에서 비용 채우기), `docs/api-spec.md`
- Test: `tests/test_pricing.py`(API), `tests/test_advice.py`(없으면 기존 advice 테스트 파일에 추가 — 파일 위치를 찾아 따른다)

**Interfaces:**
- Consumes: `Pricing_Service.services_pricing_table/estimate/spec_options/spec_valid`.
- Produces:
  - `GET /api/pricing/options` → `{"specs": [Spec_Option...], "plans": [{"label":"4시간","hours":4},{"label":"하루","hours":24},{"label":"일주일","hours":168},{"label":"계속","hours":null}]}`.
  - `POST /api/pricing/estimate` body `Estimate_Request`(`cpu:str|None`, `memory:str|None`, `planned_hours:float|None`, `max_tasks:int|None`) → `Cost_Estimate`. 프리셋 밖·한쪽만·`planned_hours`가 `<=0` 또는 `>8760`, `max_tasks`가 `<1` 또는 `>settings.max_tasks_cap`이면 400(한국어). 가격 표를 못 얻으면 503 `"가격 정보를 가져오지 못했습니다. 잠시 뒤 다시 시도하세요"`.
  - `Advice_Cost`(기존 `monthly_min/max`, `currency`, `basis_date`, `note` 유지)에 선택 필드 추가: `hourly_usd:float|None`, `components:list[dict]`(= `[{"name","hourly_usd","note"}]`, 기본 `[]`), `not_included:list[str]`(기본 `[]`), `arm64_hourly_usd:float|None`, `spec_label:str|None`, `spec_is_default:bool|None`.
  - 분석(`services_advice_analyze`)은 응답 직전에 기본 사양 추정을 구해 `monthly_min = monthly_max = 한 달 usd`, 나머지 필드를 채운다. 가격 표가 `None`이면 지금처럼 숫자 None·필드 기본값.

- [ ] **Step 1: 실패하는 테스트**
  - `test_pricing_options_endpoint` — 200, `specs` 4개, `plans` 4개(마지막 `hours is None`).
  - `test_pricing_estimate_endpoint_ok` — `Pricing_Service.services_pricing_table`를 가짜 표를 돌려주게 패치 → `{"cpu":"1024","memory":"2048","planned_hours":24}` → 200, `hourly_usd == 0.0793`, `planned_usd`는 24시간 금액.
  - `test_pricing_estimate_endpoint_bad_input` — 프리셋 밖(400), 한쪽만(400), `planned_hours` 0/-1/9000(400, 422가 아니라 400으로 통일할 수 없으면 기존 앱의 검증 오류 관례를 따른다: **어느 쪽이든 4xx이고 `detail`이 한국어**를 단언).
  - `test_pricing_estimate_endpoint_503_without_prices` — 표가 `None` → 503.
  - `test_advice_cost_filled_from_prices` — 분석 결과의 `cost.hourly_usd == 0.0367`, `cost.monthly_min == 26.79`, `components` 2개, `not_included`에 `LCU`; 가격 표 `None`이면 `monthly_min is None`.
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현 + `docs/api-spec.md`에 두 엔드포인트와 `Advice_Cost` 새 필드를 기존 표 형식으로 추가. **Step 4:** 통과. **Step 5:** 커밋 `feat(pricing): 가격 API와 분석 비용`.

### Task 4: 배포 옵션 저장과 사양 적용

**Files:**
- Modify: `shared/settings.py`(`max_tasks_cap:int=Field(4, alias="MAX_TASKS_CAP")`), `features/deploys/models.py`(열 9개), `shared/database.py`(`ENSURE_COLUMNS["deploys"]`에 9개 추가), `features/deploys/scheme.py`(`Deploy_Create`·`Deploy_In_DB`·`Deploy_Settings_Update`), `features/deploys/services.py`(생성 검증, 설정 변경, running_since 정리), `features/deploys/pipeline.py`(Express 생성에 사양 전달, `running_since` 세팅), `features/express/services.py`(`cpu`·`memory` 인자), `docs/api-spec.md`
- Test: `tests/test_deploys_api.py`, `tests/test_pipeline.py`, `tests/test_shared.py`(Express), 필요하면 `tests/test_database*.py`

**Interfaces:**
- Consumes: `Pricing_Service.services_pricing_spec_valid(cpu, memory) -> bool`.
- Produces:
  - 열(모두 nullable): `cpu:str(10)`, `memory:str(10)`, `min_tasks:int`, `max_tasks:int`, `scale_metric:str(30)`, `scale_target:int`, `planned_hours:float`, `running_since:datetime`, `plan_notified_at:datetime`. `Deploy_In_DB`/`Deploy_Read`에 `cpu`, `memory`, `min_tasks`, `max_tasks`, `scale_metric`, `scale_target`, `planned_hours`, `running_since`, `plan_notified_at`.
  - `Deploy_Create`에 선택 `cpu`, `memory`, `min_tasks`, `max_tasks`, `scale_metric`, `scale_target`, `planned_hours`. 증설 값은 `Pricing_Service.services_pricing_scaling_valid(..., settings.max_tasks_cap)`로 검증해 오류 문구가 있으면 400. 생성 시 프리셋 검증(`spec_valid`)과 `0 < planned_hours <= 8760`을 확인하고 위반 시 400 한국어(`"사양이 올바르지 않습니다 ..."`, `"예정 사용 시간은 ... "`).
  - `Deploy_Settings_Update`에 `planned_hours:float|None`. 보낸 항목만 바뀌는 기존 방식을 따르고, **`null`을 보내면 계획을 지운다**. 값이 바뀌면 `plan_notified_at`을 비운다(알림 재무장). 같은 검증.
  - `Express_Service.services_express_create(..., cpu:str|None=None, memory:str|None=None, scaling:dict|None=None, ...)` — 값이 있으면 `params["cpu"]`·`params["memory"]`로 보내고, `scaling`(`{"minTaskCount","maxTaskCount","autoScalingMetric","autoScalingTargetValue"}`)이 있으면 `params["scalingTarget"]`로 보낸다 (없으면 키 자체를 보내지 않는다). 우선순위: 인자 → `settings.ecs_cpu/ecs_memory` → 보내지 않음.
  - 파이프라인은 `deploy.cpu`·`deploy.memory`와, 증설 값 4개가 모두 있으면 `scaling` dict 를 `services_express_create`에 넘긴다. `running` 으로 바꿀 때마다 `running_since=지금`, `plan_notified_at=None`으로 함께 저장하고, 멈춤·삭제·실패로 바뀔 때는 `running_since=None`.

- [ ] **Step 1: 실패하는 테스트**
  - `test_deploy_create_stores_spec_and_plan` — `{"repo_url", "cpu":"512","memory":"1024","planned_hours":4}` → 201, 응답에 그대로.
  - `test_deploy_create_rejects_bad_spec_and_plan` — `cpu`만 / `("300","512")` / `planned_hours` 0, -3, 9000 → 각각 400(또는 앱 관례의 4xx)이며 한국어 `detail`, 배포가 생기지 않는다.
  - `test_deploy_create_without_options_unchanged` — 옵션 없이 만들면 새 필드가 모두 `null`.
  - `test_deploy_settings_planned_hours` — `PATCH {"planned_hours": 6}` → 응답에 6; `{"planned_hours": null}` → `null`; 값이 바뀌면 `plan_notified_at`이 `null`로(미리 값을 넣어 두고 확인); 0 → 4xx.
  - `test_deploy_create_scaling_validation` — 유효(`1,3,"AVERAGE_CPU",60`) 201 저장; `min>max`, `max=9`(상한 4), 지표 `FOO`, 목표값 0/101(CPU), 일부만 → 4xx 한국어; 아무것도 없으면 통과.
  - `test_express_create_scaling_target` — `scaling` 이 있으면 가짜 ECS `params["scalingTarget"]`가 그 dict, 없으면 `scalingTarget` 키가 없다.
  - `test_express_create_passes_cpu_memory` — 가짜 ECS 클라이언트가 받은 `params`에 `cpu="512"`, `memory="1024"`; 인자가 없고 `settings.ecs_cpu="256"`이면 그 값; 둘 다 없으면 키가 없다.
  - `test_pipeline_passes_spec_and_sets_running_since` — 가짜 Express 로 파이프라인을 돌려 `services_express_create`가 받은 `cpu/memory`가 배포 값이고, 끝난 배포의 `running_since`가 채워진다(기존 `tests/test_pipeline.py`의 가짜 구성 방식을 따른다).
  - `test_stop_clears_running_since` — `running` 배포를 멈추면 `running_since`가 `None`.
  - `test_ensure_columns_adds_new_deploy_columns` — 옛 스키마(새 열 없는 `deploys` 표)에서 `ensure_columns`가 9개 열을 추가한다 (기존 `ensure_columns` 테스트 방식을 따른다).
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현 + `docs/api-spec.md`(`Deploy_Read`·생성 본문·설정 변경). **Step 4:** 통과. **Step 5:** 커밋 `feat(deploys): 사양과 예정 사용 시간 저장·적용`.

### Task 5: 예정 시간 초과 알림 (알림만)

**Files:**
- Modify: `features/deploys/services.py`(`services_deploy_plan_check`), `features/health/services.py`(감시 루프에서 호출), `features/notifications/compose.py`(`plan_exceeded`), 알림 종류를 모으는 곳(`features/notifications/services.py`의 `services_notification_kinds` 등 — `deploy_succeeded` 가 등록된 모든 자리에 같은 방식으로 `plan_exceeded` 추가), `docs/api-spec.md`(알림 종류 목록이 있으면)
- Test: `tests/test_deploys_plan.py`(새), 알림 관련 기존 테스트 파일에 compose 테스트

**Interfaces:**
- Consumes: Task 4 열(`planned_hours`, `running_since`, `plan_notified_at`), `Notification_Service.services_notification_deploy_fire(d_id, kind, event=None, ...)`.
- Produces:
  - `Deploy_Service.services_deploy_plan_check(db:AsyncSession, now:datetime|None=None) -> list[int]` — `status == "running"`이고 `planned_hours`와 `running_since`가 있고 `now - running_since >= planned_hours 시간`이며 `plan_notified_at is None`인 배포를 찾아 `plan_notified_at = now`로 표시하고 commit 한 뒤 그 `d_id` 목록을 돌려준다. 같은 배포를 두 번 돌려주지 않는다.
  - `compose_deploy("plan_exceeded", service, deploy)` → 제목에 서비스 이름·"예정한 사용 시간", 본문에 예정 시간(N시간)과 "계속 켜 두면 요금이 나옵니다. 멈추거나 삭제하세요"와 배포 상세 링크(기존 `deploy_failed` 구성 방식을 따른다). 토큰·키 없음.
  - 감시 루프(1분)가 매 주기 `services_deploy_plan_check`를 부르고 나온 `d_id`마다 `deploy_fire(d_id, "plan_exceeded")`. 이 호출이 예외를 내도 루프는 죽지 않고(기존 루프의 방식대로 잡아서 stderr/로그), 헬스 점검을 막지 않는다.

- [ ] **Step 1: 실패하는 테스트**
  - `test_plan_check_notifies_once_at_boundary` — `planned_hours=2`, `running_since = now-2h`(정확히 경계) → 목록에 포함, `plan_notified_at`이 채워짐; 같은 `now`로 다시 부르면 빈 목록. `now-1h59m`은 포함되지 않는다.
  - `test_plan_check_ignores_not_running_no_plan_no_start` — `stopped`, `planned_hours=None`, `running_since=None` 각각 제외.
  - `test_plan_resets_when_running_again` — 알림을 보낸 뒤 `running_since`가 새 시각이 되고 `plan_notified_at`이 비면(Task 4 동작) 새 기간이 지난 뒤 다시 한 번 대상이 된다.
  - `test_compose_plan_exceeded_text` — 제목·본문에 서비스 이름, `4시간`(예정 4), `멈추거나 삭제` 가 들어 있고 `deploys/<d_id>` 링크.
  - `test_plan_exceeded_creates_notification_row` — 가짜 mailer·pusher 로 `deploy_fire`/`deploy_run`을 돌려 알림 줄이 1개 생긴다(기존 `deploy_failed` 알림 테스트 방식).
  - `test_monitor_cycle_fires_plan_notification` — 감시 한 주기(기존 `services_health_check_once` 테스트 방식)가 초과 배포에 대해 알림을 1번 보낸다.
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현. **Step 4:** 통과. **Step 5:** 커밋 `feat(notifications): 예정 사용 시간 초과 알림`.

### Task 6: MCP 비용 미리보기와 사양·계획 인자

**Files:**
- Modify: `features/mcp/services.py`, `features/mcp/server.py`, `features/mcp/guard.py`(필요 시)
- Test: `tests/test_mcp.py`, `tests/test_mcp_server.py`

**Interfaces:**
- Consumes: REST `POST /api/pricing/estimate`(Task 3), `POST /api/deploys/advice`의 확장된 `cost`, `POST /api/deploys`의 `cpu/memory/planned_hours`(Task 4).
- Produces:
  - `services_mcp_analyze`는 확장된 `cost`(새 필드 포함)를 그대로 돌려준다 (허용 필드 목록 `ADVICE_FIELDS`에는 이미 `cost`가 있다 — 새 하위 필드가 필터로 지워지지 않는지 테스트로 고정).
  - `Mcp_Service.services_mcp_deploy(client, store, repo_url, branch=None, connection_id=None, confirm_token=None, max_live=3, cpu=None, memory=None, planned_hours=None, min_tasks=None, max_tasks=None, scale_metric=None, scale_target=None)` — 확인 토큰 `args`에 `cpu`, `memory`, `planned_hours`, `min_tasks`, `max_tasks`, `scale_metric`, `scale_target`을 포함한다(미리보기와 다른 값은 거절). 미리보기는 `POST /api/pricing/estimate`를 불러 `summary`에 구성 요소별 시간당 가격·시간당 합계·한 달 금액(·`planned_hours`가 있으면 그 시간의 금액)·"포함되지 않는 것"을 한국어 한 줄씩 넣는다. 추정 호출이 실패(503 등)해도 미리보기는 만들고 "가격을 가져오지 못했습니다 — 요금이 계속 나옵니다" 한 줄만 넣는다. 실행 때 `POST /api/deploys` 본문에 `cpu`·`memory`·`planned_hours`를 값이 있을 때만 넣는다.
  - `server.py`의 `deploy` 도구가 선택 인자 `cpu`, `memory`, `planned_hours`, `min_tasks`, `max_tasks`, `scale_metric`, `scale_target`을 받는다. 미리보기에는 `max_tasks`가 있으면 "최대 N개까지 늘면 시간당 최대 $X, 한 달 최대 $Y" 줄을 넣는다 (`max_hourly_usd`·`max_monthly_usd`, `/pricing/estimate`에 `max_tasks`를 보낸다). 설명(`description=`)에 사양 프리셋 목록과 "예정 사용 시간을 넘기면 알림만 간다(자동으로 끄지 않는다)"를 더한다. `max_live`는 여전히 도구 인자가 아니다.

- [ ] **Step 1: 실패하는 테스트** (`MockTransport`)
  - `test_mcp_analyze_keeps_extended_cost_fields` — 응답 `cost`에 `hourly_usd`, `components`, `not_included`, `arm64_hourly_usd`가 있어도 결과에 그대로.
  - `test_mcp_deploy_preview_includes_cost_lines` — 미리보기 `summary`가 `시간당`과 `한 달` 금액, 구성 요소 이름(`ALB`), `LCU`(포함되지 않는 것)를 포함하고, `/pricing/estimate` 요청 본문이 선택한 `cpu`·`memory`·`planned_hours`.
  - `test_mcp_deploy_preview_without_prices` — 추정이 503 → 미리보기 성공, `summary`에 `가격을 가져오지 못했습니다`, 토큰 발급.
  - `test_mcp_deploy_token_bound_to_spec_and_plan` — 미리보기(`cpu="256"`,`memory="512"`) 토큰으로 `cpu="512"`,`memory="1024"` 실행 → 거절, `POST` 0번. 같은 값이면 실행 1번, 본문에 `cpu`·`memory`·`planned_hours`.
  - `test_server_deploy_tool_accepts_spec_options` — `build_server`의 `deploy` 입력 스키마에 `cpu`·`memory`·`planned_hours`가 있고 `max_live`는 없다. 도구 설명에 `예정 사용 시간`.
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현. **Step 4:** `pytest tests/test_mcp.py tests/test_mcp_server.py -q` 통과. **Step 5:** 커밋 `feat(mcp): 비용 미리보기와 사양·계획 인자`.

### Task 7: 문서와 전체 확인

**Files:**
- Modify: `docs/architecture.md`(`pricing` 기능, 가격 흐름, 알림 한 줄), `docs/features.md`(`pricing` 행 — 구현된 기능 표에), `docs/aws-notes.md`(Express `cpu`/`memory` 표기와 기본값 **충돌**을 적고, 기본값 "1 vCPU / 2 GB" 줄을 "botocore 1.43.126 모델: 256 / 512 MiB — 실제 확인 전"으로 고친다; 미검증 체크리스트에 "프리셋 4개를 Express 가 모두 받는가", "기본 사양 실제 값", "ALB 가 서비스마다 하나인가"), `.env.example`(`ECS_CPU`/`ECS_MEMORY` 주석: 표기는 CPU 단위/MiB, 기본은 AWS 기본), `docs/milestones.md`, `docs/worklog/2026-11-16.md`(영문 간결), `HISTORY.md` 한 줄

- [ ] **Step 1:** 문서 갱신. **Step 2:** 전체 테스트를 한 번만 `.venv/Scripts/python.exe -m pytest -q` → 이전 627 passed / 2 skipped 에 새 테스트가 더해져 모두 통과. 실패 시 출력 보고(`tests/test_watches.py` 불안정이면 단독 재실행 결과도). **Step 3:** 전체 브랜치 서브에이전트 리뷰(기본 방식) 지적 수정 후 `docs: 비용 확인 문서`로 커밋. **Step 4:** `test`에 `--no-ff` 병합, 브랜치 삭제, push 하지 않음.
