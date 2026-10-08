import time
import boto3
from typing import Callable

from shared.settings import settings

from features.express.scheme import Express_Status, Express_Resource

# ECS Express Mode 호출 (M1)
# 파라미터는 설치된 botocore 서비스 모델(1.43.98)과 공식 시작 안내서로 대조했다 (기획서 06장 "AI의 허구 API")
#   create_express_gateway_service / describe_... / update_... / delete_...
# 모든 함수는 session을 첫 인자로 받는다 (기획서 03장 설계 제약)

DEPLOY_DONE={"SUCCESSFUL"}
DEPLOY_FAILED={"STOPPED", "ROLLBACK_SUCCESSFUL", "ROLLBACK_FAILED"}


class Express_Error(Exception):
    pass


class Express_Service:

    # 필수 역할 확인 - 없으면 어떻게 만드는지 알려준다
    @staticmethod
    def services_express_check_roles() -> tuple[str, str]:
        if not settings.ecs_execution_role_arn or not settings.ecs_infrastructure_role_arn:
            raise Express_Error(
                ".env에 ECS_EXECUTION_ROLE_ARN, ECS_INFRASTRUCTURE_ROLE_ARN 이 필요합니다. "
                "scripts/setup_roles.py 를 한 번 실행하면 만들어 줍니다."
            )
        return settings.ecs_execution_role_arn, settings.ecs_infrastructure_role_arn


    # 서비스 생성 - role_arns 는 연결된 사용자 계정(M6)에 배포할 때만 넘긴다. 없으면 .env 의 개발 계정 역할
    @staticmethod
    def services_express_create(session:boto3.Session, service_name:str, image_uri:str, port:int,
                                health_check_path:str="/", environment:dict[str, str]|None=None,
                                role_arns:tuple[str, str]|None=None) -> Express_Status:
        execution_role_arn, infrastructure_role_arn=role_arns or Express_Service.services_express_check_roles()
        ecs=session.client("ecs")

        primary_container={"image": image_uri, "containerPort": port}
        if environment:
            primary_container["environment"]=[{"name": k, "value": v} for k, v in environment.items()]

        params={
            "executionRoleArn": execution_role_arn,
            "infrastructureRoleArn": infrastructure_role_arn,
            "serviceName": service_name,
            "healthCheckPath": health_check_path,
            "primaryContainer": primary_container,
            "tags": settings.managed_tags,
        }

        if settings.ecs_cpu:
            params["cpu"]=settings.ecs_cpu
        if settings.ecs_memory:
            params["memory"]=settings.ecs_memory

        result=ecs.create_express_gateway_service(**params)

        return Express_Service.services_express_to_status(result["service"])


    # 새 이미지로 재배포
    @staticmethod
    def services_express_update(session:boto3.Session, service_arn:str, image_uri:str, port:int,
                                health_check_path:str="/") -> None:
        ecs=session.client("ecs")

        ecs.update_express_gateway_service(
            serviceArn=service_arn,
            healthCheckPath=health_check_path,
            primaryContainer={"image": image_uri, "containerPort": port},
        )


    # 현재 상태 조회 - 서비스 상태 + 최신 배포 상태 + 주소
    @staticmethod
    def services_express_describe(session:boto3.Session, service_arn:str) -> Express_Status:
        ecs=session.client("ecs")

        result=ecs.describe_express_gateway_service(serviceArn=service_arn)
        status=Express_Service.services_express_to_status(result["service"])

        try:
            deployments=ecs.list_service_deployments(service=service_arn, maxResults=1)["serviceDeployments"]
            if deployments:
                detail=ecs.describe_service_deployments(
                    serviceDeploymentArns=[deployments[0]["serviceDeploymentArn"]]
                )["serviceDeployments"]
                if detail:
                    status.deployment_status=detail[0].get("status")
                    status.deployment_reason=detail[0].get("statusReason")
                    status.lifecycle_stage=detail[0].get("lifecycleStage")

        except ecs.exceptions.ClientError:
            # 생성 직후에는 배포 기록이 아직 없을 수 있다
            pass

        return status


    # 응답 -> Express_Status
    @staticmethod
    def services_express_to_status(service:dict) -> Express_Status:
        endpoint=None
        for config in service.get("activeConfigurations") or []:
            for ingress in config.get("ingressPaths") or []:
                if ingress.get("accessType") == "PUBLIC" and ingress.get("endpoint"):
                    endpoint=ingress["endpoint"]

        if endpoint and not endpoint.startswith("http"):
            endpoint=f"https://{endpoint}"

        state=service.get("status") or {}

        return Express_Status(
            service_arn=service["serviceArn"],
            service_name=service.get("serviceName"),
            status_code=state.get("statusCode"),
            status_reason=state.get("statusReason"),
            endpoint=endpoint,
        )


    # 배포가 끝날 때까지 폴링 - 진행 상황은 on_progress로 알린다
    @staticmethod
    def services_express_wait(session:boto3.Session, service_arn:str,
                              on_progress:Callable[[str], None]|None=None) -> Express_Status:
        deadline=time.monotonic() + settings.deploy_timeout
        last_message=None

        while time.monotonic() < deadline:
            status=Express_Service.services_express_describe(session, service_arn)

            message=" / ".join(filter(None, [
                f"서비스 {status.status_code}",
                f"배포 {status.deployment_status}" if status.deployment_status else None,
                status.lifecycle_stage,
            ]))
            if on_progress and message != last_message:
                on_progress(message)
                last_message=message

            if status.deployment_status in DEPLOY_DONE and status.endpoint:
                return status

            if status.deployment_status in DEPLOY_FAILED:
                raise Express_Error(
                    f"배포 실패 ({status.deployment_status}) :{status.deployment_reason or status.status_reason or '사유 없음'}"
                )

            if status.status_code == "INACTIVE":
                raise Express_Error(f"서비스가 비활성 상태입니다 :{status.status_reason or '사유 없음'}")

            time.sleep(settings.deploy_poll_seconds)

        raise Express_Error(f"배포 대기 시간 초과 ({settings.deploy_timeout}초)")


    # 서비스 삭제 - 반드시 사용자가 요청했을 때만 부른다 (기획서 03장)
    @staticmethod
    def services_express_delete(session:boto3.Session, service_arn:str) -> None:
        ecs=session.client("ecs")
        ecs.delete_express_gateway_service(serviceArn=service_arn)


    # 우리 태그가 붙은 리소스 찾기 - 정리 스크립트용 (기획서 05장)
    @staticmethod
    def services_express_list_managed(session:boto3.Session) -> list[Express_Resource]:
        tagging=session.client("resourcegroupstaggingapi")
        resources=[]

        paginator=tagging.get_paginator("get_resources")
        pages=paginator.paginate(
            TagFilters=[{"Key": settings.managed_tag_key, "Values": [settings.managed_tag_value]}],
            ResourceTypeFilters=["ecs:service", "ecr:repository"],
        )

        for page in pages:
            for item in page["ResourceTagMappingList"]:
                arn=item["ResourceARN"]
                kind="ecs_service" if ":ecs:" in arn else "ecr_repository"
                resources.append(Express_Resource(kind=kind, arn=arn, name=arn.split("/", 1)[-1]))

        return resources


    # ECR 리포지토리 삭제 (이미지 포함)
    @staticmethod
    def services_express_delete_repository(session:boto3.Session, repository_name:str) -> None:
        ecr=session.client("ecr")
        ecr.delete_repository(repositoryName=repository_name, force=True)
