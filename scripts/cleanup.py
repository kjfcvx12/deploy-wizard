import sys
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.aws_session import get_aws_session
from shared.settings import settings

from features.express.services import Express_Service

# 정리 스크립트 - 실습 끝날 때마다 한 번 (기획서 05장)
# managed-by=deploy-wizard 태그가 붙은 것만 찾는다. 다른 리소스는 건드리지 않는다
#
# python scripts/cleanup.py          목록만 보기
# python scripts/cleanup.py --yes    실제로 삭제


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--yes", action="store_true", help="실제로 삭제한다")
    args=parser.parse_args()

    session=get_aws_session()
    resources=Express_Service.services_express_list_managed(session)

    if not resources:
        print(f"{settings.managed_tag_key}={settings.managed_tag_value} 태그가 붙은 리소스가 없습니다.")
        return

    print(f"{settings.managed_tag_key}={settings.managed_tag_value} 리소스 {len(resources)}개\n")
    for resource in resources:
        print(f"  [{resource.kind}] {resource.arn}")

    if not args.yes:
        print("\n목록만 표시했습니다. 삭제하려면 --yes 를 붙이세요.")
        return

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


if __name__ == "__main__":
    main()
