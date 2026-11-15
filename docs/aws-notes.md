# AWS 메모

Express Mode는 2025년 11월 신규 기능이라 AI가 없는 파라미터를 지어낸다 (기획서 06장). **여기 적힌 것만 검증된 것이다.**

## 검증 출처 (2026-09-21)

- 설치된 `botocore` 서비스 모델 — boto3 1.43.126 (처음 2026-09-21 에는 1.43.98 로 조회, 2026-11-16 에 1.43.126 으로 다시 확인), `ecs` 클라이언트를 코드로 조회
- Amazon ECS 개발자 안내서 — *Create your first Express Mode service using the AWS CLI*

> ⚠️ 시그니처는 검증했지만 **실제 AWS 호출은 아직 한 번도 돌려 보지 않았다.** 아래 "M1에서 확인할 것"이 남아 있다.

## API

| 호출 | 필수 | 선택 |
|------|------|------|
| `create_express_gateway_service` | `infrastructureRoleArn` | `executionRoleArn` `serviceName` `cluster` `healthCheckPath` `primaryContainer` `taskRoleArn` `networkConfiguration` `cpu` `memory` `cpuArchitecture` `scalingTarget` `tags` `taskDefinitionArn` |
| `describe_express_gateway_service` | `serviceArn` | `include=['TAGS']` |
| `update_express_gateway_service` | `serviceArn` | create와 같음 (`serviceName`·`cluster`·`tags` 제외) |
| `delete_express_gateway_service` | `serviceArn` | |

- `primaryContainer`: **`image`(필수)**, `containerPort`, `environment[{name,value}]`, `secrets[{name,valueFrom}]`, `command[]`, `awsLogsConfiguration{logGroup,logStreamPrefix}`, `repositoryCredentials{credentialsParameter}`
- `tags`: **소문자** `[{key, value}]` (ECR은 대문자 `Key`/`Value` — 섞지 말 것)
- `cpuArchitecture`: `X86_64` | `ARM64`
- `scalingTarget`: `minTaskCount` `maxTaskCount` `autoScalingMetric`(`AVERAGE_CPU`|`AVERAGE_MEMORY`|`REQUEST_COUNT_PER_TARGET`) `autoScalingTargetValue`
  - 우리는 서비스를 **처음 만들 때만** 보낸다 (사용자가 고른 값, 4개가 다 있을 때만). 재배포·복구의 `update`에는 보내지 않는다. 허용 범위(최대 작업 수, 목표값 등)는 **미검증** — 우리 쪽 상한은 `MAX_TASKS_CAP`(기본 4), 목표값은 CPU·메모리 1~100, 요청 수 1~100000으로 직접 막은 값이다. 이 상한은 **사용자가 고른 증설 설정에만** 적용된다. 증설을 고르지 않으면 `scalingTarget`을 보내지 않으므로 AWS 기본 오토스케일이 동작하고, 그 기본 최대 작업 수는 **미확인**이라 우리 상한이 막아 주지 않는다. 서비스 모델의 기본: 지표 `CPUUtilization`, 목표값 60.
- `cpu`·`memory` 표기 (botocore 1.43.126 서비스 모델로 확인, 2026-11-16): `cpu` = **CPU 단위 문자열**(`"256"` = 0.25 vCPU), `memory` = **MiB 문자열**(`"512"`). 우리는 프리셋 4개(256/512, 512/1024, 1024/2048, 2048/4096)만 서비스를 **처음 만들 때** 보낸다 (우선순위: 배포별 값 → `.env`의 `ECS_CPU`/`ECS_MEMORY` → 보내지 않음). `.env` 값은 **둘 다 있고 프리셋 쌍일 때만** 쓰고, 아니면 무시하고 경고를 남긴다 (비용 추정의 기본 사양도 같은 규칙: `shared/specs.py`).
- `taskDefinitionArn`은 `primaryContainer`·`executionRoleArn`·`taskRoleArn`·`cpu`·`memory`와 함께 쓸 수 없다.
- 기본값: 포트 80, CPU 기준 오토스케일(기본 최대 작업 수는 미확인 — 우리 `MAX_TASKS_CAP`은 적용되지 않는다), 기본 VPC의 퍼블릭 서브넷에 인터넷 연결 ALB.
- ⚠ **기본 사양 충돌 (2026-11-16)**: 예전 메모(개발 안내서 기준)는 기본값을 1 vCPU / 2 GB 라고 적었지만, botocore 1.43.126 서비스 모델은 `cpu` 기본 **256 (.25 vCPU)**, `memory` 기본 **512 MiB**라고 적는다. 어느 쪽이 맞는지 **미검증** — 사양을 안 정하고 만든 실제 서비스를 `describe`로 읽어 보기 전까지 믿지 않는다. 비용 추정은 `.env`에 유효한 `ECS_CPU`/`ECS_MEMORY` 쌍이 있으면 그 값(서비스 생성이 실제로 보내는 값), 없으면 모델 값(256/512)으로 계산하고 "확인 전"이라고 밝힌다.

### 응답에서 읽는 것

```
service.serviceArn
service.status.statusCode                      ACTIVE | DRAINING | INACTIVE
service.activeConfigurations[].ingressPaths[]  { accessType: PUBLIC|PRIVATE, endpoint }
```

주소 형식: `https://<service-name>.ecs.<region>.on.aws/`

배포 진행은 일반 ECS API로 본다: `list_service_deployments(service=arn)` → `describe_service_deployments(...)`.
`status`: `PENDING` `IN_PROGRESS` `SUCCESSFUL` `STOPPED` `STOP_REQUESTED` `ROLLBACK_REQUESTED` `ROLLBACK_IN_PROGRESS` `ROLLBACK_SUCCESSFUL` `ROLLBACK_FAILED`

우리 판정 (`features/express/services.py`): `SUCCESSFUL` + 공개 주소 → 완료 · `STOPPED`/`ROLLBACK_*` 완료 → 실패.

## IAM 역할 (`scripts/setup_roles.py`)

| 역할 | 신뢰 주체 | 관리형 정책 |
|------|-----------|-------------|
| `ecsTaskExecutionRole` | `ecs-tasks.amazonaws.com` | `arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy` |
| `ecsInfrastructureRoleForExpressServices` | `ecs.amazonaws.com` | `arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices` |

방금 만든 역할은 전파에 1분쯤 걸린다. 바로 배포하면 `Unable to assume the service linked role`이 난다 → 기다렸다 다시.

## 내 자격증명 — `aws login` (액세스 키 없이)

검증 출처 (2026-10-06): 설치된 `botocore` 1.43.98 소스(`credentials.py`의 `LoginProvider`) + AWS CLI 사용 설명서 *Login for AWS local development using console credentials*. **2026-10-06 실제 로그인 확인** — IAM 사용자로 `aws login` → boto3가 방식 `login`으로 읽고 `sts:GetCallerIdentity`·`iam:GetRole`·`ec2:DescribeVpcs`·`cloudformation:ValidateTemplate` 성공.

- 브라우저에서 콘솔 로그인(OAuth 2.0 + PKCE)하면 임시 자격증명이 로컬에 저장된다. 우리 앱은 OAuth 클라이언트가 아니다 — AWS CLI가 받아 둔 것을 boto3가 읽는다. 코드는 `get_aws_session()` 그대로.
- 필요한 것: **AWS CLI 2.32.0 이상**, 파이썬 쪽은 **`awscrt`** (`requirements.txt`의 `boto3[crt]`). 없으면 `MissingDependencyException`.
- 권한: 루트는 그대로 됨. IAM 사용자·역할은 관리형 정책 **`SignInLocalDevelopmentAccess`** 필요.
- `aws login` → `~/.aws/config`에 `login_session = arn:aws:iam::<계정>:user/<이름>` + `region`. 토큰은 `%USERPROFILE%\.aws\login\cache\<sha256(login_session)>.json` (`AWS_LOGIN_CACHE_DIRECTORY`로 변경 가능).
- 이름 있는 프로파일: `aws login --profile <이름>` → `.env`의 `AWS_PROFILE=<이름>`. 비워 두면 `default`.
- 수명: 15분 단위로 자동 갱신, **전체 세션은 최대 12시간.** 지나면 `LoginRefreshRequired` → 다시 `aws login`. (`explains` 규칙이 한국어로 안내)
- 갱신은 `signin` 서비스의 `CreateOAuth2Token`을 **세션 리전**(`AWS_REGION`)의 엔드포인트(`https://signin.<region>.amazonaws.com`)로 부른다. 로그인할 때 고른 리전과 `.env`의 `AWS_REGION`을 같게 둔다.
- 확인: `python scripts/check_aws.py` (읽기 전용, `sts:GetCallerIdentity` 한 번).
- 자격증명 공급자 순서: 환경변수 키 → web identity → sso → `~/.aws/credentials` → **login** → process → config. 환경변수나 `credentials` 파일에 키가 남아 있으면 그쪽이 먼저 잡힌다.

- 만료를 실제로 봤다 (2026-10-07): 전날 17:40경 로그인한 세션으로 다음 날 아침 호출 → `Your session has expired or credentials have changed. Please reauthenticate using 'aws login'.` 작업을 시작할 때와 `scripts/session_end.py`를 돌리기 전에 `python scripts/check_aws.py`로 먼저 확인한다.

### `aws login`으로 확인할 것

- [ ] 로그인 리전과 `AWS_REGION`이 다를 때 갱신이 실패하는가 (지금은 `check_aws.py`가 경고만 한다)
- [ ] 12시간 세션이 긴 배포 도중 끝나면 어느 단계에서 어떤 문구로 실패하는가
- [ ] `aws login` 세션을 기반으로 한 `sts:AssumeRole`(M6 `get_assumed_session`)이 그대로 되는가

## 필요한 것

- 해당 리전에 **기본 VPC + 퍼블릭 서브넷**. 없으면 생성이 실패한다.
- 내 자격증명에 `ecs:*ExpressGatewayService`, `ecs:*ServiceDeployments`, `ecr:*`, `iam:PassRole`, `tag:GetResources`. 처음엔 넓게 열고 나중에 좁힌다 (최소 권한부터 하려다 이틀을 쓴다).

## M1에서 확인할 것

- [ ] `services_express_wait`의 완료 판정이 실제 상태 흐름과 맞는가 — 생성 직후 배포 기록이 언제부터 보이는가
- [x] `cpu` / `memory` 표기 — CPU 단위 문자열(`"256"`)과 MiB 문자열 (botocore 1.43.126 모델, 2026-11-16). 기본 사양은 위 "기본 사양 충돌" 참고
- [ ] 프리셋 4개(256/512, 512/1024, 1024/2048, 2048/4096)를 Express 가 모두 받는가 (작업 크기 조합 제한이 있는가)
- [ ] `cpu`·`memory`를 안 정하고 만든 서비스의 **실제 기본 크기** (`describe` 결과로 256/512 인지 1024/2048 인지)
- [ ] ALB 가 서비스마다 하나 생기는가, 여러 서비스가 공유하는가 (아래 "비용"의 "같은 VPC에서 25개 서비스까지 1개 공유"는 문서 기준이고 실제 확인 전. 비용 추정은 서비스마다 하나라고 가정한다)
- [ ] `scalingTarget`의 허용 범위 — `minTaskCount=0`이 되는가, 최대 작업 수·목표값 한계는 얼마인가 (사용자가 고른 증설 설정에서만 우리는 최소 1 이상, 최대 `MAX_TASKS_CAP`로 막는다)
- [ ] 기본 오토스케일의 최대 작업 수(`maxTaskCount` 기본값) — 증설을 고르지 않은 서비스가 트래픽에 따라 몇 개까지 늘어나는가 (우리는 `scalingTarget`을 보내지 않아 `MAX_TASKS_CAP`이 막지 못한다. 비용 추정은 작업 1개 기준이고 이 사실을 가정에 적는다)
- [ ] 배포 서킷 브레이커 + 카나리 + 5XX 알람이 **롤백을 대신해 주는가**. 된다면 롤백을 직접 구현하지 않는다 (기획서 03장)
- [ ] Express Mode가 자동 생성한 ALB·보안그룹에 우리 `managed-by` 태그가 전파되는가 — M6의 "태그 기준 권한 한정"이 여기에 달려 있다
- [ ] 서비스 삭제 후 ALB가 실제로 회수되기까지 걸리는 시간
- [ ] `serviceName` 길이·문자 제한 (지금은 `dw-<레포 24자>-<d_id>`)

## 함정 (기획서 06장)

| 함정 | 대응 | 코드 |
|------|------|------|
| arm64 이미지 → `exec format error` | 항상 `--platform linux/amd64` | `builds/services.py` |
| ECR 토큰 12시간 만료 | 푸시할 때마다 새로 받는다 | `services_build_login` |
| 첫 배포까지 대부분 권한 오류 | 에러의 `not authorized to perform` 뒤 동작 이름이 빠진 권한 | `explains` 규칙 |
| 실습하고 그냥 둔 리소스 | `python scripts/cleanup.py --yes` | `managed-by` 태그 기준 |

## IAM 역할 (M6 — 교차 계정, 진행 중)

`scripts/setup_roles.py`의 두 역할(실행 역할, 인프라 역할)은 개발자 자신의 계정에 만드는 것이었다. M6는 **사용자 계정**에 역할 세 개를 만든다 — 템플릿: `features/accounts/cloudformation/deploy_wizard_role.yaml` (⚠ 미검증, 아래 체크리스트 참고).

| 역할 | 신뢰 주체 | 용도 |
|------|-----------|------|
| `DeployWizardCrossAccountRole` | 우리 AWS 계정(`arn:...:root`) + `sts:ExternalId` 조건 | 우리 서버가 `sts:AssumeRole`로 빌리는 역할. ECS Express 생성/관리, ECR 생성/푸시, CloudWatch Logs 읽기, 두 실행 역할에 대한 `iam:PassRole` |
| `DeployWizardEcsTaskExecutionRole` | `ecs-tasks.amazonaws.com` | `setup_roles.py`의 `ecsTaskExecutionRole`과 동일 정책, 사용자 계정에 |
| `DeployWizardEcsInfrastructureRole` | `ecs.amazonaws.com` | `setup_roles.py`의 `ecsInfrastructureRoleForExpressServices`와 동일 정책, 사용자 계정에 |

이름에 접두어를 붙인 이유 (2026-10-06): 실제 계정을 조회해 보니 `ecsTaskExecutionRole`이 이미 있었다. 흔한 이름이라 그대로 쓰면 스택 생성이 이름 충돌로 실패한다. 코드 상수는 `features/accounts/services.py`의 `CFN_*_ROLE_NAME` — 템플릿과 어긋나면 테스트가 깨진다. **Express Mode가 인프라 역할 이름을 가리는지는 미검증** (가이드의 이름은 예시로 보고 바꿨다).

스택을 만들 때 콘솔에서 "IAM 리소스 생성 승인" 체크가 필요하다 — `validate_template` 결과 `CAPABILITY_NAMED_IAM` (2026-10-06 실제 호출로 확인, 템플릿 문법도 통과).

흐름: 사용자가 우리 화면에서 템플릿 다운로드 → 자기 콘솔에서 스택 생성(파라미터: `TrustedAwsAccountId`, `ExternalId` — 둘 다 화면이 만들어 보여준 값) → 출력된 `RoleArn`을 화면에 붙여넣음 → 우리 서버가 `sts:AssumeRole` 검증.

원클릭 CloudFormation 링크(`quickcreate?templateURL=...`)는 쓰지 않는다 — 템플릿이 공개 URL(보통 S3)에 있어야 하는데 지금은 로컬 서버뿐이다. 지금은 다운로드 후 콘솔에 수동 업로드. 실제 서비스가 되면 템플릿을 S3에 올리고 링크 방식으로 바꾸면 된다(설계는 그대로).

### 템플릿 변경 이력 — 이미 만든 스택은 업데이트해야 반영된다

| 날짜 | 변경 | 없으면 생기는 일 |
|------|------|------------------|
| 2026-10-06 | 역할 이름 `DeployWizardEcs*` | (새 스택부터 적용) |
| 2026-10-06 | `s3:ListAllMyBuckets`, `s3:ListBucket`(`cf-templates-*`), `s3:DeleteObject`(`cf-templates-*/*-deploy_wizard_role.yaml`) | [템플릿 파일 삭제]가 403 |
| 2026-10-06 | `ecr:DeleteRepository` | 연결된 계정의 배포 [삭제]가 ECR 단계에서 AccessDenied — 이미지가 남아 저장 요금이 계속 나간다 |
| 2026-10-06 | 버전 표시: 위임 역할에 태그 `template-version: '2'` + 자기 역할에 대한 `iam:GetRole` | 화면이 버전을 못 읽어 0으로 보고 "스택 업데이트 필요"를 띄운다 |

**템플릿의 권한을 바꾸면 반드시 함께:** 템플릿의 `template-version` 태그 값과 `features/accounts/services.py`의 `TEMPLATE_VERSION`을 같이 올린다(어긋나면 테스트가 깨진다). 그러면 기존 연결의 화면에 "스택 업데이트 필요"와 [스택 업데이트] 버튼이 자동으로 뜬다. 사용자 계정의 역할은 사용자만 바꿀 수 있어서 우리가 대신 업데이트할 수 없다.

2026-10-06 실제 확인: 소유자 계정의 `deploy-wizard` 스택을 변경 세트로 업데이트 → `DeployWizardTrustRole`만 `Modify`(교체 없음), `UPDATE_COMPLETE`. 그 뒤 위임 역할로 `iam:GetRole` 태그 읽기(버전 2), `s3:ListAllMyBuckets`·`s3:ListBucket`·`s3:DeleteObject`(템플릿 파일 1개 삭제) 모두 성공.

콘솔에서 템플릿 파일을 올리면 AWS가 `cf-templates-<해시>-<리전>` 버킷을 만들고 `<시각><난수>-deploy_wizard_role.yaml`로 저장한다 (2026-10-06 실제 확인, 버전 관리 꺼짐). 설계 제약 8(태그 붙은 것만 정리)의 예외: 이 파일은 태그가 없지만 파일 이름으로 우리 것임을 가린다. 버킷과 다른 파일은 지우지 않는다.

### 멈춤 / 다시 켜기 (2026-10-06, 실제 AWS 미검증)

- 멈춤 = `delete_express_gateway_service`만. ECR 이미지·기록은 남긴다. 다시 켜기 = 저장된 `image_uri`로 `create_express_gateway_service` (같은 `serviceName`).
- [x] 서비스 삭제 직후(DRAINING) 같은 이름으로 다시 만들 수 있는가 — **못 만든다** (`InvalidParameterException: Unable to Start a service that is still Draining`, 2026-11-15). 멈춤 뒤 다시 켜기까지 약 10분 걸렸다. `services_express_create` 가 이 메시지면 `deploy_timeout`(1200초) 안에서 다시 시도한다. 서비스 삭제 뒤 ALB(`ecs-express-gateway-alb-*`)는 약 8분 뒤 저절로 사라진다
- [x] 다시 켠 뒤 주소가 전과 같은가 — **다르다** (2026-11-15 실제 확인: 서비스를 다시 만들면 주소가 새로 생긴다)
- [ ] 마지막 서비스를 내리면 ALB 요금이 실제로 멈추는가 (위 "M1에서 확인할 것"의 ALB 회수 시간과 같은 질문)
- [ ] 삭제 후 남는 것이 있는가 — CloudWatch 로그 그룹, 보안그룹. `python scripts/cleanup.py`로 확인

### M6에서 확인할 것 (CFN 템플릿 관련, 전부 미검증)

- [ ] `ecs:*ExpressGatewayService`가 `aws:RequestTag`/`aws:ResourceTag` 조건을 실제로 지원하는가
- [ ] ECR 액션(`ecr:PutImage` 등)을 `arn:aws:ecr:*:*:repository/deploy-wizard/*`로 좁힐 수 있는가 (지금 템플릿은 `Resource: "*"`)
- [ ] Express Mode가 만드는 CloudWatch 로그 그룹 이름 규칙 (지금 `logs:*`도 `Resource: "*"`)
- [ ] 위임받은 세션(`get_assumed_session`)으로 `create_express_gateway_service` 호출 시, **대상 계정에** 새로 만든 두 실행 역할 ARN이 실제로 통하는가 — 코드는 2026-10-06부터 연결된 계정이면 `.env` 값이 아니라 그 계정의 역할 ARN을 넘긴다 (`services_aws_account_role_arns`). 그전에는 개발 계정 역할을 그대로 넘겨서 무조건 실패했을 것
- [x] 사용자 계정에 `ecsTaskExecutionRole`이 **이미 있으면** 스택 생성이 이름 충돌로 실패한다 → 템플릿 역할 이름을 `DeployWizardEcs*`로 바꿔 해결 (2026-10-06)
- [ ] 루트 자격증명은 `sts:AssumeRole`을 못 한다 — 우리 쪽(위임하는 쪽)은 IAM 사용자여야 한다
- [ ] `sts:AssumeRole`의 기본 세션 수명(1시간)이 배포 하나(클론~배포 완료)를 끝내기에 충분한가 — 대형 레포/느린 빌드일 때

### 운영 복구 (2026-11-10, 실제 AWS 미검증)

자동 복구(`features/incidents/recovery.py`)가 쓰는 AWS 호출은 위 "API" 표의 `update_express_gateway_service` 하나뿐이다 (`services_express_update`, 대기는 `services_express_wait`). 다른 호출은 쓰지 않는다 — 삭제·사양 변경·크기 조절·로그/이벤트 수집 없음.

- **재시작** = 지금 `image_uri` 그대로 `update` 호출. Express Mode가 이미지가 같을 때 작업(Task)을 실제로 다시 띄우는지는 **미검증**이다. 안 띄운다면 재시작은 효과가 없고, 검증(정상 3연속)에 실패해 곧바로 되돌리기로 넘어간다.
- **되돌리기** = 직전 정상 릴리스(`deploy_releases.state='previous'`, `healthy_since`가 있고 `image_uri`가 있는 것)의 이미지로 `update` 호출. 그 이미지가 ECR에 **아직 있어야** 한다. `scripts/session_end.py`(`services_deploy_session_end`)와 배포 삭제는 저장소를 지우므로, 그때 그 배포의 `previous` 릴리스를 `old`로 바꿔 되돌리기 대상에서 뺀다 (`current` 행은 다시 켤 때 같은 태그로 다시 빌드되니 둔다). 없는 이미지로 `update`를 부르면 Express `update`는 이미지 문자열을 **그대로 받아들이고** 실패는 작업 시작 시점(서킷 브레이커·`services_express_wait` 시간 초과)에야 드러날 가능성이 크다 — **미검증**. 그 경우 시도는 `failed`, 인시던트는 `needs_action`이 된다.
- 인자는 파이프라인 재배포와 같다: `port`, `health_check_path`, 환경변수(`environment`)를 매번 같이 보낸다 (`primaryContainer`를 통째로 바꾸기 때문).
- 자동 재시작·되돌리기는 **지금 저장된 환경변수 값**을 보낸다. 저장만 하고 아직 배포하지 않은 환경변수 수정이 재시작과 함께 반영될 수 있다 (감수한 위험).
- 되돌리기는 릴리스마다 저장하지 않는 **지금의 포트·`health_check_path`**를 그대로 쓴다. 그 사이 포트를 바꿨다면 이전 이미지가 맞지 않아 검증이 실패하고 `needs_action`이 된다.
- [ ] 같은 이미지 `update`가 새 배포(작업 교체)를 일으키는가
- [ ] 이미지만 바꾼 `update`가 `ROLLBACK_*` 배포 상태를 거치지 않고 끝나는가 (`services_express_wait`가 실패로 읽는 상태)

## 비용

### 가격 출처와 기준 (2026-11-16)

코드는 실행할 때 AWS **공개 가격 파일**(인증 없음)을 읽는다: `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{AmazonECS|AWSELB}/current/{region}/index.json` (`features/pricing/services.py`, 서버 파일 캐시 24시간 `PRICING_CACHE_HOURS`). Fargate x86 vCPU·GB, ALB 시간당(`LoadBalancerUsage`)·LCU 행을 고른다. 아래 값은 **2026-11-16에 서울 리전(ap-northeast-2)에서 본 값**일 뿐 코드에 박혀 있지 않다 (바뀔 수 있음):

| 항목 | 단가 (USD) |
|------|-----------|
| Fargate x86 vCPU | 0.04656 / 시간 |
| Fargate x86 메모리 | 0.00511 / GB·시간 |
| ALB 고정 | 0.0225 / 시간 |
| ALB LCU | 0.008 / LCU·시간 (추정에는 넣지 않는다) |

기본 사양(0.25 vCPU / 0.5 GB) 시간당 약 $0.0367 (Fargate 0.0142 + ALB 0.0225), 한 달(730시간) 약 $26.79. 계산식과 빠지는 요금은 [`architecture.md`](./architecture.md) "비용 확인". 이 값들은 추정치이고 실제 청구서와 대조한 적 없다.

### 실제로 본 것 (2026-11-15, 실제 AWS)

- 서비스를 멈춘(삭제한) 직후 같은 이름으로 다시 만들면 `Unable to Start a service that is still Draining`으로 실패한다. 다시 켜기까지 약 10분 걸렸다 (코드가 이 메시지면 `deploy_timeout` 안에서 다시 시도한다).
- 서비스를 지우면 ALB(`ecs-express-gateway-alb-*`, `managed-by` 태그 있음)는 약 8분 뒤 저절로 사라진다.
- 서비스를 다시 만들면 주소(`endpoint`)가 새로 바뀐다.

### 일반

ALB는 떠 있는 동안 계속 과금된다 (같은 VPC에서 25개 서비스까지 1개를 공유). 작업을 끝낼 때 "오늘 만든 리소스 다 지웠나"를 확인한다. AWS Budgets 예산 알림을 가장 먼저 걸어 둔다.
