# 배포 전 비용 확인과 사용 옵션 설계

작성 2026-11-16. 상태: 승인됨(소유자가 범위를 고름: 백엔드+웹+MCP 한 번에, 사양 선택·사용 계획·ARM64 가격 비교(표시만)·남은 시간 알림(알림만), **트래픽 증가 시 자동 증설 옵션**(2026-11-16 추가), 시간대 스케줄·유휴 휴면·자동 절전·Kubernetes는 설계만).

## 1. 왜 하는가

배포는 요금이 나가는 행동이다 (ALB + Fargate가 떠 있는 동안 계속). 지금은 분석 화면의 비용 칸이 비어 있어("아직 계산할 수 없습니다") 사용자가 **무엇이 만들어지고 얼마가 드는지 모른 채** 누른다. 배포 직전에 리소스 종류와 가격을 보여 주고, 사양과 사용 계획을 고른 뒤 승인하게 한다. 웹과 MCP 미리보기가 같은 계산을 쓴다.

## 2. 목표 / 비목표

**목표**
- G1. 분석 결과에 리소스별 시간당 가격과 사용 계획 기준 추정 금액이 나온다. 가격은 코드에 적지 않고 AWS 공개 가격 파일에서 읽는다.
- G2. 사용자가 사양(CPU·메모리)과 사용 계획(예정 사용 시간)을 정하고 배포한다. 정한 사양이 실제 ECS 서비스에 적용된다.
- G3. ARM64(Graviton) 가격은 비교로만 보여 준다.
- G4. 예정 시간을 넘기면 **알림만** 보낸다 (자동 멈춤·삭제 없음).
- G5. 웹 분석 화면과 MCP `analyze_repo`·`deploy` 미리보기가 같은 비용 정보를 보여 준다.
- G6. (소유자 추가) **트래픽이 늘면 늘리는 자동 증설을 선택할 수 있다**: 최소·최대 작업 수(우리 상한 1~4)와 기준(`AVERAGE_CPU`·`AVERAGE_MEMORY`·`REQUEST_COUNT_PER_TARGET`)·목표값. 늘리는 주체는 우리가 아니라 AWS 오토스케일이고, 사용자가 배포 때 고른 설정을 확인한 뒤 적용한다. 비용에는 **최대 작업 수까지 늘었을 때의 최대 시간당 금액**을 같이 보여 준다.

**비목표 (이번에 만들지 않음)**
- 시간대 스케줄, 유휴 휴면, 상태·시간대 자동 절전 (7절: 설계만 — Hard rule 3 개정이 선행).
- Kubernetes(EKS) 배포 대상 (7절: 별도 프로젝트로 설계만).
- 앱(Expo) 화면 — 다음 단계.
- 트래픽(LCU)·데이터 전송·로그·ECR 저장 비용 계산 (고정분만, "포함되지 않음"으로 명시).
- 원화 환산 (환율을 모른다 — USD로만).
- 사용자가 임의의 CPU·메모리 조합 입력 (검증된 프리셋만).

**실패로 보는 것**: 코드에 적어 둔 가격이 낡아 틀린 금액을 보여 주는 것, 검증하지 않은 사양 값을 AWS에 보내 배포가 실패하는 것, 추정치를 확정 금액처럼 보이게 하는 것.

## 3. 확인된 사실 (2026-11-16)

- **가격 출처**: AWS 공개 가격 파일 `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<서비스>/current/<region>/index.json` — 인증 없음. ECS 약 756KB, ELB 약 16KB. 서울(ap-northeast-2), `publicationDate` 2026-11-11.
  - Fargate x86: vCPU `…Fargate-vCPU-Hours:perCPU` $0.04656/시간, 메모리 `…Fargate-GB-Hours` $0.00511/GB·시간. ARM: vCPU `…Fargate-ARM-vCPU-Hours:perCPU` $0.03725/시간(메모리 값은 구현 때 읽음).
  - ALB: 상품군 `Load Balancer-Application`, `…LoadBalancerUsage` $0.0225/시간, `…LCUUsage` $0.008/LCU·시간. (같은 `usagetype`이 NLB·Gateway LB에도 있어 **상품군으로 걸러야 한다**.)
- **사양 표기** (설치된 botocore 1.43.126 서비스 모델): `cpu`는 CPU 단위 문자열(`"256"` = 0.25 vCPU), `memory`는 MiB 문자열, `cpuArchitecture`는 `X86_64`|`ARM64`. **Express 서비스 기본값은 256 / 512 MiB**로 적혀 있다.
- **충돌**: `docs/aws-notes.md`와 `.env.example`은 기본값을 "1 vCPU / 2 GB"로 적고 있다. 최신 모델(위)을 따르되, **실제 배포 뒤 `describe`로 확인하기 전까지는 미검증**으로 표시하고, 비용 가정에 "기본 사양(AWS 문서 기준)"이라고 쓴다.
- 허용 조합: Fargate 표준 작업 크기 중 안전한 프리셋만 쓴다 — 256/512, 512/1024, 1024/2048, 2048/4096 (CPU 단위 / MiB). Express 가 이 조합을 모두 받는지는 **첫 실제 배포에서 확인**(미검증).
- 기본 사양 기준 고정비 추정: Fargate $0.0142/시간 + ALB $0.0225/시간 = 약 $0.037/시간, 730시간 약 $27. (ALB 공유 여부는 미확인 — 서비스마다 ALB 가 하나씩인지 확인 전, 최악(서비스당 1개)으로 계산.)

## 4. 접근

가격 계산은 새 기능 폴더 `features/pricing/`로 둔다 (가격 파일 읽기·캐시·계산). 분석(`advice`)과 MCP는 `pricing`의 services 만 부른다 (기능 간 services 로만 호출 규칙).

| 선택지 | 비고 |
|---|---|
| **A (선택): 공개 가격 파일 + 디스크 캐시** | 인증 불필요(분석은 AWS 호출 없음 원칙 유지, 다중 사용자에도 맞음). 24시간 캐시, 네트워크 실패 시 낡은 캐시를 "기준일"과 함께 쓰고, 캐시도 없으면 금액 없이 "가격을 가져오지 못했습니다" |
| B | Pricing API(`pricing:GetProducts`) | 사용자 계정 위임 역할에 권한이 없어 우리 자격증명이 필요. 분석이 AWS 호출을 하게 됨 |
| C | 코드에 가격 상수 | 낡는다 — 실패로 본 것 |

## 5. 설계

### 5.1 `features/pricing/`
- `scheme.py`: `Price_Table`(vCPU·GB·ALB·LCU 단가 x86/ARM, `basis_date`, `region`), `Spec_Option`(`label`, `cpu`, `memory`, `vcpu`, `memory_gb`), `Cost_Component`(`name`, `hourly_usd`, `note`), `Cost_Estimate`.
- `services.py`:
  - `services_pricing_table(region, ...)` — 가격 파일을 읽어(httpx) 파싱, `data/cache/pricing-<region>.json`에 24시간 캐시. 상품 선택은 `usagetype` 접미사 + 상품군 + OS Linux로. 파싱 실패·누락은 예외가 아니라 `None`(금액 없음).
  - `services_pricing_spec_options()` — 프리셋 4개.
  - `services_pricing_estimate(table, cpu, memory, arch="X86_64", planned_hours=None)` — 순수 함수. 구성 요소 = Fargate(vCPU·메모리) + ALB 고정분. 결과: 시간당 합계, **기간별 금액**(1시간·1일(24h)·1주(168h)·한 달(730h)), `planned_hours` 있으면 그 시간의 금액, ARM64 시간당·절감률(표시용), 가정·포함되지 않는 것 목록, 기준일.
- 라우터 `GET /api/pricing/options`(프리셋, 사용 계획 빠른 선택 값), `POST /api/pricing/estimate`(`{cpu?, memory?, planned_hours?}` → `Cost_Estimate`; 클론 없이 빨리 다시 계산하려고 분석과 분리).

### 5.2 분석 응답
`Deploy_Advice.cost`(`Advice_Cost`)를 확장한다 (기존 필드 유지): `monthly_min/max`는 기본 사양·한 달 연속 기준 고정분 추정, `basis_date`, `note`에 더해 `hourly_usd`, `components[]`, `not_included[]`, `arm64_hourly_usd`. 가격을 못 가져오면 지금처럼 숫자 None.

### 5.3 배포 옵션 저장
`deploys`에 nullable 열 추가(`ENSURE_COLUMNS`): `cpu`, `memory`(프리셋 값, 없으면 AWS 기본), `planned_hours`(float, 없으면 계획 없음), `running_since`(running 이 된 시각), `plan_notified_at`. 배포 생성 본문에 `cpu`·`memory`·`planned_hours` 선택 항목. 프리셋 밖 값·음수·0은 400. `PATCH settings`로 `planned_hours` 변경(알림 재무장: `plan_notified_at`을 비운다). 파이프라인이 Express 생성에 `cpu`·`memory`를 넘긴다 (우선순위: 배포별 값 → `.env`의 `ECS_CPU`/`ECS_MEMORY` → 비움).

### 5.3a 자동 증설 옵션 (G6)
`deploys`에 nullable 열 `min_tasks`, `max_tasks`(정수), `scale_metric`, `scale_target`(정수)를 더한다. 모두 비어 있으면 `scalingTarget`을 보내지 않고 AWS 기본 오토스케일(CPU 평균 60 기준)에 맡긴다. 하나라도 있으면 모두 있어야 하며 Express `create_express_gateway_service`의 `scalingTarget{minTaskCount, maxTaskCount, autoScalingMetric, autoScalingTargetValue}`로 보낸다 (이 구조와 지표 값은 botocore 1.43.126 서비스 모델·`aws-notes.md`로 확인된 것만 쓴다). 검증: `1 <= min <= max <= 4`(상한은 `MAX_TASKS_CAP`, 기본 4 — 요금 폭주 방지, 우리가 정함), 지표는 위 셋, 목표값은 CPU·메모리 기준일 때 1~100(%), 요청 수 기준일 때 1 이상 100000 이하. **허용 범위(최대 작업 수 등)는 AWS 쪽 실제 한도를 검증하지 않았다** — 첫 실제 배포에서 확인. 비용 계산에는 작업 하나의 Fargate 가격과 `max_tasks`로 `max_hourly_usd = max_tasks × Fargate + ALB`, `max_monthly_usd`를 더한다 ("최대치 — 트래픽이 이 수까지 늘어 계속 유지될 때"). 배포 후 증설 설정 변경(`update_express_gateway_service`의 `scalingTarget`)은 이번 범위 밖 (사용자 확인이 필요한 변경이라 별도).

### 5.4 남은 시간 알림 (G4)
`running_since`: running 이 될 때 `running_since`가 비어 있으면 지금 시각으로 채우고, 멈춤·삭제·서비스 없는 실패 때 비운다. 살아 있는 서비스의 재배포·재시작·복구는 시간을 이어서 센다. 멈춤 후 다시 켜면 처음부터 다시 센다. 헬스 감시 루프(1분)가 `planned_hours`가 있고 `running_since`로부터 그 시간이 지났고 `plan_notified_at`이 비어 있는 `running` 배포를 찾아 알림 종류 `plan_exceeded`를 한 번 보낸다 ("예정한 사용 시간(N시간)을 넘겼습니다. 계속 켜 두면 요금이 나옵니다. 멈추거나 삭제하세요"). **자동 멈춤·삭제는 하지 않는다.** (멈춤 후 다시 켜면 시간은 처음부터 다시 센다 - 내가 정함.)

### 5.5 웹 (분석 화면, G5)
분석 결과에 "배포하면 만들어지는 것"(ECR, ECS 서비스(Fargate), ALB)과 구성 요소별 시간당 가격, 기간별 금액을 보여 준다. 사양 선택(프리셋), 사용 계획 빠른 선택(4시간 / 하루 / 일주일 / 계속) + 직접 입력(시간), ARM64 비교 한 줄("ARM64면 약 N% 저렴 — 이 마법사는 x86으로만 빌드합니다"), "포함되지 않음" 목록, [이 레포로 배포]·[다른 레포로]. 옵션을 바꾸면 `POST /pricing/estimate`로 다시 계산한다. 배포 상세에는 사양과 사용 계획(남은 시간)을 한 줄로 보여 준다. 알림 목록에 `plan_exceeded`가 보인다.

### 5.6 MCP (G5)
`analyze_repo`는 확장된 `cost`를 그대로(허용 필드 목록에 추가) 돌려주고, `deploy`는 선택 인자 `cpu`·`memory`·`planned_hours`를 받는다 (확인 토큰 인자에 포함 — 미리보기와 다른 사양으로 실행되지 않게). 미리보기 `summary`·`warnings`에 구성 요소 가격과 한 달/예정 시간 추정을 넣는다. 가격이 없으면 "가격을 가져오지 못했습니다 — 요금이 계속 나옵니다"만.

## 6. 문서
`docs/api-spec.md`(새 라우터·요청 항목), `docs/ui-spec.md`, `docs/architecture.md`·`docs/features.md`(`pricing`), `docs/aws-notes.md`(기본 사양 충돌·가격 파일 출처·미검증 목록), `docs/milestones.md`, worklog·HISTORY.

## 7. 자동 운영 옵션과 Kubernetes (설계만, 만들지 않음)

소유자 요청(2026-11-16): 시간대별 스케줄링, 유휴 상태 휴면, 특정 상태·시간대 자동 절전, 트래픽 증가 시 증설, Kubernetes 를 선택 옵션으로. **증설은 5.3a 로 만든다.** 나머지는 아래 이유로 **소유자 결정이 먼저**라서 설계만 남긴다.

**공통 선행 결정: Hard rule 3 개정.** 자동 행동은 롤백·운영 복구 둘로 제한돼 있다. 일정·유휴·상태에 따른 자동 절전은 새 자동 행동이라 **소유자가 규칙을 고쳐야** 한다 (CLAUDE.md 수정은 소유자 승인). 개정 시 조건 제안: 배포별 옵트인만, 매번 기록과 알림(원인·새 주소 포함), 하루 횟수 한도, 삭제는 하지 않고 멈춤만, 켜기·끄기 실패 시 멈추고 사용자에게 묻기.

**확인된 사실 (실제 AWS, 2026-11-15)**: 멈춤 = ECS 서비스 삭제, 다시 켜기 = 새로 만들기. 멈춘 직후 다시 켜면 `still Draining`으로 막혀 **약 10분**, ALB 는 삭제 뒤 약 8분 뒤 사라지고, **주소가 바뀐다**. 따라서 "자동 켜기"는 지정 시각보다 약 10분 늦고 주소가 바뀐다.

| 옵션 | 동작 | 제약·미검증 |
|---|---|---|
| 시간대 스케줄 | 요일·시작·끝(`Asia/Seoul`)에만 서비스를 켠다 | 위 지연·주소 변경. 일정 감시 루프가 기존 멈춤·다시 켜기 함수를 부른다 |
| 유휴 휴면 | 일정 시간 요청이 없으면 멈춘다 | **요청 수 측정이 필요** — ALB `RequestCount`(CloudWatch) 조회는 우리가 아직 쓰지 않았고 검증 전. 서비스를 지우면 주소도 사라지므로 요청이 와도 자동으로 깨울 수 없다 (사용자가 다시 켜야 함) |
| 상태·시간대 자동 절전 | 지정한 상태(예: 응답 없음)나 시간대에 멈춘다 | 인시던트 자동 복구(재시작·롤백)와 충돌하지 않게 우선순위 정의 필요 |
| 0개로 줄이기(대안) | `minTaskCount=0`으로 컨테이너만 0 | **허용 여부 미검증.** ALB 고정비(약 $16/월)는 그대로라 절감이 작다. 2026-10-06 결정("멈춤 = 서비스 삭제")과 같은 이유 |

**Kubernetes(EKS)**: 지금 파이프라인은 ECS Express Mode 전용(역할·네트워크·상태 조회·삭제·헬스·복구 전부)이다. EKS 는 컨트롤 플레인만 시간당 약 $0.10(월 약 $73, 가격 파일로 확인 필요)이고 노드·Ingress·권한이 따로라, 기능 한두 개가 아니라 **배포 대상 하나를 더 만드는 별도 프로젝트**다. 이번에는 만들지 않고, 소유자가 원하면 "배포 대상 선택(ECS Express / EKS)"을 독립 프로젝트로 설계한다 (범위: 사용자 계정 역할 템플릿, 이미지 배포, 서비스 노출, 비용 표시, 삭제 정리).

## 8. 내가 정한 것 (검토 요청)

1. 가격은 공개 가격 파일 + 24시간 캐시 (코드에 가격 상수 없음). 실패하면 금액 없이 안내.
2. 사양은 검증된 프리셋 4개만. 기본(사양 미선택)은 AWS 기본값에 맡기고 비용은 256/512 기준으로 계산하며 "실제 확인 전"을 표시.
3. 사용 계획은 "예정 사용 시간(총 시간)" 하나로 단순화 (하루 몇 시간 × 며칠 같은 입력은 UI에서 총 시간으로 환산하는 도우미).
4. 알림은 한 번만(`plan_notified_at`), 멈춤 후 다시 켜면 시간을 처음부터 다시 센다.
5. ARM64는 표시만.
6. 비용은 USD, 고정분만, 포함되지 않는 것을 항상 같이 보여 준다.
7. 계획은 2개로 나눈다: 백엔드+MCP, 웹+문서.
8. 자동 증설은 AWS 오토스케일을 사용자가 배포 때 고르는 설정으로 해석했다 (우리가 직접 늘리는 자동 행동이 아님, Hard rule 3 의 "scale 은 사용자 확인"은 배포 확인 단계에서 충족). 소유자가 다르게 보면 알려 줄 것.
9. 증설 상한(최대 작업 수) 기본 4 — 요금 폭주 방지용 우리 선택.
