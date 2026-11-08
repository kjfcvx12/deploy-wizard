import json
import pytest
from pathlib import Path

from features.envvars.scan import Env_Scan_Service, MAX_FILES, MAX_FILE_BYTES


# 결과를 {이름: Env_Found} 로 바꾼다
def by_name(found) -> dict:
    return {f.name: f for f in found}


# 앱 폴더에 파일을 만든다
def write(root:Path, rel:str, text:str | bytes):
    path=root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(text, bytes):
        path.write_bytes(text)
    else:
        path.write_text(text, encoding="utf-8")


PY_CODE='''
import os
from pydantic import Field
a=os.environ["A"]
b=os.getenv("B")
c=os.getenv("C","x")
d=os.environ.get("D", None)
e: str=Field("x", alias="E")
f: str=Field(..., alias="F")
'''


# 파이썬 패턴 - 필수/기본값 구분
@pytest.mark.parametrize("name,has_default", [
    ("A", False), ("B", False), ("C", True), ("D", True), ("E", True), ("F", False),
])
def test_scan_python_patterns(name, has_default):
    result=by_name(Env_Scan_Service.services_env_scan_text("app/main.py", PY_CODE))
    assert result[name].has_default is has_default
    assert result[name].required is (not has_default)
    assert result[name].source == 'code'
    assert result[name].source_hint.startswith("app/main.py:")


# 노드 패턴
NODE_CODE='''
const g=process.env.G
const h=process.env["H"]
const i=import.meta.env.VITE_I
const j=process.env.J || "d"
const k=process.env.K ?? "d"
'''


@pytest.mark.parametrize("name,has_default", [
    ("G", False), ("H", False), ("VITE_I", False), ("J", True), ("K", True),
])
def test_scan_node_patterns(name, has_default):
    result=by_name(Env_Scan_Service.services_env_scan_text("src/a.js", NODE_CODE))
    assert result[name].has_default is has_default


# 이름 표 없이 임의 이름도 찾는다
def test_scan_arbitrary_names_found():
    result=by_name(Env_Scan_Service.services_env_scan_text("a.py", 'x=os.getenv("MY_THING_URL")'))
    assert "MY_THING_URL" in result


# 계산된 이름은 찾지 않는다
def test_scan_computed_name_not_found():
    assert Env_Scan_Service.services_env_scan_text("a.py", 'x=os.environ[prefix + "_KEY"]') == []


# 문자열을 이어 붙인 이름은 일부만 잘라 찾지 않는다
@pytest.mark.parametrize("code", [
    'x=os.getenv("PREFIX_" + name)',
    'x=os.environ.get("A" + b, "d")',
])
def test_scan_concatenated_get_name_not_found(code):
    assert Env_Scan_Service.services_env_scan_text("a.py", code) == []


# Vite 내장 값은 import.meta.env 형태에서 뺀다 - 다른 이름은 그대로 찾는다
def test_scan_vite_builtins_ignored():
    code='const a=import.meta.env.DEV\nconst b=import.meta.env.MODE\nconst c=import.meta.env.BASE_URL\nconst d=import.meta.env.PROD\nconst e=import.meta.env.SSR\nconst f=import.meta.env.VITE_API\n'
    names={f.name for f in Env_Scan_Service.services_env_scan_text("src/a.ts", code)}
    assert names == {"VITE_API"}
    assert {f.name for f in Env_Scan_Service.services_env_scan_text("src/a.js", "process.env.DEV")} == {"DEV"}


# Field alias 는 환경변수 꼴일 때만 쓴다
def test_scan_field_alias_must_look_like_env_name():
    code='a: str=Field(..., alias="userId")\nb: str=Field(..., alias="DATABASE_URL")\n'
    names={f.name for f in Env_Scan_Service.services_env_scan_text("m.py", code)}
    assert names == {"DATABASE_URL"}


# UTF-8 BOM 이 있어도 첫 줄의 이름을 잃지 않는다
def test_scan_example_utf8_bom_keeps_first_name(tmp_path):
    write(tmp_path, ".env.example", b"\xef\xbb\xbfFIRST_VAR=\nSECOND_VAR=\n")
    names={f.name for f in Env_Scan_Service.services_env_scan(tmp_path)}
    assert names == {"FIRST_VAR", "SECOND_VAR"}


# 컴포즈 ${NAME:?메시지} 는 필수, ${NAME:-기본값} 은 기본값 있음
def test_scan_compose_required_and_default_forms():
    text='services:\n  w:\n    environment:\n      - R=${R:?must be set}\n      - Q=${Q?must be set}\n      - W=${W:-d}\n'
    found=by_name(Env_Scan_Service.services_env_scan_compose(text))
    assert found["R"].required is True
    assert found["Q"].required is True
    assert found["W"].has_default is True


# 템플릿 도커파일이 정하는 이름은 돌려주지 않는다
def test_scan_ignores_template_set_names():
    code='os.getenv("PORT")\nos.environ["PATH"]\nprocess.env.NODE_ENV\n'
    assert Env_Scan_Service.services_env_scan_text("a.py", code) == []
    assert Env_Scan_Service.services_env_scan_text("a.js", code) == []


# 테스트·벤더 폴더는 건너뛴다
def test_scan_skips_test_and_vendor_dirs(tmp_path):
    write(tmp_path, "tests/x.py", 'os.getenv("ONLY_IN_TESTS")')
    write(tmp_path, "node_modules/m/i.js", 'process.env.ONLY_IN_VENDOR')
    write(tmp_path, "app.py", 'os.getenv("REAL")')
    names={f.name for f in Env_Scan_Service.services_env_scan(tmp_path)}
    assert names == {"REAL"}


# 예시 파일은 이름만 읽고 값은 결과 어디에도 없다
def test_scan_example_names_only_and_never_values(tmp_path):
    write(tmp_path, ".env.example", "API_KEY=sk-live-123456\nPORT=8000\n")
    result=Env_Scan_Service.services_env_scan(tmp_path)
    assert "sk-live-123456" not in json.dumps([f.model_dump() for f in result])
    found=by_name(result)
    assert found["API_KEY"].required is True
    assert found["API_KEY"].source == 'example'
    assert "PORT" not in found


# 예시 파일의 기본값 판정 - 자리표시자와 빈 값은 필수
@pytest.mark.parametrize("line,has_default", [
    ("LOG_LEVEL=info", True),
    ("EMPTY=", False),
    ("A_URL=https://your-host/x", False),
    ("B_URL=<fill me>", False),
    ("C_URL=changeme", False),
    ("D_URL=xxxxxxxx", False),
    ("E_URL=http://example.com", False),
])
def test_scan_example_default_rule(line, has_default):
    found=Env_Scan_Service.services_env_scan_example(line + "\n")
    assert found[0].has_default is has_default


# 진짜 .env 는 절대 읽지 않는다
def test_scan_real_dotenv_is_never_read(tmp_path, monkeypatch):
    write(tmp_path, ".env", "SECRET=hunter2\n")
    write(tmp_path, ".env.local", "LOCAL_SECRET=hunter3\n")
    write(tmp_path, "server.key", "KEY_BODY\n")
    write(tmp_path, "app.py", 'print("hi")')

    reads=[]
    original=Path.read_bytes

    # 읽은 파일 이름을 적는다
    def recording_read_bytes(self):
        reads.append(self.name)
        return original(self)

    monkeypatch.setattr(Path, "read_bytes", recording_read_bytes)
    result=Env_Scan_Service.services_env_scan(tmp_path)
    assert reads == ["app.py"]
    assert "SECRET" not in {f.name for f in result}
    assert "hunter2" not in json.dumps([f.model_dump() for f in result])


# 컴포즈 environment - 리스트·맵 두 형태
def test_scan_compose_environment():
    text='''services:
  web:
    image: x
    environment:
      - X=${X}
      - Z
      - W=${W:-fallback}
    ports:
      - "80:80"
  api:
    environment:
      Y: literal
      V: ${V}
      PORT: 8000
    command: run
'''
    found=by_name(Env_Scan_Service.services_env_scan_compose(text))
    assert found["X"].required is True
    assert found["Z"].required is True
    assert found["W"].has_default is True
    assert found["Y"].has_default is True
    assert found["V"].required is True
    assert "PORT" not in found
    assert all(f.source == 'compose' for f in found.values())


# 합치기 - 코드가 예시보다 우선이고 기본값은 모든 발생이 가질 때만
def test_scan_merge_rules(tmp_path):
    write(tmp_path, "a.py", 'os.getenv("SHARED")\nos.getenv("BOTH", "x")\n')
    write(tmp_path, "b.py", 'os.environ["BOTH"]\n')
    write(tmp_path, ".env.example", "SHARED=value\nONLY_EX=1\n")
    write(tmp_path, "docker-compose.yml", "services:\n  w:\n    environment:\n      - ONLY_EX=${ONLY_EX}\n      - ONLY_CP=${ONLY_CP}\n")
    result=Env_Scan_Service.services_env_scan(tmp_path)
    found=by_name(result)
    assert found["SHARED"].required is True
    assert found["SHARED"].source == 'code'
    assert found["BOTH"].has_default is False
    assert found["ONLY_EX"].source == 'compose'
    assert found["ONLY_CP"].source == 'compose'
    assert [f.name for f in result] == sorted(f.name for f in result)
    assert len({f.name for f in result}) == len(result)


# 작업량이 제한되고 이상한 인코딩에도 죽지 않는다
def test_scan_is_bounded_and_crash_free(tmp_path, monkeypatch):
    for i in range(600):
        write(tmp_path, f"pkg/f{i:03d}.py", f'os.getenv("V{i}")\n')
    write(tmp_path, "big.py", 'os.getenv("BIG_VAR")\n' + "#" * (MAX_FILE_BYTES + 100_000))
    write(tmp_path, "u16.py", 'os.getenv("U16_VAR")\n'.encode("utf-16"))
    write(tmp_path, "blob.py", bytes(range(256)) * 50)

    reads=[]
    original=Path.read_bytes

    # 읽은 파일 수를 센다
    def counting_read_bytes(self):
        reads.append(self.name)
        return original(self)

    monkeypatch.setattr(Path, "read_bytes", counting_read_bytes)
    result=Env_Scan_Service.services_env_scan(tmp_path)

    assert len(reads) <= MAX_FILES
    assert "big.py" not in reads
    assert "BIG_VAR" not in {f.name for f in result}
    assert len(result) <= MAX_FILES


# 이상한 인코딩 파일 단독 - UTF-16 은 읽히고 바이너리는 조용히 지나간다
def test_scan_odd_encodings_do_not_raise(tmp_path):
    write(tmp_path, "u16.py", 'os.getenv("U16_VAR")\n'.encode("utf-16"))
    write(tmp_path, "blob.py", bytes(range(256)) * 50)
    write(tmp_path, "bad.js", b"process.env.GOOD\n\xff\xfe\x00\x80 process.env.\xc3\x28")
    names={f.name for f in Env_Scan_Service.services_env_scan(tmp_path)}
    assert "U16_VAR" in names
    assert "GOOD" in names
