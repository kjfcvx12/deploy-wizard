import sys
import socket
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine

from shared.masking import mask_text
from shared.settings import settings
from shared.migrate import (migrate_db_path, migrate_readonly_engine, migrate_backup, migrate_restore_file, migrate_verify_db,
                            migrate_bootstrap, migrate_schema_pending, migrate_value_counts, migrate_plaintext_count,
                            migrate_encrypt_plaintext, migrate_rotate, migrate_owner_tables, migrate_ownerless_count,
                            migrate_user_find_by_email, migrate_assign_owner, migrate_connection_owner_mismatch, migrate_scrub)

# 모델을 import 해야 Base.metadata 가 암호화 열·u_id 열을 안다 (하나라도 빠지면 그 표를 건너뛴다)
from features.deploys import models as deploy_models
from features.accounts import models as account_models
from features.envvars import models as envvar_models
from features.health import models as health_models
from features.incidents import models as incident_models
from features.notifications import models as notification_models
from features.auth import models as auth_models

# 로그인 이전 (로그인 계획 Task 8) - 옛 data/wizard.db 를 잃지 않고 옮긴다. 순서는 README "로그인 이전" 절
# 기본은 보기만 한다. --yes 일 때만 쓰고, 쓰기 전에는 언제나 검사한 백업(data/backups/wizard-YYYYmmdd-HHMMSS.db)을 먼저 만든다
# 출력에는 값 원문·토큰·이메일을 싣지 않는다 (표·열 이름과 개수만)
#
# python scripts/migrate_login.py backup                              백업만 만든다
# python scripts/migrate_login.py status                              열마다 평문 수, 주인 없는 행 수 (읽기 전용)
# python scripts/migrate_login.py encrypt [--yes]                     평문 암호화 + 기기 토큰 인덱스 채우기 (서버를 끈 뒤)
# python scripts/migrate_login.py assign-owner --email <주소> [--yes]  주인 없는 행을 그 사용자로 (그 계정으로 한 번 로그인한 뒤)
# python scripts/migrate_login.py rotate-keys [--yes]                 SECRET_KEYS_OLD 의 옛 키 암호문을 SECRET_KEY 로 (서버를 끈 뒤)
# python scripts/migrate_login.py restore --from <백업> [--yes]        백업으로 파일을 되돌린다 (서버를 끈 뒤)

PORT=8081
MESSAGE_SERVER_RUNNING=f"서버가 켜져 있습니다 (:{PORT} 에 리스너가 있음). 서버를 끈 뒤 다시 실행하세요"


# :8081 에 서버가 떠 있는지 - 접속이 되면 리스너가 있다
def port_in_use(port:int=PORT) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex(("127.0.0.1", port)) == 0


# 쓰기용 엔진 - 다른 쓰기가 잠깐 잠금을 쥐고 있으면 기다린다
def writable_engine(db_path:Path):
    return create_engine(f"sqlite:///{db_path.as_posix()}", connect_args={"timeout": 10})


# 개수 표를 한 줄씩 - 0 인 줄은 빼고, 없으면 "없음"
def print_counts(title:str, counts:dict[str, int], labels:dict[str, str] | None=None) -> None:
    print(title)
    lines=[(key, count) for key, count in counts.items() if count]
    if not lines:
        print("  없음")
    for key, count in lines:
        print(f"  {key:<45} {count}건{(' ' + labels[key]) if labels and key in labels else ''}")


# 백업 - 만들고 검사한 경로를 알린다
def command_backup(db_path:Path, backup_dir:Path) -> int:
    backup=migrate_backup(db_path, backup_dir)
    print(f"백업을 만들었습니다 (integrity_check ok): {backup}")
    print("이 파일에는 암호화 전 값이 그대로 있을 수 있습니다. .env 의 키와 함께 안전한 곳에 두세요.")
    return 0


# 상태 - 열마다 평문·못 읽는 값 수, 표마다 주인 없는 행 수 (읽기 전용 연결)
def command_status(db_path:Path) -> int:
    engine=migrate_readonly_engine(db_path)
    try:
        with engine.connect() as conn:
            counts=migrate_value_counts(conn)
            pending=migrate_schema_pending(conn)
            devices=migrate_encrypt_plaintext(conn, dry_run=True)
            ownerless=migrate_ownerless_count(conn)
            _, missing=migrate_owner_tables(conn)
            mismatch=migrate_connection_owner_mismatch(conn)
    finally:
        engine.dispose()

    print(f"DB {db_path}\n")
    print_counts("암호화 전 값 (encrypt --yes 로 바꾼다)", {key: value["plaintext"] for key, value in counts.items()})
    print_counts("지금 키로 못 읽는 값 (SECRET_KEY·SECRET_KEYS_OLD 확인)", {key: value["unreadable"] for key, value in counts.items()})
    print_counts("기기 토큰 (encrypt --yes 로 정리)", {key: devices[key] for key in ("push_devices.expo_token_bidx", "push_devices.duplicates", "push_devices.skipped")},
                 {"push_devices.expo_token_bidx": "인덱스 채울 줄", "push_devices.duplicates": "같은 토큰 중복 (하나만 남긴다)", "push_devices.skipped": "못 읽어 그대로 둘 줄"})
    not_yet=sorted(set(pending) | {f"{name}.u_id" for name in missing})
    if not_yet:
        print(f"아직 없는 열 (encrypt --yes 가 먼저 더한다): {', '.join(not_yet)}")
    print_counts("주인 없는 행 (assign-owner --yes 로 정한다)", ownerless)
    print_counts("블록과 주인이 다른 연결 (보고만)", mismatch)
    return 0


# 암호화 - 보기만 / --yes 면 백업 → 열·인덱스 보정 → 기기 토큰 정리 → 평문 암호화 → 확인 → 파일 정리
def command_encrypt(db_path:Path, backup_dir:Path, yes:bool) -> int:
    if yes and port_in_use():
        print(MESSAGE_SERVER_RUNNING)
        return 1

    engine=migrate_readonly_engine(db_path)
    try:
        with engine.connect() as conn:
            planned=migrate_encrypt_plaintext(conn, dry_run=True)
            pending=migrate_schema_pending(conn)
    finally:
        engine.dispose()

    work={key: count for key, count in planned.items() if not key.endswith(".skipped")}
    if not yes:
        print_counts("바꿀 값 (보기만 - 실제로 바꾸려면 서버를 끄고 --yes)", work)
        if pending:
            print(f"더할 열: {', '.join(pending)}")
        return 0

    if not any(work.values()) and not pending:
        print("바꿀 값이 없습니다. 이미 이전되었습니다 (백업도 만들지 않았습니다).")
        return 0

    backup=migrate_backup(db_path, backup_dir)
    print(f"백업 (integrity_check ok): {backup}")

    engine=writable_engine(db_path)
    try:
        with engine.begin() as conn:
            conn.exec_driver_sql("PRAGMA secure_delete=ON")
            added=migrate_bootstrap(conn)
            done=migrate_encrypt_plaintext(conn, dry_run=False)
            left=sum(migrate_plaintext_count(conn).values())
            # 하나라도 남으면 이번 바꾸기를 모두 되돌린다
            if left:
                raise RuntimeError(f"암호화 뒤에도 평문이 {left}건 남아 이번 변경을 되돌렸습니다")
    finally:
        engine.dispose()

    migrate_scrub(db_path)
    migrate_verify_db(db_path)

    if added:
        print(f"더한 열·인덱스: {', '.join(added)}")
    print_counts("바꾼 값", {key: count for key, count in done.items() if not key.endswith(".skipped")})
    if done.get("push_devices.skipped"):
        print(f"못 읽어 그대로 둔 기기 줄 {done['push_devices.skipped']}건 (지우지 않았습니다)")
    print("\n남은 평문 0건. 이제 서버를 켤 수 있습니다.")
    print(f"백업 파일에는 암호화 전 값이 그대로 있습니다 - 확인이 끝나면 안전한 곳에 두거나 지우세요. 되돌리기: restore --from {backup}")
    return 0


# 주인 지정 - 이메일(블라인드 인덱스)로 사용자를 찾아 주인 없는 행만 그 사용자로. 보기만 / --yes 면 백업 먼저
def command_assign_owner(db_path:Path, backup_dir:Path, email:str, yes:bool) -> int:
    engine=migrate_readonly_engine(db_path)
    try:
        with engine.connect() as conn:
            left=sum(migrate_plaintext_count(conn).values())
            _, missing=migrate_owner_tables(conn)
            u_id=None if left or missing else migrate_user_find_by_email(conn, email)
            planned=migrate_assign_owner(conn, u_id, dry_run=True) if u_id is not None else {}
    finally:
        engine.dispose()

    if left or missing:
        print("아직 암호화(이전) 전입니다. 먼저 서버를 끄고 encrypt --yes 를 실행하세요.")
        return 1
    if u_id is None:
        print("그 이메일로 로그인한 사용자가 없습니다. 먼저 그 계정으로 한 번 로그인하세요.")
        return 1

    work={key: count for key, count in planned.items() if not key.endswith(".skipped")}
    skipped={key: count for key, count in planned.items() if key.endswith(".skipped")}

    if not yes:
        print_counts(f"사용자 u_id={u_id} 로 넘길 행 (보기만 - 실제로 하려면 --yes)", work)
        if skipped:
            print_counts("건너뛸 행 (그 사용자 줄이 이미 있음)", skipped)
        return 0

    done={}
    if any(work.values()):
        backup=migrate_backup(db_path, backup_dir)
        print(f"백업 (integrity_check ok): {backup}")

        engine=writable_engine(db_path)
        try:
            with engine.begin() as conn:
                done=migrate_assign_owner(conn, u_id, dry_run=False)
        finally:
            engine.dispose()
    else:
        print("주인을 정할 행이 없습니다 (백업도 만들지 않았습니다).")

    # 블록 일관성은 읽기 전용으로 확인만 한다
    engine=migrate_readonly_engine(db_path)
    try:
        with engine.connect() as conn:
            mismatch=migrate_connection_owner_mismatch(conn)
    finally:
        engine.dispose()

    if done:
        print_counts(f"사용자 u_id={u_id} 로 넘긴 행", {key: count for key, count in done.items() if not key.endswith(".skipped")})
        if any(key.endswith(".skipped") for key in done):
            print_counts("건너뛴 행 (그 사용자 줄이 이미 있음)", {key: count for key, count in done.items() if key.endswith(".skipped")})

    if any(mismatch.values()):
        print_counts("주의 - 블록과 주인이 다른 연결 (자동으로 고치지 않습니다)", mismatch)
    else:
        print("연결 블록의 주인이 모두 맞습니다.")
    print("이제 .env 에 AUTH_ENABLED=true 를 넣고 서버를 다시 켜세요.")
    return 0


# 키 회전 - SECRET_KEYS_OLD 의 옛 키로 만든 암호문을 SECRET_KEY 로. 보기만 / --yes 면 백업 먼저. 되돌리기는 restore 뿐이다
def command_rotate(db_path:Path, backup_dir:Path, yes:bool) -> int:
    if yes and port_in_use():
        print(MESSAGE_SERVER_RUNNING)
        return 1
    if not settings.secret_keys_old:
        print("SECRET_KEYS_OLD 가 비어 있습니다. 새 키를 SECRET_KEY 에, 예전 키를 SECRET_KEYS_OLD 에 넣은 뒤 실행하세요.")
        return 1

    engine=migrate_readonly_engine(db_path)
    try:
        with engine.connect() as conn:
            planned=migrate_rotate(conn, dry_run=True)
    finally:
        engine.dispose()

    work={key: count for key, count in planned.items() if not key.endswith(".skipped")}
    if not yes:
        print_counts("새 키로 바꿀 값 (보기만 - 실제로 하려면 서버를 끄고 --yes)", work)
        return 0

    backup=migrate_backup(db_path, backup_dir)
    print(f"백업 (integrity_check ok): {backup}")

    engine=writable_engine(db_path)
    try:
        with engine.begin() as conn:
            conn.exec_driver_sql("PRAGMA secure_delete=ON")
            done=migrate_rotate(conn, dry_run=False)
    finally:
        engine.dispose()

    migrate_scrub(db_path)
    migrate_verify_db(db_path)

    print_counts("새 키로 바꾼 값", {key: count for key, count in done.items() if not key.endswith(".skipped")})
    if any(key.endswith(".skipped") for key in done):
        print_counts("건너뛴 값 (평문이거나 지금 키로 못 읽음 - status 로 확인)", {key: count for key, count in done.items() if key.endswith(".skipped")})
    print("\n키 회전은 되돌리는 명령이 없습니다. 되돌리려면 서버를 끄고 restore --from 으로 이 백업을 되돌린 뒤 .env 의 키도 예전대로 돌려놓으세요.")
    print(f"  백업: {backup}")
    print("status 로 못 읽는 값이 0건인지 확인한 뒤에 SECRET_KEYS_OLD 를 지우세요.")
    return 0


# 되돌리기 - 서버가 꺼져 있을 때만. 보기만 / --yes 면 지금 파일을 먼저 백업하고 백업 사본으로 되돌린다
def command_restore(db_path:Path, backup_dir:Path, source:Path, yes:bool) -> int:
    if port_in_use():
        print(MESSAGE_SERVER_RUNNING)
        return 1
    if not source.is_file():
        print(f"백업 파일이 없습니다: {source}")
        return 1
    if db_path.exists() and source.resolve() == db_path.resolve():
        print("되돌릴 백업이 지금 DB 파일과 같습니다.")
        return 1

    migrate_verify_db(source)

    if not yes:
        print(f"서버가 꺼져 있어야 합니다. {source.name} 으로 DB 파일을 되돌립니다 (지금 파일은 먼저 백업). 실제로 하려면 --yes")
        return 0

    if db_path.exists():
        current=migrate_backup(db_path, backup_dir)
        print(f"지금 파일 백업 (integrity_check ok): {current}")

    migrate_restore_file(source, db_path)
    print(f"되돌렸습니다: {source.name} → {db_path}")
    print("백업 시점의 키(.env SECRET_KEY·SECRET_KEYS_OLD)와 맞아야 읽힙니다. 서버를 켜기 전에 status 로 확인하세요.")
    return 0


# 인자 - 명령과 공통 옵션 (--db 는 기본이 DB_URL 의 파일)
def build_parser() -> argparse.ArgumentParser:
    parser=argparse.ArgumentParser(description="로그인 이전 - 백업 → 암호화 → 주인 지정 (기본은 보기만, --yes 일 때만 쓴다)")
    common=argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", help="DB 파일 (기본: DB_URL)")
    common.add_argument("--backup-dir", help="백업 폴더 (기본: DB 파일 옆 backups/)")

    commands=parser.add_subparsers(dest="command", required=True)
    commands.add_parser("backup", parents=[common], help="검사한 백업을 만든다")
    commands.add_parser("status", parents=[common], help="평문 수·주인 없는 행 수 (읽기 전용)")
    encrypt=commands.add_parser("encrypt", parents=[common], help="평문을 암호화한다")
    encrypt.add_argument("--yes", action="store_true", help="실제로 바꾼다 (먼저 백업)")
    owner=commands.add_parser("assign-owner", parents=[common], help="주인 없는 행을 그 사용자로")
    owner.add_argument("--email", required=True, help="한 번 로그인한 계정의 이메일 (출력에 싣지 않는다)")
    owner.add_argument("--yes", action="store_true", help="실제로 바꾼다 (먼저 백업)")
    rotate=commands.add_parser("rotate-keys", parents=[common], help="옛 키 암호문을 새 키로")
    rotate.add_argument("--yes", action="store_true", help="실제로 바꾼다 (먼저 백업)")
    restore=commands.add_parser("restore", parents=[common], help="백업으로 파일을 되돌린다")
    restore.add_argument("--from", dest="source", required=True, help="백업 파일")
    restore.add_argument("--yes", action="store_true", help="실제로 되돌린다 (지금 파일도 먼저 백업)")
    return parser


# 진입 - 명령을 고르고, 실패하면 한국어로 알리고 1 (값은 mask_text 를 거친다)
def main(argv:list[str] | None=None) -> int:
    args=build_parser().parse_args(argv)

    db_path=Path(args.db).resolve() if args.db else migrate_db_path(settings.db_url)
    if db_path is None:
        print("SQLite 파일 DB 만 이전할 수 있습니다 (DB_URL 확인)")
        return 1
    backup_dir=Path(args.backup_dir).resolve() if args.backup_dir else db_path.parent / "backups"

    if args.command != "restore" and not db_path.is_file():
        print(f"DB 파일이 없습니다: {db_path}")
        return 1

    try:
        if args.command == "backup":
            return command_backup(db_path, backup_dir)
        if args.command == "status":
            return command_status(db_path)
        if args.command == "encrypt":
            return command_encrypt(db_path, backup_dir, args.yes)
        if args.command == "assign-owner":
            return command_assign_owner(db_path, backup_dir, args.email, args.yes)
        if args.command == "rotate-keys":
            return command_rotate(db_path, backup_dir, args.yes)
        return command_restore(db_path, backup_dir, Path(args.source).resolve(), args.yes)

    except Exception as e:
        print(f"실패 - 다음 단계로 넘어가지 않았습니다. 쓰는 중이었다면 그 변경은 되돌려졌고, 만든 백업은 그대로 있습니다 :{mask_text(str(e))[:300]}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
