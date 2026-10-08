import re
import os
import json
import stat
import shutil
import fnmatch
from pathlib import Path

from shared.proc import proc_run, Proc_Error

from features.repos.scheme import Repo_App, Repo_Detect, Repo_File, Repo_Collect, Repo_Remote


# 레포 주소는 사용자 입력이다 - https github 주소만 받는다
REPO_URL_PATTERN=re.compile(r"^https://github\.com/[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+?(?:\.git)?/?$")
BRANCH_PATTERN=re.compile(r"^[A-Za-z0-9._/\-]{1,100}$")

# 매니페스트 -> (언어, 지원 층) (기획서 02장)
MANIFEST_RULES=[
    ("requirements.txt", "python", "official"),
    ("pyproject.toml", "python", "official"),
    ("package.json", "node", "official"),
    ("pom.xml", "java", "experimental"),
    ("build.gradle", "java", "experimental"),
    ("build.gradle.kts", "java", "experimental"),
    ("go.mod", "go", "experimental"),
    ("composer.json", "php", "experimental"),
    ("Gemfile", "ruby", "experimental"),
    ("Cargo.toml", "rust", "experimental"),
]

# 제외 필터 - LLM에 보내지도, 트리에 넣지도 않는다
EXCLUDE_DIRS={".git", "node_modules", ".venv", "venv", "env", "__pycache__", "dist", "build",
              ".next", ".nuxt", "target", "vendor", ".idea", ".vscode", "android", "ios"}
EXCLUDE_FILES=[".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore",
               "id_rsa*", "id_ed25519*", "credentials*", "secrets.*", "*.pyc"]

# 서버 앱일 가능성이 높은 폴더 이름
BACKEND_DIR_NAMES={"backend", "server", "api", "app", "back"}

ENTRY_CANDIDATES={
    "python": ["main.py", "app.py", "manage.py", "wsgi.py", "asgi.py", "app/main.py", "src/main.py", "server.py"],
    "node": ["index.js", "server.js", "app.js", "src/index.js", "src/server.js", "src/index.ts", "src/main.ts"],
}

FILE_LIMIT=12000
TREE_DEPTH=3


class Repo_Service:

    # 레포 주소 검증
    @staticmethod
    def services_repo_check_url(repo_url:str) -> str:
        repo_url=repo_url.strip()

        if not REPO_URL_PATTERN.match(repo_url):
            raise ValueError("https://github.com/소유자/레포 형식의 주소만 받습니다.")

        return repo_url.rstrip("/")


    # 브랜치 이름 검증
    @staticmethod
    def services_repo_check_branch(branch:str|None) -> str|None:
        if not branch:
            return None

        if not BRANCH_PATTERN.match(branch) or branch.startswith("-") or ".." in branch:
            raise ValueError("브랜치 이름이 올바르지 않습니다.")

        return branch


    # 레포 주소 -> 서비스 이름 재료 (소문자, 영숫자와 -)
    @staticmethod
    def services_repo_slug(repo_url:str) -> str:
        name=repo_url.rstrip("/").removesuffix(".git").split("/")[-1].lower()
        slug=re.sub(r"[^a-z0-9]+", "-", name).strip("-")
        return slug[:24] or "app"


    # GitHub 설치 토큰이 있으면 git 주소에 심는다 (M6) - 로그에는 절대 안 쓴다. repo_url은 그대로 유지
    @staticmethod
    def services_repo_auth_url(repo_url:str, token:str|None) -> str:
        if not token:
            return repo_url
        return repo_url.replace("https://", f"https://x-access-token:{token}@", 1)


    # 브랜치 목록과 기본 브랜치 조회 - API 없이 git 프로토콜로 (기획서 03장)
    @staticmethod
    def services_repo_remote(repo_url:str, token:str|None=None) -> Repo_Remote:
        repo_url=Repo_Service.services_repo_check_url(repo_url)
        auth_url=Repo_Service.services_repo_auth_url(repo_url, token)

        output=proc_run(["git", "ls-remote", "--symref", auth_url, "HEAD"], timeout=60)
        default_branch=None
        for line in output.splitlines():
            if line.startswith("ref:"):
                default_branch=line.split()[1].removeprefix("refs/heads/")

        output=proc_run(["git", "ls-remote", "--heads", auth_url], timeout=60)
        branches=[line.split("refs/heads/", 1)[1] for line in output.splitlines() if "refs/heads/" in line]

        return Repo_Remote(default_branch=default_branch, branches=branches)


    # 대상 브랜치의 최신 커밋 해시 한 줄만 받는다 (폴링·캐시 키)
    @staticmethod
    def services_repo_commit_sha(repo_url:str, branch:str|None, token:str|None=None) -> str|None:
        repo_url=Repo_Service.services_repo_check_url(repo_url)
        auth_url=Repo_Service.services_repo_auth_url(repo_url, token)
        ref=f"refs/heads/{branch}" if branch else "HEAD"

        output=proc_run(["git", "ls-remote", auth_url, ref], timeout=60)
        for line in output.splitlines():
            if line.strip():
                return line.split()[0]

        return None


    # 레포 클론 (얕은 복제)
    @staticmethod
    def services_repo_clone(repo_url:str, branch:str|None, dest:Path, on_line=None, token:str|None=None) -> str:
        repo_url=Repo_Service.services_repo_check_url(repo_url)
        branch=Repo_Service.services_repo_check_branch(branch)
        auth_url=Repo_Service.services_repo_auth_url(repo_url, token)

        # git의 .git/objects 읽기 전용 파일 때문에 Windows에서 rmtree가 조용히 실패하고 남는 걸 막는다
        def clear_readonly(func, path, exc):
            os.chmod(path, stat.S_IWRITE)
            func(path)

        if dest.exists():
            shutil.rmtree(dest, onexc=clear_readonly)
        dest.parent.mkdir(parents=True, exist_ok=True)

        args=["git", "clone", "--depth", "1", "--single-branch"]
        if branch:
            args+=["--branch", branch]
        args+=["--", auth_url, str(dest)]

        proc_run(args, timeout=300, on_line=on_line)

        # 토큰이 붙은 주소가 .git/config 에 남지 않게 원래 주소로 되돌린다 (설계 제약 6)
        # 레포가 자기 .dockerignore 를 갖고 있고 .git 을 빼지 않았으면 빌드 때 토큰이 이미지에 딸려 들어갈 수 있다
        if token:
            proc_run(["git", "remote", "set-url", "origin", repo_url], cwd=str(dest), timeout=30)

        return proc_run(["git", "rev-parse", "HEAD"], cwd=str(dest), timeout=30).strip()


    # 제외 대상인지
    @staticmethod
    def services_repo_is_excluded(path:Path) -> bool:
        if path.is_dir():
            return path.name in EXCLUDE_DIRS
        return any(fnmatch.fnmatch(path.name.lower(), pattern.lower()) for pattern in EXCLUDE_FILES)


    # 언어 판별 - 규칙만 쓴다. 결정적이고 빠르고 공짜 (기획서 02장)
    @staticmethod
    def services_repo_detect(repo_path:Path) -> Repo_Detect:
        apps:list[tuple[tuple, Repo_App]]=[]

        # 루트와 그 아래 2단계까지만 본다
        dirs=[repo_path]
        level=[repo_path]
        for _ in range(2):
            next_level=[]
            for base in level:
                for child in sorted(base.iterdir()):
                    if child.is_dir() and not Repo_Service.services_repo_is_excluded(child) and not child.name.startswith("."):
                        next_level.append(child)
            dirs+=next_level
            level=next_level

        for app_dir in dirs:
            for manifest, language, support_level in MANIFEST_RULES:
                if not (app_dir / manifest).is_file():
                    continue

                rel="." if app_dir == repo_path else app_dir.relative_to(repo_path).as_posix()
                depth=0 if rel == "." else rel.count("/") + 1

                # 스크립트도 진입점도 없는 package.json은 앱이 아니라 의존성 메모일 뿐이다
                weak=manifest == "package.json" and Repo_Service.services_repo_is_weak_package(app_dir / manifest)
                backend_like=app_dir.name.lower() in BACKEND_DIR_NAMES

                app=Repo_App(language=language, support_level=support_level, app_dir=rel, manifest=manifest,
                             has_dockerfile=(app_dir / "Dockerfile").is_file())
                apps.append(((weak, depth if not backend_like else depth - 1, language != "python"), app))
                break

        if not apps:
            raise ValueError("매니페스트 파일을 찾지 못했습니다. 지원하는 형식의 프로젝트가 아닙니다.")

        apps.sort(key=lambda item: item[0])
        main_app=apps[0][1]
        others=[app for key, app in apps[1:] if not key[0]]

        return Repo_Detect(**main_app.model_dump(), other_apps=others)


    # scripts.start / scripts.build / main 이 하나도 없는 package.json
    @staticmethod
    def services_repo_is_weak_package(manifest_path:Path) -> bool:
        try:
            data=json.loads(Repo_Service.services_repo_read_text(manifest_path))
        except Exception:
            return True

        scripts=data.get("scripts") or {}
        return not (scripts.get("start") or scripts.get("build") or data.get("main"))


    # 텍스트 읽기 - pip freeze를 PowerShell로 뽑으면 UTF-16이 된다
    @staticmethod
    def services_repo_read_text(path:Path) -> str:
        raw=path.read_bytes()

        if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
            return raw.decode("utf-16")

        if raw[:3] == b"\xef\xbb\xbf":
            return raw[3:].decode("utf-8", errors="replace")

        return raw.decode("utf-8", errors="replace")


    # 클론한 사본을 빌드 가능하게 다듬는다 (사용자 레포는 건드리지 않는다)
    @staticmethod
    def services_repo_normalize(app_path:Path) -> list[str]:
        notes=[]

        requirements=app_path / "requirements.txt"
        if requirements.is_file():
            raw=requirements.read_bytes()
            if raw[:2] in (b"\xff\xfe", b"\xfe\xff") or raw[:3] == b"\xef\xbb\xbf":
                text=Repo_Service.services_repo_read_text(requirements)
                requirements.write_text(text.replace("\r\n", "\n"), encoding="utf-8", newline="\n")
                notes.append("requirements.txt 인코딩을 UTF-8로 변환했습니다.")

        return notes


    # 디렉터리 트리 (TREE_DEPTH 단계까지)
    @staticmethod
    def services_repo_tree(app_path:Path) -> str:
        lines=[]

        def walk(base:Path, depth:int):
            if depth > TREE_DEPTH:
                return
            for child in sorted(base.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
                if Repo_Service.services_repo_is_excluded(child):
                    continue
                lines.append(f"{'  ' * (depth - 1)}{child.name}{'/' if child.is_dir() else ''}")
                if child.is_dir():
                    walk(child, depth + 1)

        walk(app_path, 1)
        return "\n".join(lines[:400])


    # LLM에 보낼 것만 모은다 - 트리, 매니페스트, 진입점 1~2개 (기획서 02장)
    @staticmethod
    def services_repo_collect(app_path:Path, detect:Repo_App) -> Repo_Collect:
        def read_file(path:Path) -> Repo_File:
            content=Repo_Service.services_repo_read_text(path)
            if len(content) > FILE_LIMIT:
                content=content[:FILE_LIMIT] + "\n... (이하 생략)"
            return Repo_File(path=path.relative_to(app_path).as_posix(), content=content)

        manifest=read_file(app_path / detect.manifest)

        candidates=list(ENTRY_CANDIDATES.get(detect.language, []))
        if detect.manifest == "package.json":
            try:
                main=json.loads(manifest.content).get("main")
                if main:
                    candidates.insert(0, main)
            except Exception:
                pass

        entry_files=[]
        for name in candidates:
            path=app_path / name
            if path.is_file() and not Repo_Service.services_repo_is_excluded(path):
                entry_files.append(read_file(path))
            if len(entry_files) >= 2:
                break

        return Repo_Collect(tree=Repo_Service.services_repo_tree(app_path), manifest=manifest, entry_files=entry_files)
