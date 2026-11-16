import sys
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.aws_session import get_aws_session
from shared.settings import settings
from shared.migrate import migrate_db_path, migrate_plaintext_count_file, MESSAGE_ACCOUNTS_UNMIGRATED

# 모델을 import 해야 이전(암호화) 검사가 암호화 열을 안다
from features.accounts import models as account_models
from features.notifications import models as notification_models
from features.auth import models as auth_models

from features.express.services import Express_Service

# 정리 스크립트 - 실습 끝날 때마다 한 번 (기획서 05장)
# managed-by=deploy-wizard 태그가 붙은 것만 찾는다. 다른 리소스는 건드리지 않는다
# 개발 계정(.env 의 프로파일)만 본다. DB 가 이전(암호화) 전이면 끝에 알리고 0 이 아닌 값으로 끝낸다 (DB 는 읽기 전용으로만 연다)
#
# python scripts/cleanup.py          목록만 보기
# python scripts/cleanup.py --yes    실제로 삭제


# 이전(암호화) 전 값이 남은 연결 계정 수 - 못 세면 None
def accounts_plaintext_count() -> int | None:
    try:
        counts=migrate_plaintext_count_file(migrate_db_path(settings.db_url))
    except Exception:
        return None
    return sum(count for key, count in counts.items() if key.startswith("aws_accounts."))


# 목록을 보이고 --yes 면 지운다. 반환: 종료 코드 (이전 전 DB 면 2)
def run(yes:bool) -> int:
    plaintext_accounts=accounts_plaintext_count()

    session=get_aws_session()
    resources=Express_Service.services_express_list_managed(session)

    if not resources:
        print(f"{settings.managed_tag_key}={settings.managed_tag_value} 태그가 붙은 리소스가 없습니다 (개발 계정).")
        return unmigrated_notice(plaintext_accounts)

    print(f"{settings.managed_tag_key}={settings.managed_tag_value} 리소스 {len(resources)}개\n")
    for resource in resources:
        print(f"  [{resource.kind}] {resource.arn}")

    if not yes:
        print("\n목록만 표시했습니다. 삭제하려면 --yes 를 붙이세요.")
        return unmigrated_notice(plaintext_accounts)

    print()
    for resource in resources:
        try:
            if resource.kind == "ecs_service":
                Express_Service.services_express_delete(session, resource.arn)
            else:
                Express_Service.services_express_delete_repository(session, resource.name)
            print(f"삭제 요청  {resource.arn}")

        except Exception as e:
            print(f"삭제 실패  {resource.arn} :{e}")

    print("\nALB·보안그룹 등 Express Mode가 만든 나머지는 서비스 삭제가 끝나면 AWS가 회수합니다.")
    print("몇 분 뒤 콘솔에서 로드밸런서가 남아 있지 않은지 한 번 확인하세요.")
    return unmigrated_notice(plaintext_accounts)


# 이전 전 DB 안내 - 연결 계정 쪽을 "남은 것 없음"으로 착각하지 않게 맨 끝에 알리고 2. 아니면 0
def unmigrated_notice(plaintext_accounts:int | None) -> int:
    if not plaintext_accounts:
        return 0

    print("\n주의 - " + MESSAGE_ACCOUNTS_UNMIGRATED)
    return 2


# 진입 - 인자를 읽고 종료 코드로 끝낸다
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--yes", action="store_true", help="실제로 삭제한다")
    args=parser.parse_args()

    sys.exit(run(args.yes))


if __name__ == "__main__":
    main()
