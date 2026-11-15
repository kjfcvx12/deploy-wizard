import re
import ast
import json
import logging
import fnmatch
import asyncio
import tomllib
from pathlib import Path
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import HTTPException, status

from features.advice.scheme import Advice_Request, Advice_Need, Advice_Cost, Advice_Signals, Deploy_Advice
from features.accounts.services import Github_Service
from features.envvars.scheme import Env_Found
from features.envvars.services import Env_Service
from features.pricing.services import Pricing_Service
from features.repos.scheme import Repo_App
from features.repos.services import Repo_Service, EXCLUDE_DIRS
from shared.masking import mask_text
from shared.settings import settings

logger=logging.getLogger(__name__)


# 무거운 라이브러리 -> 수준 large (기획서 I절)
HEAVY_LIBS={
    "python": {"torch", "tensorflow", "opencv-python", "opencv-python-headless", "pandas", "numpy", "scipy",
               "scikit-learn", "transformers"},
    "node": {"puppeteer", "playwright", "sharp", "@tensorflow/tfjs-node"},
}
DB_LIBS={
    "python": {"sqlalchemy", "psycopg2", "psycopg2-binary", "psycopg", "pymysql", "mysqlclient", "pymongo", "asyncpg"},
    "node": {"prisma", "@prisma/client", "mongoose", "pg", "mysql2", "typeorm", "sequelize"},
}
CACHE_LIBS={"redis", "ioredis", "aioredis"}
WORKER_LIBS={"celery", "rq", "bull", "bullmq"}

DEP_COUNT_LIMIT=40
UNSUPPORTED_MESSAGE="마법사가 아직 만들어 주지 못합니다"
DISK_WRITE_MESSAGE="디스크에 쓴 파일은 서비스가 다시 시작되면 사라집니다"

# 디스크에 파일을 쓰는 코드 흔적 - 파이썬은 open 의 쓰기 모드(ast 로 확인)와 write_text, 노드는 fs.writeFile 계열
PY_WRITE_PATTERN=re.compile(r"\.write_text\s*\(|\.write_bytes\s*\(")
JS_WRITE_PATTERN=re.compile(r"\bfs(?:\.promises)?\.(?:writeFile|writeFileSync|appendFile|appendFileSync)\s*\(|\bcreateWriteStream\s*\(")
WRITE_MODE_CHARS=set("wax+")
SOURCE_SUFFIXES={".py", ".js", ".mjs", ".cjs", ".ts"}
SKIP_SOURCE_DIRS={"test", "tests", "__tests__", "spec"}
TEST_FILE_PATTERNS=["test_*.py", "*_test.py", "*.test.*", "*.spec.*"]
SOURCE_FILE_LIMIT=400
SOURCE_SIZE_LIMIT=200_000

ADVICE_CACHE_LIMIT=100


class Advice_Service:

    # (repo_url, commit_sha) -> 분석 결과. 같은 커밋은 다시 클론하지 않는다
    ADVICE_CACHE:dict[tuple[str, str], Deploy_Advice]={}


    # 의존성 이름 정리 - 소문자, 밑줄은 하이픈
    @staticmethod
    def services_advice_norm_name(name:str) -> str:
        return name.strip().lower().replace("_", "-")


    # 파이썬 의존성 이름 목록 - requirements.txt 또는 pyproject.toml
    @staticmethod
    def services_advice_python_deps(app_path:Path, manifest:str) -> list[str]:
        names=[]
        path=app_path / manifest

        if manifest == "requirements.txt":
            for line in Repo_Service.services_repo_read_text(path).splitlines():
                line=line.split("#", 1)[0].strip()
                if not line or line.startswith("-"):
                    continue
                found=re.match(r"[A-Za-z0-9][A-Za-z0-9_.\-]*", line)
                if found:
                    names.append(found.group(0))

        elif manifest == "pyproject.toml":
            data=tomllib.loads(Repo_Service.services_repo_read_text(path))
            for item in (data.get("project") or {}).get("dependencies") or []:
                found=re.match(r"[A-Za-z0-9][A-Za-z0-9_.\-]*", item.strip())
                if found:
                    names.append(found.group(0))
            poetry=((data.get("tool") or {}).get("poetry") or {}).get("dependencies") or {}
            names+=[name for name in poetry if name.lower() != "python"]

        return [Advice_Service.services_advice_norm_name(name) for name in names]


    # 노드 package.json 읽기 - 의존성 이름 목록과 scripts
    @staticmethod
    def services_advice_node_package(app_path:Path, manifest:str) -> tuple[list[str], dict]:
        data=json.loads(Repo_Service.services_repo_read_text(app_path / manifest))
        deps=list((data.get("dependencies") or {}).keys()) + list((data.get("devDependencies") or {}).keys())
        return [name.lower() for name in deps], data.get("scripts") or {}


    # 정적 사이트인지 - build 스크립트만 있고 start 가 없으며 Vite/CRA/Next export 표식이 있을 때
    @staticmethod
    def services_advice_is_static(app_path:Path, deps:list[str], scripts:dict) -> bool:
        if not scripts.get("build") or scripts.get("start"):
            return False

        if "vite" in deps or "react-scripts" in deps:
            return True

        if "next export" in str(scripts.get("build")):
            return True

        if "next" in deps:
            for config in app_path.glob("next.config.*"):
                if re.search(r"""output\s*:\s*["']export["']""", Repo_Service.services_repo_read_text(config)):
                    return True

        return False


    # 파이썬 코드에서 open(경로, 쓰기모드) 호출이 있는지 - 모드는 두 번째 인자 또는 mode= 만 본다
    @staticmethod
    def services_advice_py_open_write(text:str) -> bool:
        try:
            tree=ast.parse(text)
        except Exception:
            # 문법 오류뿐 아니라 너무 깊은 식(RecursionError·MemoryError)도 쓰기 없음으로 본다
            return False

        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "open"):
                continue

            modes=[node.args[1]] if len(node.args) > 1 else []
            modes+=[kw.value for kw in node.keywords if kw.arg == "mode"]
            for mode in modes:
                if isinstance(mode, ast.Constant) and isinstance(mode.value, str) and WRITE_MODE_CHARS & set(mode.value):
                    return True

        return False


    # 소스 한 파일이 디스크에 쓰는지
    @staticmethod
    def services_advice_file_writes(path:Path, text:str) -> bool:
        if path.suffix == ".py":
            return Advice_Service.services_advice_py_open_write(text) or bool(PY_WRITE_PATTERN.search(text))
        return bool(JS_WRITE_PATTERN.search(text))


    # 코드가 앱 폴더에 파일을 쓰는지 - 소스 일부만 훑는다 (테스트·제외 폴더·심볼릭 링크는 건너뜀)
    @staticmethod
    def services_advice_has_disk_write(app_path:Path) -> bool:
        seen=0
        stack=[app_path]

        while stack:
            base=stack.pop()
            try:
                children=sorted(base.iterdir())
            except OSError:
                continue

            for child in children:
                # 신뢰할 수 없는 레포라 링크는 따라가지 않는다
                if child.is_symlink():
                    continue

                if child.is_dir():
                    if child.name in EXCLUDE_DIRS or child.name.lower() in SKIP_SOURCE_DIRS or child.name.startswith("."):
                        continue
                    stack.append(child)
                    continue

                if child.suffix not in SOURCE_SUFFIXES or Repo_Service.services_repo_is_excluded(child):
                    continue
                if any(fnmatch.fnmatch(child.name.lower(), pattern) for pattern in TEST_FILE_PATTERNS):
                    continue

                try:
                    if child.stat().st_size > SOURCE_SIZE_LIMIT:
                        continue

                    seen+=1
                    if seen > SOURCE_FILE_LIMIT:
                        return False

                    text=Repo_Service.services_repo_read_text(child)
                except (OSError, ValueError):
                    continue

                if Advice_Service.services_advice_file_writes(child, text):
                    return True

        return False


    # 신호 수집 - 규칙만 쓴다. AI 호출 없음 (기획서 I절)
    @staticmethod
    def services_advice_signals(app_path:Path, detect:Repo_App, envs:list[Env_Found]) -> Advice_Signals:
        language=detect.language
        deps:list[str]=[]
        scripts:dict={}
        parsed=(app_path / detect.manifest).is_file()

        if parsed:
            try:
                if language == "python":
                    deps=Advice_Service.services_advice_python_deps(app_path, detect.manifest)
                elif language == "node":
                    deps, scripts=Advice_Service.services_advice_node_package(app_path, detect.manifest)
            except Exception:
                parsed=False

        heavy=sorted(set(deps) & HEAVY_LIBS.get(language, set()))
        db=sorted(set(deps) & DB_LIBS.get(language, set()))
        cache=sorted(set(deps) & CACHE_LIBS)
        worker=sorted(set(deps) & WORKER_LIBS)
        static_site=language == "node" and parsed and Advice_Service.services_advice_is_static(app_path, deps, scripts)

        return Advice_Signals(dep_file_parsed=parsed, dep_count=len(set(deps)), heavy_libs=heavy, db_libs=db,
                              cache_libs=cache, worker_libs=worker, static_site=static_site,
                              disk_write=Advice_Service.services_advice_has_disk_write(app_path),
                              env_count=len(envs), manifest=detect.manifest)


    # 수준 판정 - 정적 사이트 small, 무거운 라이브러리 large, DB·캐시·워커·큰 의존성 medium, 나머지 small
    @staticmethod
    def services_advice_tier(signals:Advice_Signals) -> tuple[str, list[str]]:
        if signals.static_site:
            return "small", [f"서버 없이 정적 파일로 제공할 수 있는 사이트로 보여 작은 사양으로 충분합니다 ({signals.manifest})"]

        if signals.heavy_libs:
            return "large", [f"{', '.join(signals.heavy_libs)} 같은 무거운 라이브러리를 사용해 큰 사양으로 잡았습니다 ({signals.manifest})"]

        reasons=[]
        service_libs=signals.db_libs + signals.cache_libs + signals.worker_libs
        if service_libs:
            reasons.append(f"{', '.join(service_libs)} 라이브러리를 사용해 중간 사양으로 잡았습니다 ({signals.manifest})")
        if signals.dep_count > DEP_COUNT_LIMIT:
            reasons.append(f"의존성이 {signals.dep_count}개로 많아 중간 사양으로 잡았습니다 ({signals.manifest})")
        if reasons:
            return "medium", reasons

        return "small", ["무거운 라이브러리나 DB·캐시·워커가 보이지 않아 작은 사양으로 잡았습니다"]


    # 신호 -> 필요한 것 목록
    @staticmethod
    def services_advice_needs(signals:Advice_Signals) -> list[Advice_Need]:
        needs=[]
        if signals.db_libs:
            needs.append(Advice_Need(kind="database", supported=False, message=UNSUPPORTED_MESSAGE))
        if signals.cache_libs:
            needs.append(Advice_Need(kind="cache", supported=False, message=UNSUPPORTED_MESSAGE))
        if signals.worker_libs:
            needs.append(Advice_Need(kind="worker", supported=False, message=UNSUPPORTED_MESSAGE))
        if signals.env_count:
            needs.append(Advice_Need(kind="env_vars", supported=True, count=signals.env_count))
        if signals.disk_write:
            needs.append(Advice_Need(kind="disk_write", supported=False, message=DISK_WRITE_MESSAGE))
        if signals.static_site:
            needs.append(Advice_Need(kind="static_site", supported=True,
                                     message="서버 없이 정적 파일로 제공할 수 있는 사이트로 보입니다"))
        return needs


    # 조립 - 수준, 확신도, 필요한 것. 숫자(cpu·memory·비용)는 검증 전이라 비운다 (D10)
    @staticmethod
    def services_advice_build(signals:Advice_Signals, detect:Repo_App, envs:list[Env_Found], commit_sha:str|None) -> Deploy_Advice:
        tier, reasons=Advice_Service.services_advice_tier(signals)
        unknowns=[f"환경변수 {env.name}의 종류를 알 수 없습니다" for env in envs if env.kind == "unknown"]

        if not signals.dep_file_parsed or len(unknowns) >= 2:
            confidence="low"
        elif len(unknowns) == 1 or detect.support_level == "experimental":
            confidence="medium"
        else:
            confidence="high"

        return Deploy_Advice(tier=tier, confidence=confidence, cost=Advice_Cost(), reasons=reasons,
                             needs=Advice_Service.services_advice_needs(signals), unknowns=unknowns,
                             language=detect.language, support_level=detect.support_level,
                             app_dir=detect.app_dir, commit_sha=commit_sha)


    # 클론한 폴더 분석 - 언어 판별, 환경변수, 신호, 조립
    @staticmethod
    async def services_advice_inspect(repo_path:Path, commit_sha:str|None) -> Deploy_Advice:
        detect=await asyncio.to_thread(Repo_Service.services_repo_detect, repo_path)
        app_path=repo_path if detect.app_dir == "." else repo_path / detect.app_dir

        envs=await Env_Service.services_env_analyze(app_path)
        signals=await asyncio.to_thread(Advice_Service.services_advice_signals, app_path, detect, envs)
        return Advice_Service.services_advice_build(signals, detect, envs, commit_sha)


    # 비용 채우기 - 캐시된 원본은 건드리지 않고 복사본에 매번 채운다 (가격은 바뀔 수 있어 캐시에 두지 않는다). 가격 표가 없으면 비용은 비운 채로
    @staticmethod
    async def services_advice_with_cost(advice:Deploy_Advice) -> Deploy_Advice:
        result=advice.model_copy(deep=True)

        try:
            table=await Pricing_Service.services_pricing_table()
            if table is None:
                return result
            estimate=Pricing_Service.services_pricing_estimate(table)
            monthly=next(period.usd for period in estimate.periods if period.hours == 730)
        except Exception as e:
            logger.warning("비용 계산 실패 : %s", mask_text(str(e))[:200])
            return result

        result.cost=Advice_Cost(monthly_min=monthly, monthly_max=monthly, basis_date=estimate.basis_date,
                                hourly_usd=estimate.hourly_usd,
                                components=[component.model_dump() for component in estimate.components],
                                not_included=list(estimate.not_included), arm64_hourly_usd=estimate.arm64_hourly_usd,
                                spec_label=estimate.spec_label, spec_is_default=estimate.spec_is_default)
        return result


    # 분석만 하기 - 임시 폴더에 클론해 읽고 항상 지운다. 배포 기록·AWS 호출 없음 (기획서 I절)
    @staticmethod
    async def services_advice_analyze(db:AsyncSession, req:Advice_Request) -> Deploy_Advice:
        # 1. 주소·브랜치 검증과 커밋 확인
        try:
            repo_url=Repo_Service.services_repo_check_url(req.repo_url)
            branch=Repo_Service.services_repo_check_branch(req.branch)
            token=await Github_Service.services_github_token_by_g_id(db, req.github_installation_id) if req.github_installation_id else None
            commit_sha=await asyncio.to_thread(Repo_Service.services_repo_commit_sha, repo_url, branch, token)

        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

        except HTTPException:
            raise

        except Exception as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"레포를 조회할 수 없습니다 :{mask_text(str(e))}")

        # 2. 같은 커밋이면 캐시를 돌려준다
        cache_key=(repo_url, commit_sha) if commit_sha else None
        if cache_key and cache_key in Advice_Service.ADVICE_CACHE:
            return await Advice_Service.services_advice_with_cost(Advice_Service.ADVICE_CACHE[cache_key])

        # 3. 임시 폴더에 클론하고 분석, 끝나면 무조건 지운다
        dest=settings.work_path / f"advice_{uuid4().hex}"
        try:
            try:
                cloned_sha=await asyncio.to_thread(Repo_Service.services_repo_clone, repo_url, branch, dest, None, token)
            except Exception as e:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                    detail=f"레포를 가져올 수 없습니다 :{mask_text(str(e))}")

            advice=await Advice_Service.services_advice_inspect(dest, cloned_sha or commit_sha)

        except HTTPException:
            raise

        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=mask_text(str(e)))

        except Exception as e:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail=f"분석 실패 :{mask_text(str(e))}")

        finally:
            # 지우기 실패가 원래 결과(응답·예외)를 덮지 않게 삼킨다
            try:
                await asyncio.to_thread(Repo_Service.services_repo_remove, dest)
            except Exception:
                pass

        # 4. 캐시에 넣는다 (오래된 것부터 밀어낸다)
        if cache_key:
            if len(Advice_Service.ADVICE_CACHE) >= ADVICE_CACHE_LIMIT:
                Advice_Service.ADVICE_CACHE.pop(next(iter(Advice_Service.ADVICE_CACHE)))
            Advice_Service.ADVICE_CACHE[cache_key]=advice

        return await Advice_Service.services_advice_with_cost(advice)
