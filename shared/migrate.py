import logging
import sqlite3
from datetime import datetime
from pathlib import Path

from sqlalchemy import create_engine, inspect, text

from shared.masking import mask_text
from shared.database import Base, ensure_columns, ensure_indexes, ENSURE_COLUMNS
from shared.crypto_types import Encrypted_Text, FERNET_PREFIX
from shared.secrets import encrypt_secret, decrypt_secret, secret_is_encrypted, secret_rotate, blind_index

logger=logging.getLogger(__name__)

# 로그인 이전 (로그인 계획 Task 8) - 옛 data/wizard.db 를 잃지 않고 옮긴다: 백업 → 암호화 → 주인 지정
# 모든 함수는 동기 연결(conn)이나 파일 경로를 받는다 (비동기 엔진에서는 run_sync 로 부른다)
# 값 원문은 어디에도 싣지 않는다 - 돌려주는 것은 "표.열" 이름과 개수뿐이다
# Base.metadata 를 기준으로 하므로 부르는 쪽이 모든 모델을 미리 import 해 둬야 한다

# 주인을 정하지 않는 표 - 사용자 자신과 그 사용자의 토큰
OWNER_SKIP_TABLES=("users", "refresh_tokens", "api_tokens")
# Encrypted_Text 는 아니지만 encrypt_secret 으로 암호화해 둔 열 - 키를 회전할 때 같이 바꾼다
ROTATE_EXTRA_COLUMNS=[("aws_accounts", "external_id_encrypted")]
# 백업 파일 이름 앞부분 - wizard-YYYYmmdd-HHMMSS.db
BACKUP_PREFIX="wizard-"
# 서버 시작 검사 - 평문이 남은 DB 로는 서버를 띄우지 않는다
MESSAGE_STARTUP="암호화 전 값이 {count}건 있습니다. 서버를 끄고 python scripts/migrate_login.py backup → encrypt --yes 를 실행하세요"
# 서버 시작 경고 - 암호문 모양인데 안 풀리는 값이 있다 (SECRET_KEY 가 바뀌었거나 옛 키를 잃었다는 뜻). 서버는 켜지지만 그 값은 읽히지 않는다 (값은 싣지 않는다)
MESSAGE_UNREADABLE_WARNING="지금 키로 못 읽는 암호화 값이 {count}건 있습니다 ({columns}). SECRET_KEY 가 바뀌었거나 옛 키를 잃은 것일 수 있습니다 - python scripts/migrate_login.py status 로 확인하세요"
# 작업 종료·정리 스크립트 - 연결 계정을 읽지 못했을 때 (값은 싣지 않는다)
MESSAGE_ACCOUNTS_UNMIGRATED=("연결한 AWS 계정 정보가 이전(암호화) 전 상태라 읽지 못했습니다. 연결 계정 쪽 서비스는 확인하거나 멈추지 못했고 계속 요금이 나갈 수 있습니다.\n"
                             "다음: 서버를 끄고 python scripts/migrate_login.py backup → python scripts/migrate_login.py encrypt --yes 를 실행한 뒤 이 스크립트를 다시 실행하세요")


# DB_URL 에서 SQLite 파일 경로 - SQLite 파일이 아니면 None (상대 경로는 서버처럼 현재 폴더 기준)
def migrate_db_path(db_url:str) -> Path | None:
    if not db_url.startswith("sqlite") or ":///" not in db_url:
        return None

    raw=db_url.split(":///", 1)[1].split("?", 1)[0]
    if not raw or raw == ":memory:":
        return None
    return Path(raw).resolve()


# 읽기 전용 sqlite3 연결 - 보기만 하는 일이 파일을 바꾸거나 새로 만들지 않게 (없으면 예외)
def migrate_readonly_connect(db_path:Path) -> sqlite3.Connection:
    return sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True)


# 읽기 전용 엔진 - status·작업 종료 검사처럼 보기만 하는 명령이 쓴다
def migrate_readonly_engine(db_path:Path):
    # hide_parameters - 오류문에 바인드 값(원래 값)이 실리지 않게
    return create_engine("sqlite://", creator=lambda: migrate_readonly_connect(db_path), hide_parameters=True)


# DB 파일 검사 - 읽기 전용으로 열어 integrity_check 가 ok 인지 본다. 아니면 예외
def migrate_verify_db(db_path:Path) -> None:
    conn=migrate_readonly_connect(db_path)
    try:
        result=conn.execute("PRAGMA integrity_check").fetchone()
    finally:
        conn.close()

    if not result or result[0] != "ok":
        raise RuntimeError(f"DB 파일 검사 실패 (integrity_check): {db_path.name}")


# 백업 - sqlite3 백업 API 로 wizard-YYYYmmdd-HHMMSS.db 사본을 만들고, 사본을 열어 integrity_check 가 ok 인지 확인한 뒤 경로를 돌려준다
# 실패하면 예외 (부르는 쪽은 다음 단계로 넘어가지 않는다). 같은 이름이 있으면 -1, -2 를 붙여 덮어쓰지 않는다
def migrate_backup(db_path:Path, backup_dir:Path, now:datetime|None=None) -> Path:
    if not db_path.is_file():
        raise FileNotFoundError(f"DB 파일이 없습니다: {db_path}")

    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp=(now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    target=backup_dir / f"{BACKUP_PREFIX}{stamp}.db"
    number=1
    while target.exists():
        target=backup_dir / f"{BACKUP_PREFIX}{stamp}-{number}.db"
        number+=1

    source=migrate_readonly_connect(db_path)
    dest=sqlite3.connect(target)
    try:
        source.backup(dest)
    finally:
        dest.close()
        source.close()

    migrate_verify_db(target)
    return target


# 파일 되돌리기 - 백업 사본을 sqlite3 백업 API 로 DB 파일 위에 쓴다 (서버가 꺼져 있을 때만 부른다). 끝나면 검사한다
def migrate_restore_file(source:Path, db_path:Path) -> None:
    migrate_verify_db(source)

    reader=migrate_readonly_connect(source)
    writer=sqlite3.connect(db_path)
    try:
        reader.backup(writer)
    finally:
        writer.close()
        reader.close()

    migrate_verify_db(db_path)


# 서버 시작과 같은 표 준비 (동기) - 없는 표를 만들고 옛 표에 모자란 열·인덱스를 더한다. 반환: 더한 "표.열"·인덱스 이름
def migrate_bootstrap(conn) -> list[str]:
    Base.metadata.create_all(conn)
    return ensure_columns(conn) + ensure_indexes(conn)


# 아직 더하지 않은 열 - ENSURE_COLUMNS 중 실제 표에 없는 "표.열" (읽기만 한다)
def migrate_schema_pending(conn) -> list[str]:
    inspector=inspect(conn)
    tables=set(inspector.get_table_names())
    pending=[]

    for table_name, column_names in ENSURE_COLUMNS.items():
        if table_name not in tables:
            continue
        present={column["name"] for column in inspector.get_columns(table_name)}
        pending+=[f"{table_name}.{name}" for name in column_names if name not in present]

    return pending


# 암호화 열 목록 - Base.metadata 에서 Encrypted_Text 타입인 (표, 열)
def migrate_encrypted_columns() -> list[tuple[str, str]]:
    return [(table.name, column.name) for table in Base.metadata.sorted_tables
            for column in table.columns if isinstance(column.type, Encrypted_Text)]


# 실제 DB 에 있는 (표, 열)만 남긴다 - 옛 DB 에는 표나 열이 없을 수 있다
def migrate_present(conn, pairs:list[tuple[str, str]]) -> list[tuple[str, str]]:
    inspector=inspect(conn)
    tables=set(inspector.get_table_names())
    columns={}
    result=[]

    for table_name, column_name in pairs:
        if table_name not in tables:
            continue
        if table_name not in columns:
            columns[table_name]={column["name"] for column in inspector.get_columns(table_name)}
        if column_name in columns[table_name]:
            result.append((table_name, column_name))

    return result


# 표의 기본키 열 이름 - 모델 기준
def migrate_primary_key(table_name:str) -> str:
    return list(Base.metadata.tables[table_name].primary_key.columns)[0].name


# 값 상태 - encrypted(지금 키로 풀림) | unreadable(암호문 모양인데 안 풀림 - 키가 다르다. 다시 암호화하지 않는다) | plaintext(이전 전 평문)
def migrate_value_state(value) -> str:
    value=str(value)
    if secret_is_encrypted(value):
        return "encrypted"
    if value.startswith(FERNET_PREFIX):
        return "unreadable"
    return "plaintext"


# 값의 원문 - 암호문이면 풀고, 평문이면 그대로, 못 읽으면 None
def migrate_plain_value(value) -> str | None:
    state=migrate_value_state(value)
    if state == "encrypted":
        return decrypt_secret(str(value))
    if state == "plaintext":
        return str(value)
    return None


# 열의 값이 있는 행 - (기본키, 값)
def migrate_column_rows(conn, table_name:str, column_name:str) -> list:
    pk=migrate_primary_key(table_name)
    return conn.execute(text(f"SELECT {pk}, {column_name} FROM {table_name} WHERE {column_name} IS NOT NULL ORDER BY {pk}")).all()


# 열마다 상태별 행 수 - {"표.열": {"plaintext": n, "unreadable": n, "encrypted": n}}
def migrate_value_counts(conn) -> dict[str, dict[str, int]]:
    result={}

    for table_name, column_name in migrate_present(conn, migrate_encrypted_columns()):
        counts={"plaintext": 0, "unreadable": 0, "encrypted": 0}
        for _, value in migrate_column_rows(conn, table_name, column_name):
            counts[migrate_value_state(value)]+=1
        result[f"{table_name}.{column_name}"]=counts

    return result


# 평문 수 - 암호화 열마다 값이 있고 지금 키로 풀리지 않는(암호문 모양도 아닌) 행 수
def migrate_plaintext_count(conn) -> dict[str, int]:
    return {key: counts["plaintext"] for key, counts in migrate_value_counts(conn).items()}


# 파일의 평문 수 - 읽기 전용으로 열어 센다. 파일이 없으면 빈 dict (작업 종료·정리 스크립트가 쓴다)
def migrate_plaintext_count_file(db_path:Path | None) -> dict[str, int]:
    if db_path is None or not db_path.is_file():
        return {}

    engine=migrate_readonly_engine(db_path)
    try:
        with engine.connect() as conn:
            return migrate_plaintext_count(conn)
    finally:
        engine.dispose()


# 기기 토큰 블라인드 인덱스 채우기·중복 정리 - 같은 토큰 줄이 여럿이면 하나만 남긴다 (주인 있는 줄 → 최근 줄 → 큰 p_d_id 순으로 고른다)
# 못 읽는 줄은 지우지도 고치지도 않는다 (그 줄과 같은 인덱스를 쓰는 묶음 전체를 건너뛴다)
# 반환: {"push_devices.expo_token_bidx": 채운 수, "push_devices.duplicates": 지운 수, "push_devices.skipped": 건너뛴 수}
def migrate_push_device_bidx(conn, dry_run:bool=True) -> dict[str, int]:
    result={"push_devices.expo_token_bidx": 0, "push_devices.duplicates": 0, "push_devices.skipped": 0}
    wanted=[("push_devices", name) for name in ("expo_token", "expo_token_bidx", "u_id", "created_at")]
    present={name for _, name in migrate_present(conn, wanted)}
    if "expo_token" not in present:
        return result

    select_bidx="expo_token_bidx" if "expo_token_bidx" in present else "NULL"
    select_u_id="u_id" if "u_id" in present else "NULL"
    select_created="created_at" if "created_at" in present else "NULL"
    rows=conn.execute(text(f"SELECT p_d_id, expo_token, {select_bidx} AS bidx, {select_u_id} AS u_id, {select_created} AS created_at "
                           f"FROM push_devices ORDER BY p_d_id")).all()

    groups={}
    for row in rows:
        token=migrate_plain_value(row.expo_token) if row.expo_token is not None else None
        bidx=row.bidx or (blind_index("expo_token", token) if token is not None else None)
        if bidx is None:
            result["push_devices.skipped"]+=1
            continue
        groups.setdefault(bidx, []).append((row, token is not None))

    deletes=[]
    fills=[]
    for bidx, members in groups.items():
        if not all(readable for _, readable in members):
            result["push_devices.skipped"]+=sum(1 for row, _ in members if row.bidx is None)
            continue

        keeper=max((row for row, _ in members), key=lambda row: (row.u_id is not None, str(row.created_at or ""), row.p_d_id))
        deletes+=[row.p_d_id for row, _ in members if row.p_d_id != keeper.p_d_id]
        if keeper.bidx is None:
            fills.append((keeper.p_d_id, bidx))

    result["push_devices.duplicates"]=len(deletes)
    result["push_devices.expo_token_bidx"]=len(fills)

    if not dry_run:
        # 지우기 먼저 - 남길 줄에 인덱스를 넣을 때 유일 인덱스가 겹치지 않게
        for p_d_id in deletes:
            conn.execute(text("DELETE FROM push_devices WHERE p_d_id=:p_d_id"), {"p_d_id": p_d_id})
        for p_d_id, bidx in fills:
            conn.execute(text("UPDATE push_devices SET expo_token_bidx=:bidx WHERE p_d_id=:p_d_id AND expo_token_bidx IS NULL"),
                         {"bidx": bidx, "p_d_id": p_d_id})

    return result


# 평문 암호화 - 평문인 값만 encrypt_secret 으로 바꾼다 (이미 암호문이거나 못 읽는 값은 그대로 → 여러 번 불러도 안전)
# 기기 토큰 블라인드 인덱스 채우기·중복 정리도 같이 한다. 반환: {"표.열": 바꾼(바꿀) 수} + migrate_push_device_bidx 의 결과
def migrate_encrypt_plaintext(conn, dry_run:bool=True) -> dict[str, int]:
    devices=migrate_push_device_bidx(conn, dry_run)
    result={}

    for table_name, column_name in migrate_present(conn, migrate_encrypted_columns()):
        pk=migrate_primary_key(table_name)
        count=0
        for row_id, value in migrate_column_rows(conn, table_name, column_name):
            if migrate_value_state(value) != "plaintext":
                continue
            count+=1
            if not dry_run:
                conn.execute(text(f"UPDATE {table_name} SET {column_name}=:new WHERE {pk}=:row_id AND {column_name}=:old"),
                             {"new": encrypt_secret(str(value)), "row_id": row_id, "old": value})
        result[f"{table_name}.{column_name}"]=count

    result.update(devices)
    return result


# 키 회전 - 지금 키로 풀리는 모든 암호문을 secret_rotate 로 새 키(SECRET_KEY)로 다시 암호화한다 (external_id 포함)
# 평문·못 읽는 값은 건너뛰고 "표.열.skipped" 로 센다. 되돌리는 명령은 없다 (백업에서 restore)
def migrate_rotate(conn, dry_run:bool=True) -> dict[str, int]:
    result={}

    for table_name, column_name in migrate_present(conn, migrate_encrypted_columns() + ROTATE_EXTRA_COLUMNS):
        pk=migrate_primary_key(table_name)
        count=0
        skipped=0
        for row_id, value in migrate_column_rows(conn, table_name, column_name):
            if migrate_value_state(value) != "encrypted":
                skipped+=1
                continue
            count+=1
            if not dry_run:
                conn.execute(text(f"UPDATE {table_name} SET {column_name}=:new WHERE {pk}=:row_id AND {column_name}=:old"),
                             {"new": secret_rotate(str(value)), "row_id": row_id, "old": value})
        result[f"{table_name}.{column_name}"]=count
        if skipped:
            result[f"{table_name}.{column_name}.skipped"]=skipped

    return result


# 주인 열이 있는 표 - 모델에 u_id 가 있고 사용자·토큰 표가 아닌 것. 반환: (실제 DB 에 열이 있는 표, 아직 열이 없는 표)
def migrate_owner_tables(conn) -> tuple[list[str], list[str]]:
    candidates=[table.name for table in Base.metadata.sorted_tables
                if "u_id" in table.columns and table.name not in OWNER_SKIP_TABLES]
    present={table_name for table_name, _ in migrate_present(conn, [(name, "u_id") for name in candidates])}
    tables=set(inspect(conn).get_table_names())

    return ([name for name in candidates if name in present],
            [name for name in candidates if name in tables and name not in present])


# u_id 가 유일한 표인지 - 사용자마다 한 줄인 표(notification_settings)는 주인 없는 줄 하나만 넘길 수 있다
def migrate_owner_unique(table_name:str) -> bool:
    table=Base.metadata.tables[table_name]
    if table.columns["u_id"].unique:
        return True
    return any(index.unique and [column.name for column in index.columns] == ["u_id"] for index in table.indexes)


# 주인 없는 행 수 - 표마다 u_id IS NULL 인 행 수 (status 용)
def migrate_ownerless_count(conn) -> dict[str, int]:
    present, _=migrate_owner_tables(conn)
    return {name: conn.execute(text(f"SELECT COUNT(*) FROM {name} WHERE u_id IS NULL")).scalar() for name in present}


# 이메일로 사용자 찾기 - 블라인드 인덱스로만, active 인 사용자 중 u_id 가 가장 작은 것. 없으면 None
def migrate_user_find_by_email(conn, email:str) -> int | None:
    if "users" not in inspect(conn).get_table_names():
        return None

    return conn.execute(text("SELECT u_id FROM users WHERE email_bidx=:bidx AND status='active' ORDER BY u_id LIMIT 1"),
                        {"bidx": blind_index("email", email)}).scalar()


# 주인 지정 - u_id 열이 있는 모든 표(사용자·토큰 표 제외)에서 u_id IS NULL 인 행만 그 사용자로. 이미 주인 있는 행은 그대로
# u_id 가 유일한 표는 그 사용자 줄이 아직 없을 때 가장 작은 id 한 줄만 넘기고 나머지는 "표.skipped" 로 센다
def migrate_assign_owner(conn, u_id:int, dry_run:bool=True) -> dict[str, int]:
    if conn.execute(text("SELECT 1 FROM users WHERE u_id=:u_id"), {"u_id": u_id}).first() is None:
        raise ValueError(f"사용자 u_id={u_id} 가 없습니다")

    present, _=migrate_owner_tables(conn)
    result={}

    for table_name in present:
        pk=migrate_primary_key(table_name)
        null_ids=[row[0] for row in conn.execute(text(f"SELECT {pk} FROM {table_name} WHERE u_id IS NULL ORDER BY {pk}")).all()]

        if migrate_owner_unique(table_name):
            has_own=conn.execute(text(f"SELECT 1 FROM {table_name} WHERE u_id=:u_id"), {"u_id": u_id}).first() is not None
            assign=[] if has_own else null_ids[:1]
        else:
            assign=null_ids

        if not dry_run:
            for row_id in assign:
                conn.execute(text(f"UPDATE {table_name} SET u_id=:u_id WHERE {pk}=:row_id AND u_id IS NULL"), {"u_id": u_id, "row_id": row_id})

        result[table_name]=len(assign)
        if len(null_ids) > len(assign):
            result[f"{table_name}.skipped"]=len(null_ids) - len(assign)

    return result


# 블록 일관성 (보고만) - 연결 블록이 가리키는 AWS 계정·GitHub 설치의 주인이 블록의 주인과 다른 행 수
def migrate_connection_owner_mismatch(conn) -> dict[str, int]:
    result={"aws_accounts": 0, "github_installations": 0}
    needed=[("connections", "u_id"), ("aws_accounts", "u_id"), ("github_installations", "u_id")]
    if len(migrate_present(conn, needed)) < len(needed):
        return result

    for ref_table, ref_pk, fk in (("aws_accounts", "a_id", "aws_account_id"), ("github_installations", "g_id", "github_installation_id")):
        result[ref_table]=conn.execute(text(f"SELECT COUNT(*) FROM connections c JOIN {ref_table} r ON r.{ref_pk} = c.{fk} "
                                            f"WHERE r.u_id IS NOT c.u_id")).scalar()
    return result


# 못 읽는 값 수 - 암호화 열마다 암호문 모양인데 지금 키로 안 풀리는 행 수 (0 인 열은 뺀다)
def migrate_unreadable_count(conn) -> dict[str, int]:
    return {key: counts["unreadable"] for key, counts in migrate_value_counts(conn).items() if counts["unreadable"]}


# 서버 시작 검사 - 암호화 전 값이 하나라도 있으면 멈춘다 (새 DB·빈 표는 통과). 못 읽는 값은 멈추지 않고 경고만 남긴다. 값은 싣지 않는다
def migrate_check_startup(conn) -> None:
    counts=migrate_value_counts(conn)
    plaintext=sum(value["plaintext"] for value in counts.values())
    if plaintext:
        raise RuntimeError(MESSAGE_STARTUP.format(count=plaintext))

    unreadable={key: value["unreadable"] for key, value in counts.items() if value["unreadable"]}
    if unreadable:
        logger.warning(mask_text(MESSAGE_UNREADABLE_WARNING.format(count=sum(unreadable.values()), columns=", ".join(unreadable))))
    return None


# 이전 뒤 파일 정리 - 바꾼 값의 옛 원문이 빈 페이지에 남지 않게 secure_delete 를 켜고 VACUUM 으로 파일을 다시 쓴다
def migrate_scrub(db_path:Path) -> None:
    conn=sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA secure_delete=ON")
        conn.execute("VACUUM")
    finally:
        conn.close()
