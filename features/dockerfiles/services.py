import re
import json
import hashlib
from pathlib import Path

from shared.settings import settings
from shared.llm import LLM_Client, LLM_Unavailable

from features.repos.scheme import Repo_App, Repo_Collect
from features.repos.services import Repo_Service

from features.dockerfiles.scheme import Dockerfile_Fill, Dockerfile_Raw, Dockerfile_Result


TEMPLATE_DIR=Path(__file__).parent / "templates"

VERSION_PATTERN=re.compile(r"^[0-9]+(?:\.[0-9]+){0,2}$")
PACKAGE_PATTERN=re.compile(r"^[a-z0-9][a-z0-9.+\-]*$")

DEFAULT_DOCKERIGNORE="\n".join([
    ".git", "node_modules", ".venv", "venv", "__pycache__", "*.pyc",
    ".env", ".env.*", "*.pem", "*.key", ".idea", ".vscode", "",
])

SYSTEM_FILL="""너는 컨테이너 배포 도구의 일부다. 레포 요약을 보고 Dockerfile 템플릿의 빈칸만 채운다.
- 시작 명령은 반드시 0.0.0.0 에 바인딩하고, port 와 같은 포트를 쓴다.
- 개발 서버(--reload, nodemon, vite dev)는 쓰지 않는다.
- 모든 명령은 한 줄이다. 줄바꿈과 주석을 넣지 않는다.
- 레포에 없는 파일이나 스크립트를 가정하지 않는다.
- 환경변수 값, 비밀 값을 추측해서 넣지 않는다."""

SYSTEM_RAW="""너는 컨테이너 배포 도구의 일부다. 레포 요약을 보고 Dockerfile 전체를 쓴다.
- linux/amd64 에서 빌드된다. 멀티스테이지로 최종 이미지를 작게 만든다.
- 서버는 0.0.0.0 에 바인딩하고 EXPOSE 와 같은 포트를 쓴다.
- 레포에 없는 파일을 COPY 하지 않는다. 비밀 값을 넣지 않는다.
- Dockerfile 본문만 쓴다. 마크다운 코드블록 표시를 넣지 않는다."""

SYSTEM_FIX="""너는 컨테이너 배포 도구의 일부다. 빌드에 실패한 Dockerfile과 빌드 로그를 보고 Dockerfile을 고친다.
- 로그에 나온 원인만 고친다. 관계없는 부분은 그대로 둔다.
- 사용자 소스코드는 고칠 수 없다. Dockerfile 안에서 해결한다.
- Dockerfile 본문만 쓴다. 마크다운 코드블록 표시를 넣지 않는다.
- reason 에는 무엇을 왜 고쳤는지 한국어로 쓴다."""


class Dockerfile_Service:

    # Dockerfile 생성 - 정식은 템플릿+빈칸, 실험은 LLM 순수 생성 (기획서 02장)
    @staticmethod
    async def services_dockerfile_generate(app_path:Path, detect:Repo_App, repo_url:str, commit_sha:str) -> Dockerfile_Result:
        # 레포에 Dockerfile이 이미 있으면 그대로 쓴다 - 사용자 의도가 우선
        if detect.has_dockerfile:
            return Dockerfile_Service.services_dockerfile_from_repo(app_path)

        # 같은 레포·커밋이면 다시 묻지 않는다 (기획서 05장)
        cache_key=Dockerfile_Service.services_dockerfile_cache_key(repo_url, commit_sha, detect.app_dir)
        cached=Dockerfile_Service.services_dockerfile_cache_get(cache_key)
        if cached:
            return cached

        collect=Repo_Service.services_repo_collect(app_path, detect)

        if detect.support_level == "official":
            result=await Dockerfile_Service.services_dockerfile_official(app_path, detect, collect)
        else:
            result=await Dockerfile_Service.services_dockerfile_experimental(detect, collect)

        Dockerfile_Service.services_dockerfile_cache_set(cache_key, result)
        return result


    # 정식 지원 - LLM이 빈칸을 채우고, 안 되면 규칙으로 채운다
    @staticmethod
    async def services_dockerfile_official(app_path:Path, detect:Repo_App, collect:Repo_Collect) -> Dockerfile_Result:
        try:
            fill=await LLM_Client.llm_parse(
                SYSTEM_FILL,
                Dockerfile_Service.services_dockerfile_prompt(detect, collect),
                Dockerfile_Fill,
            )
            source="template_llm"
            reason=""

        except LLM_Unavailable as e:
            fill=Dockerfile_Service.services_dockerfile_fill_by_rule(app_path, detect, collect)
            source="template_rule"
            reason=f"LLM을 쓸 수 없어 규칙으로 채웠습니다 ({e})"

        dockerfile=Dockerfile_Service.services_dockerfile_render(detect.language, fill)

        return Dockerfile_Result(dockerfile=dockerfile, port=fill.port,
                                 health_check_path=fill.health_check_path, source=source, reason=reason)


    # 실험 지원 - LLM 순수 생성. LLM이 없으면 시도할 방법이 없다
    @staticmethod
    async def services_dockerfile_experimental(detect:Repo_App, collect:Repo_Collect) -> Dockerfile_Result:
        try:
            raw=await LLM_Client.llm_parse(
                SYSTEM_RAW,
                Dockerfile_Service.services_dockerfile_prompt(detect, collect),
                Dockerfile_Raw,
            )

        except LLM_Unavailable as e:
            raise ValueError(f"{detect.language}는 실험 지원 언어라 LLM이 필요합니다 ({e})")

        dockerfile=Dockerfile_Service.services_dockerfile_check_raw(raw.dockerfile)

        return Dockerfile_Result(dockerfile=dockerfile, port=raw.port,
                                 health_check_path=raw.health_check_path, source="llm_raw", reason=raw.reason)


    # 빌드 실패 자가수정 - 우리가 만든 파일만 고친다 (기획서 03장)
    @staticmethod
    async def services_dockerfile_fix(current:Dockerfile_Result, build_log:str, detect:Repo_App) -> Dockerfile_Result:
        prompt="\n".join([
            f"언어: {detect.language}",
            "",
            "## 현재 Dockerfile",
            current.dockerfile,
            "",
            "## 빌드 로그 (마지막 부분)",
            build_log[-6000:],
        ])

        raw=await LLM_Client.llm_parse(SYSTEM_FIX, prompt, Dockerfile_Raw)
        dockerfile=Dockerfile_Service.services_dockerfile_check_raw(raw.dockerfile)

        return Dockerfile_Result(dockerfile=dockerfile, port=raw.port or current.port,
                                 health_check_path=raw.health_check_path or current.health_check_path,
                                 source="llm_fix", reason=raw.reason)


    # 레포에 있는 Dockerfile 사용 - EXPOSE에서 포트를 읽는다
    @staticmethod
    def services_dockerfile_from_repo(app_path:Path) -> Dockerfile_Result:
        dockerfile=Repo_Service.services_repo_read_text(app_path / "Dockerfile")

        match=re.search(r"(?im)^\s*EXPOSE\s+(\d+)", dockerfile)
        port=int(match.group(1)) if match else 80

        return Dockerfile_Result(dockerfile=dockerfile, port=port, source="repo",
                                 reason="레포에 있는 Dockerfile을 그대로 사용했습니다.")


    # LLM에 보낼 본문 - 트리·매니페스트·진입점만
    @staticmethod
    def services_dockerfile_prompt(detect:Repo_App, collect:Repo_Collect) -> str:
        parts=[
            f"언어: {detect.language}",
            f"매니페스트: {detect.manifest}",
            "",
            "## 디렉터리 트리",
            collect.tree,
            "",
            f"## {collect.manifest.path}",
            collect.manifest.content,
        ]

        for entry in collect.entry_files:
            parts+=["", f"## {entry.path}", entry.content]

        return "\n".join(parts)


    # 빈칸 값 검증 - LLM 출력이 그대로 Dockerfile에 들어가므로 한 줄·허용 문자만
    @staticmethod
    def services_dockerfile_check_fill(fill:Dockerfile_Fill) -> Dockerfile_Fill:
        def one_line(value:str|None) -> str|None:
            if value is None:
                return None
            value=" ".join(value.split())
            return value or None

        if not VERSION_PATTERN.match(fill.runtime_version.strip()):
            raise ValueError(f"베이스 이미지 버전이 올바르지 않습니다 :{fill.runtime_version}")

        if not 1 <= fill.port <= 65535:
            raise ValueError(f"포트가 올바르지 않습니다 :{fill.port}")

        packages=[p.strip().lower() for p in fill.system_packages if p.strip()]
        for package in packages:
            if not PACKAGE_PATTERN.match(package):
                raise ValueError(f"시스템 패키지 이름이 올바르지 않습니다 :{package}")

        install_command=one_line(fill.install_command)
        start_command=one_line(fill.start_command)
        if not install_command or not start_command:
            raise ValueError("설치 명령과 시작 명령은 비어 있을 수 없습니다.")

        health_check_path=fill.health_check_path.strip() or "/"
        if not health_check_path.startswith("/") or " " in health_check_path:
            health_check_path="/"

        return Dockerfile_Fill(
            runtime_version=fill.runtime_version.strip(),
            system_packages=packages,
            install_command=install_command,
            build_command=one_line(fill.build_command),
            start_command=start_command,
            port=fill.port,
            health_check_path=health_check_path,
        )


    # 템플릿 렌더링
    @staticmethod
    def services_dockerfile_render(language:str, fill:Dockerfile_Fill) -> str:
        fill=Dockerfile_Service.services_dockerfile_check_fill(fill)
        template=(TEMPLATE_DIR / f"{language}.Dockerfile").read_text(encoding="utf-8")

        system_packages_block=""
        if fill.system_packages:
            system_packages_block=(
                "RUN apt-get update && apt-get install -y --no-install-recommends "
                + " ".join(fill.system_packages)
                + " && rm -rf /var/lib/apt/lists/*\n"
            )

        build_block=f"RUN {fill.build_command}\n" if fill.build_command else ""

        dockerfile=template.format(
            runtime_version=fill.runtime_version,
            port=fill.port,
            system_packages_block=system_packages_block,
            install_command=fill.install_command,
            build_block=build_block,
            cmd_json=json.dumps(["sh", "-c", fill.start_command], ensure_ascii=False),
        )

        # 빈 블록이 남긴 연속 빈 줄 정리
        return re.sub(r"\n{3,}", "\n\n", dockerfile)


    # LLM이 쓴 Dockerfile 전체 검증
    @staticmethod
    def services_dockerfile_check_raw(dockerfile:str) -> str:
        dockerfile=dockerfile.strip()

        # 코드블록 표시가 섞여 오면 벗긴다
        if dockerfile.startswith("```"):
            dockerfile=re.sub(r"^```[a-zA-Z]*\n", "", dockerfile)
            dockerfile=re.sub(r"\n```$", "", dockerfile).strip()

        if not re.search(r"(?im)^\s*FROM\s+\S+", dockerfile):
            raise ValueError("생성된 Dockerfile에 FROM 이 없습니다.")

        return dockerfile + "\n"


    # 규칙 기반 빈칸 채우기 - LLM 없이도 정식 언어는 끝까지 간다
    @staticmethod
    def services_dockerfile_fill_by_rule(app_path:Path, detect:Repo_App, collect:Repo_Collect) -> Dockerfile_Fill:
        if detect.language == "python":
            return Dockerfile_Service.services_dockerfile_rule_python(app_path, detect, collect)
        return Dockerfile_Service.services_dockerfile_rule_node(app_path, collect)


    # 규칙 - Python
    @staticmethod
    def services_dockerfile_rule_python(app_path:Path, detect:Repo_App, collect:Repo_Collect) -> Dockerfile_Fill:
        manifest=collect.manifest.content.lower()
        entry_paths=[entry.path for entry in collect.entry_files]

        version="3.12"
        version_file=app_path / ".python-version"
        if version_file.is_file():
            found=re.match(r"\s*(\d+\.\d+)", version_file.read_text(encoding="utf-8", errors="replace"))
            if found:
                version=found.group(1)

        system_packages=[]
        if "mysqlclient" in manifest:
            system_packages=["build-essential", "default-libmysqlclient-dev", "pkg-config"]
        elif "psycopg2" in manifest and "psycopg2-binary" not in manifest:
            system_packages=["build-essential", "libpq-dev"]

        install_command="pip install --no-cache-dir -r requirements.txt"
        if detect.manifest == "pyproject.toml":
            install_command="pip install --no-cache-dir ."

        port=8000
        start_command="python main.py"

        if "fastapi" in manifest or "uvicorn" in manifest or "starlette" in manifest:
            module="main"
            for entry in collect.entry_files:
                if re.search(r"=\s*FastAPI\(", entry.content):
                    module=entry.path.removesuffix(".py").replace("/", ".")
                    break
            start_command=f"uvicorn {module}:app --host 0.0.0.0 --port {port}"

        elif "django" in manifest and "manage.py" in entry_paths:
            start_command=f"python manage.py runserver 0.0.0.0:{port}"

        elif "flask" in manifest:
            start_command=f"flask run --host=0.0.0.0 --port={port}"

        elif entry_paths:
            start_command=f"python {entry_paths[0]}"

        return Dockerfile_Fill(runtime_version=version, system_packages=system_packages,
                               install_command=install_command, start_command=start_command, port=port)


    # 규칙 - Node.js
    @staticmethod
    def services_dockerfile_rule_node(app_path:Path, collect:Repo_Collect) -> Dockerfile_Fill:
        try:
            package=json.loads(collect.manifest.content)
        except Exception:
            package={}

        scripts=package.get("scripts") or {}
        dependencies={**(package.get("dependencies") or {}), **(package.get("devDependencies") or {})}

        version="22"
        found=re.search(r"(\d{2})", str((package.get("engines") or {}).get("node", "")))
        if found:
            version=found.group(1)

        # 빌드에 devDependencies가 필요하므로 --omit=dev 는 쓰지 않는다
        install_command="npm ci --include=dev" if (app_path / "package-lock.json").is_file() else "npm install --include=dev"
        build_command="npm run build" if scripts.get("build") else None

        port=3000
        if scripts.get("start"):
            start_command="npm start"
        elif "vite" in dependencies:
            start_command=f"npx vite preview --host 0.0.0.0 --port {port}"
        else:
            start_command=f"node {package.get('main') or 'index.js'}"

        return Dockerfile_Fill(runtime_version=version, install_command=install_command,
                               build_command=build_command, start_command=start_command, port=port)


    # Dockerfile과 .dockerignore를 빌드 폴더에 쓴다
    @staticmethod
    def services_dockerfile_write(app_path:Path, result:Dockerfile_Result) -> Path:
        dockerfile_path=app_path / "Dockerfile"

        if result.source != "repo":
            dockerfile_path.write_text(result.dockerfile, encoding="utf-8", newline="\n")

        dockerignore_path=app_path / ".dockerignore"
        if not dockerignore_path.is_file():
            dockerignore_path.write_text(DEFAULT_DOCKERIGNORE, encoding="utf-8", newline="\n")

        return dockerfile_path


    # 캐시 키
    @staticmethod
    def services_dockerfile_cache_key(repo_url:str, commit_sha:str, app_dir:str) -> str:
        return hashlib.sha256(f"{repo_url}|{commit_sha}|{app_dir}".encode("utf-8")).hexdigest()[:32]


    # 캐시 조회
    @staticmethod
    def services_dockerfile_cache_get(cache_key:str) -> Dockerfile_Result|None:
        path=settings.cache_path / f"dockerfile_{cache_key}.json"

        if not path.is_file():
            return None

        try:
            result=Dockerfile_Result.model_validate_json(path.read_text(encoding="utf-8"))
            result.cached=True
            return result
        except Exception:
            return None


    # 캐시 저장 - 규칙으로 채운 결과는 저장하지 않는다 (LLM이 돌아오면 다시 묻도록)
    @staticmethod
    def services_dockerfile_cache_set(cache_key:str, result:Dockerfile_Result) -> None:
        if result.source == "template_rule":
            return

        settings.cache_path.mkdir(parents=True, exist_ok=True)
        path=settings.cache_path / f"dockerfile_{cache_key}.json"
        path.write_text(result.model_dump_json(), encoding="utf-8")
