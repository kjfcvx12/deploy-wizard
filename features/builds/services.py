import base64
import os
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


    # 그 폴더에 docker 자격 증명 도우미(docker-credential-*)가 있는지
    @staticmethod
    def services_build_has_credential_helper(directory:str) -> bool:
        try:
            return any(Path(directory).glob("docker-credential-*"))
        except OSError:
            return False


    # 로그인·푸시용 docker 환경 -전용 설정 폴더를 쓴다. 전역 자격 증명 저장소(Windows의 desktop)는 ECR 토큰이 길어 저장에 실패한다
    @staticmethod
    def services_build_docker_env() -> dict[str, str]:
        config_dir=settings.docker_auth_path
        config_dir.mkdir(parents=True, exist_ok=True)
        (config_dir / "config.json").write_text('{"auths": {}}', encoding="utf-8")

        env=dict(os.environ)
        env["DOCKER_CONFIG"]=str(config_dir)

        # docker 는 credsStore 가 비어 있어도 PATH 에서 docker-credential-* 을 찾아 기본 저장소로 쓴다 - 이 명령들의 PATH 에서만 뺀다
        env["PATH"]=os.pathsep.join(p for p in env.get("PATH", "").split(os.pathsep) if p and not Build_Service.services_build_has_credential_helper(p))

        # 설정 폴더를 바꾸면 현재 context(desktop-linux 등)를 잃으므로 엔진 주소를 직접 넘긴다
        if not env.get("DOCKER_HOST"):
            try:
                lines=proc_run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], timeout=30).splitlines()
                if lines and lines[-1].strip():
                    env["DOCKER_HOST"]=lines[-1].strip()
            except Proc_Error:
                pass

        return env


    # ECR 로그인 - 토큰은 12시간이면 만료된다. 매번 새로 받는다 (기획서 06장)
    @staticmethod
    def services_build_login(session:boto3.Session, env:dict[str, str]|None=None) -> str:
        ecr=session.client("ecr")

        auth=ecr.get_authorization_token()["authorizationData"][0]
        username, password=base64.b64decode(auth["authorizationToken"]).decode("utf-8").split(":", 1)
        registry=auth["proxyEndpoint"].removeprefix("https://")

        # 비밀번호는 인자가 아니라 stdin으로 넘긴다 (프로세스 목록·로그에 남지 않게)
        try:
            proc_run(["docker", "login", "--username", username, "--password-stdin", registry],
                     timeout=60, stdin_text=password, env=env)
        except Proc_Error as e:
            # 실패 이유(출력)를 메시지에 남긴다 - 이것 없이는 원인을 알 수 없다
            raise Proc_Error(f"ECR 로그인 실패 :{e.output[-300:]}", e.output)

        return registry


    # 태그 붙여서 푸시 -> 배포에 쓸 이미지 주소
    @staticmethod
    def services_build_push(session:boto3.Session, image_tag:str, repository_name:str, version:str,
                            on_line:Callable[[str], None]|None=None) -> str:
        repository_uri=Build_Service.services_build_ensure_repository(session, repository_name)
        env=Build_Service.services_build_docker_env()
        Build_Service.services_build_login(session, env)

        image_uri=f"{repository_uri}:{version}"

        proc_run(["docker", "tag", image_tag, image_uri], timeout=60, env=env)
        proc_run(["docker", "push", image_uri], timeout=1800, on_line=on_line, env=env)

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
