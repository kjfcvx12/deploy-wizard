import os
import re
import fnmatch
from pathlib import Path

from features.repos.services import EXCLUDE_DIRS, EXCLUDE_FILES
from features.envvars.scheme import Env_Found


# 템플릿 도커파일이 이미 정하는 이름 - 사용자에게 묻지 않는다 (NODE_ENV, PORT: features/dockerfiles/templates/*.Dockerfile)
IGNORED_NAMES={'PATH', 'HOME', 'PWD', 'USER', 'HOSTNAME', 'LANG', 'TZ', 'NODE_ENV', 'PORT',
               'PYTHONPATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED'}
SKIP_DIRS=EXCLUDE_DIRS | {'tests', 'test', '__tests__', 'spec', 'e2e', 'docs', 'examples', 'example'}
MAX_FILES=500
MAX_FILE_BYTES=200_000
MAX_ENV_NAMES=300
MAX_NAME_CHARS=100
EXAMPLE_FILES=('.env.example', '.env.sample', '.env.template')
PYTHON_EXTS={'.py'}
NODE_EXTS={'.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'}

# 예시 파일의 값이 자리표시자인지 보는 낱말
PLACEHOLDER_WORDS=('your', 'xxx', 'changeme', '<', 'example')
# 이름에 이 조각이 있으면 예시 값이 있어도 기본값으로 쳐주지 않는다
SECRET_NAME_PARTS={'KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'PASSWD', 'PWD'}

NAME_RE=re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
COMPOSE_FILE_RE=re.compile(r'^(docker-)?compose(\..+)?\.ya?ml$', re.IGNORECASE)

_NAME=r'([A-Za-z_][A-Za-z0-9_]*)'
PY_ENVIRON_RE=re.compile(r'os\.environ\[\s*["\']' + _NAME + r'["\']\s*\](?!\s*=[^=])')
PY_GET_RE=re.compile(r'os\.(?:environ\.get|getenv)\(\s*["\']' + _NAME + r'["\']\s*(?=[,)])(,\s*[^)\s])?')
PY_FIELD_RE=re.compile(r'Field\(([^()]*?)\balias\s*=\s*["\']' + _NAME + r'["\']')
PY_FIELD_DEFAULT_RE=re.compile(r'\bdefault(?:_factory)?\s*=')
NODE_ENV_RE=re.compile(r'(?:process\.env|import\.meta\.env)(?:\.' + _NAME + r'|\[\s*["\']' + _NAME + r'["\']\s*\])')
NODE_DEFAULT_RE=re.compile(r'\|\||\?\?')
COMPOSE_BARE_REF_RE=re.compile(r'\$\{[A-Za-z_][A-Za-z0-9_]*(?::?\?[^}]*)?\}|\$[A-Za-z_][A-Za-z0-9_]*')
# Field alias 는 환경변수 꼴(대문자·숫자·밑줄)일 때만 쓴다 - userId 같은 JSON 별칭을 거른다
ENV_ALIAS_RE=re.compile(r'^[A-Z][A-Z0-9_]*$')
# Vite 가 넣어 주는 내장 값 - import.meta.env 형태에서만 뺀다
VITE_BUILTINS={'DEV', 'MODE', 'BASE_URL', 'PROD', 'SSR'}


class Env_Scan_Service:

    # 이름이 쓸 만한지 - 형식이 맞고 100자 이하이며 템플릿이 정하는 이름이 아니어야 한다
    @staticmethod
    def services_env_scan_valid_name(name:str) -> bool:
        return bool(NAME_RE.match(name)) and len(name) <= MAX_NAME_CHARS and name not in IGNORED_NAMES


    # 텍스트 안 위치의 줄 번호 (1부터)
    @staticmethod
    def services_env_scan_line_of(text:str, pos:int) -> int:
        return text.count("\n", 0, pos) + 1


    # 코드 한 건 만들기 - 값은 담지 않는다
    @staticmethod
    def services_env_scan_code_item(file_name:str, text:str, pos:int, name:str, has_default:bool) -> Env_Found:
        line=Env_Scan_Service.services_env_scan_line_of(text, pos)
        return Env_Found(name=name, required=not has_default, has_default=has_default,
                         source='code', source_hint=f"{file_name}:{line}")


    # 코드 텍스트에서 환경변수 이름 찾기 - 확장자로 파이썬/노드 규칙을 고른다
    @staticmethod
    def services_env_scan_text(file_name:str, text:str) -> list[Env_Found]:
        ext=Path(file_name).suffix.lower()
        found:list[Env_Found]=[]

        if ext in PYTHON_EXTS:
            for m in PY_ENVIRON_RE.finditer(text):
                found.append(Env_Scan_Service.services_env_scan_code_item(file_name, text, m.start(), m.group(1), False))

            for m in PY_GET_RE.finditer(text):
                found.append(Env_Scan_Service.services_env_scan_code_item(file_name, text, m.start(), m.group(1), m.group(2) is not None))

            for m in PY_FIELD_RE.finditer(text):
                if not ENV_ALIAS_RE.match(m.group(2)):
                    continue
                args=m.group(1)
                first=args.split(",")[0].strip()
                if first == "...":
                    has_default=False
                elif PY_FIELD_DEFAULT_RE.search(args):
                    has_default=True
                else:
                    has_default=bool(first) and "=" not in first
                found.append(Env_Scan_Service.services_env_scan_code_item(file_name, text, m.start(), m.group(2), has_default))

        elif ext in NODE_EXTS:
            for m in NODE_ENV_RE.finditer(text):
                name=m.group(1) or m.group(2)
                if m.group(0).startswith("import.meta") and name in VITE_BUILTINS:
                    continue
                line_end=text.find("\n", m.end())
                rest=text[m.end():] if line_end == -1 else text[m.end():line_end]
                found.append(Env_Scan_Service.services_env_scan_code_item(file_name, text, m.start(), name, bool(NODE_DEFAULT_RE.search(rest))))

        return [f for f in found if Env_Scan_Service.services_env_scan_valid_name(f.name)]


    # 컴포즈 값이 기본값을 갖는지 - 빈 값과 ${NAME} 그대로는 필수
    @staticmethod
    def services_env_scan_compose_has_default(value:str) -> bool:
        value=value.strip().strip("\"'").strip()
        if not value:
            return False
        return not COMPOSE_BARE_REF_RE.search(re.sub(r'\$\{[A-Za-z_][A-Za-z0-9_]*:?-[^}]*\}', '', value))


    # 컴포즈 environment 블록에서 이름 찾기 - 리스트 형태와 맵 형태
    @staticmethod
    def services_env_scan_compose(text:str) -> list[Env_Found]:
        found:list[Env_Found]=[]
        env_indent:int | None=None

        for raw in text.splitlines():
            stripped=raw.strip()
            if not stripped or stripped.startswith("#"):
                continue
            indent=len(raw) - len(raw.lstrip())

            if env_indent is not None:
                is_item=indent > env_indent or (indent == env_indent and stripped.startswith("- "))
                if not is_item:
                    env_indent=None
                else:
                    item=re.sub(r'\s+#.*$', '', stripped)
                    if item.startswith("- "):
                        item=item[2:].strip().strip("\"'")
                        name, _, value=item.partition("=")
                    else:
                        name, _, value=item.partition(":")
                    name=name.strip().strip("\"'")
                    if Env_Scan_Service.services_env_scan_valid_name(name):
                        has_default=Env_Scan_Service.services_env_scan_compose_has_default(value)
                        found.append(Env_Found(name=name, required=not has_default, has_default=has_default, source='compose'))
                    continue

            if re.match(r'^environment:\s*(#.*)?$', stripped):
                env_indent=indent

        return found


    # 예시 값이 진짜 기본값 구실을 하는지 - 비었거나 자리표시자거나 비밀 이름이면 아니다
    @staticmethod
    def services_env_scan_example_has_default(name:str, value:str) -> bool:
        value=value.strip().strip("\"'").strip()
        if not value:
            return False
        if any(word in value.lower() for word in PLACEHOLDER_WORDS):
            return False
        return not (set(name.upper().split("_")) & SECRET_NAME_PARTS)


    # .env.example 에서 이름만 찾기 - 값은 기본값 여부 판정에만 쓰고 버린다
    @staticmethod
    def services_env_scan_example(text:str) -> list[Env_Found]:
        found:list[Env_Found]=[]

        for raw in text.splitlines():
            line=raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line=line[len("export "):].strip()
            name, _, value=line.partition("=")
            name=name.strip()
            if not Env_Scan_Service.services_env_scan_valid_name(name):
                continue
            has_default=Env_Scan_Service.services_env_scan_example_has_default(name, value)
            found.append(Env_Found(name=name, required=not has_default, has_default=has_default, source='example'))

        return found


    # 파일 읽기 - 심볼릭 링크는 따라가지 않는다. UTF-8, 안 되면 BOM 있는 UTF-16, 그래도 안 되면 깨진 글자를 버린다. 예외를 내지 않는다
    @staticmethod
    def services_env_scan_read(path:Path) -> str | None:
        try:
            if path.is_symlink():
                return None
            if path.stat().st_size > MAX_FILE_BYTES:
                return None
            data=path.read_bytes()
        except OSError:
            return None

        try:
            return data.decode("utf-8-sig")
        except UnicodeDecodeError:
            pass
        if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
            return data.decode("utf-16", errors="ignore")
        return data.decode("utf-8", errors="ignore")


    # 같은 이름 합치기 - 코드 > 컴포즈 > 예시, 기본값은 모든 발생이 가질 때만
    @staticmethod
    def services_env_scan_merge(items:list[Env_Found]) -> list[Env_Found]:
        rank={'code': 0, 'compose': 1, 'example': 2}
        best:dict[str, list[Env_Found]]={}

        for item in items:
            group=best.setdefault(item.name, [])
            if group and rank[item.source] > rank[group[0].source]:
                continue
            if group and rank[item.source] < rank[group[0].source]:
                group.clear()
            group.append(item)

        result:list[Env_Found]=[]
        for name in sorted(best)[:MAX_ENV_NAMES]:
            group=best[name]
            has_default=all(g.has_default for g in group)
            result.append(group[0].model_copy(update={'has_default': has_default, 'required': not has_default}))
        return result


    # 앱 폴더를 훑어 환경변수 이름 찾기 - 파일 수와 크기를 제한하고 진짜 .env 는 읽지 않는다
    @staticmethod
    def services_env_scan(app_path:Path) -> list[Env_Found]:
        items:list[Env_Found]=[]
        read_count=0

        for dir_path, dir_names, file_names in os.walk(app_path):
            dir_names[:]=sorted(d for d in dir_names if d not in SKIP_DIRS)

            for file_name in sorted(file_names):
                if read_count >= MAX_FILES:
                    break
                lower=file_name.lower()
                path=Path(dir_path) / file_name
                rel=path.relative_to(app_path).as_posix()

                if path.is_symlink():
                    continue

                if lower in EXAMPLE_FILES:
                    kind='example'
                elif COMPOSE_FILE_RE.match(lower):
                    kind='compose'
                elif any(fnmatch.fnmatch(lower, pattern.lower()) for pattern in EXCLUDE_FILES):
                    continue
                elif Path(lower).suffix in PYTHON_EXTS | NODE_EXTS:
                    kind='code'
                else:
                    continue

                text=Env_Scan_Service.services_env_scan_read(path)
                if text is None:
                    continue
                read_count+=1

                if kind == 'code':
                    items.extend(Env_Scan_Service.services_env_scan_text(rel, text))
                elif kind == 'compose':
                    items.extend(f.model_copy(update={'source_hint': rel}) for f in Env_Scan_Service.services_env_scan_compose(text))
                else:
                    items.extend(f.model_copy(update={'source_hint': rel}) for f in Env_Scan_Service.services_env_scan_example(text))

            if read_count >= MAX_FILES:
                break

        return Env_Scan_Service.services_env_scan_merge(items)
