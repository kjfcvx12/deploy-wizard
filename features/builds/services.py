import base64
import boto3
from pathlib import Path
from typing import Callable

from shared.settings import settings
from shared.proc import proc_run, Proc_Error

# 이미지 빌드와 ECR 푸시 (M2)
# 모든 AWS 호출은 session을 첫 인자로 받는다 (기획서 03장 설계 제약)


class Build_Service:

    # docker 빌드 - 맥에서 만든 arm64 이미지는 Fargate에서 exec format error로 죽는다 (기획서 06장)
    @staticmethod
    def services_build_image(app_path:Path, image_tag:str, support_level:str,
                             on_line:Callable[[str], None]|None=None) -> str:
        timeout=settings.build_timeout_official
        if support_level == "experimental":
            # Java·Rust는 Node 기준 타임아웃이면 정상 빌드도 실패로 처리된다
            timeout=settings.build_timeout_experimental

        return proc_run(
            ["docker", "build", "--platform", "linux/amd64", "--progress", "plain", "-t", image_tag, "."],
            cwd=str(app_path),
            timeout=timeout,
            on_line=on_line,
        )


    # ECR 리포지토리 없으면 생성 - 우리 태그를 붙인다
    @staticmethod
    def services_build_ensure_repository(session:boto3.Session, repository_name:str) -> str:
        ecr=session.client("ecr")

        try:
            result=ecr.describe_repositories(repositoryNames=[repository_name])
            return result["repositories"][0]["repositoryUri"]

        except ecr.exceptions.RepositoryNotFoundException:
            result=ecr.create_repository(
                repositoryName=repository_name,
                imageScanningConfiguration={"scanOnPush": True},
                tags=[{"Key": settings.managed_tag_key, "Value": settings.managed_tag_value}],
            )
            return result["repository"]["repositoryUri"]


    # ECR 로그인 - 토큰은 12시간이면 만료된다. 매번 새로 받는다 (기획서 06장)
    @staticmethod
    def services_build_login(session:boto3.Session) -> str:
        ecr=session.client("ecr")

        auth=ecr.get_authorization_token()["authorizationData"][0]
        username, password=base64.b64decode(auth["authorizationToken"]).decode("utf-8").split(":", 1)
        registry=auth["proxyEndpoint"].removeprefix("https://")

        # 비밀번호는 인자가 아니라 stdin으로 넘긴다 (프로세스 목록·로그에 남지 않게)
        proc_run(["docker", "login", "--username", username, "--password-stdin", registry],
                 timeout=60, stdin_text=password)

        return registry


    # 태그 붙여서 푸시 -> 배포에 쓸 이미지 주소
    @staticmethod
    def services_build_push(session:boto3.Session, image_tag:str, repository_name:str, version:str,
                            on_line:Callable[[str], None]|None=None) -> str:
        repository_uri=Build_Service.services_build_ensure_repository(session, repository_name)
        Build_Service.services_build_login(session)

        image_uri=f"{repository_uri}:{version}"

        proc_run(["docker", "tag", image_tag, image_uri], timeout=60)
        proc_run(["docker", "push", image_uri], timeout=1800, on_line=on_line)

        return image_uri


    # 로컬에 해당 태그 이미지가 남아 있는지 - 이어하기에서 빌드를 건너뛸지 판단 (기획서 04장)
    @staticmethod
    def services_build_image_exists(image_tag:str) -> bool:
        try:
            proc_run(["docker", "image", "inspect", image_tag], timeout=30)
            return True
        except Proc_Error:
            return False


    # 로컬 이미지 삭제 - 실패해도 무시
    @staticmethod
    def services_build_remove_local(image_tags:list[str]) -> None:
        for image_tag in image_tags:
            try:
                proc_run(["docker", "image", "rm", image_tag], timeout=60)
            except Exception:
                pass
