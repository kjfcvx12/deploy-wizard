import sys
import asyncio
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.database import AsyncSessionLocal
from shared.masking import mask_text
from shared.settings import settings

from features.deploys.services import Deploy_Service
from features.accounts.services import Aws_Account_Service
from features.express.services import Express_Service

# 작업 종료 - 요금이 나가는 것을 모두 멈추고, 다음에 그대로 이어서 할 수 있게 한다 (CLAUDE.md "End of session")
#   - 떠 있는 배포: ECS 서비스를 내린다. 기록은 `stopped`로 남는다
#   - 올려 둔 이미지: ECR 저장소를 지운다 (--keep-images 면 남긴다. 다시 켤 때 빌드를 건너뛰는 대신 저장 요금이 조금 나간다)
#   - 콘솔에 올렸던 템플릿 파일: S3 에서 지운다
# 남기는 것(무료): CloudFormation 스택과 IAM 역할, GitHub 앱 설치, data/wizard.db, .env
# 이어서 하기: aws login -> 서버 실행 -> 화면에서 멈춘 배포의 [다시 켜기]
#
# python scripts/session_end.py                  무엇을 멈출지 보기만
# python scripts/session_end.py --yes            실제로 멈춘다
# python scripts/session_end.py --yes --keep-images

LABELS={
    "stopped": "서비스 내림",
    "purged": "이미지 삭제",
    "in_progress": "진행 중이라 건너뜀 (끝난 뒤 다시 실행하세요)",
    "failed": "실패",
}


# 연결된 계정마다 - 올렸던 템플릿 파일을 지우고, 우리 태그가 붙은 채 남은 것이 있는지 본다
async def sweep_accounts(db, dry_run:bool) -> list[str]:
    lines=[]
    targets=[(None, "개발 계정")]
    targets+=[(account.a_id, f"연결 '{account.label}'") for account in await Aws_Account_Service.services_aws_account_get_all(db)
              if account.status == 'verified']

    for a_id, name in targets:
        try:
            session=await Aws_Account_Service.services_aws_account_build_session(db, a_id)

            if a_id is not None:
                files=await asyncio.to_thread(Aws_Account_Service.services_aws_account_template_files_list, session)
                if files and not dry_run:
                    await asyncio.to_thread(Aws_Account_Service.services_aws_account_template_files_delete, session)
                if files:
                    lines.append(f"  템플릿 파일 {len(files)}개 {'삭제 예정' if dry_run else '삭제'}  {name}")

            left=await asyncio.to_thread(Express_Service.services_express_list_managed, session)
            for resource in left:
                lines.append(f"  남아 있음  [{resource.kind}] {resource.arn}  ({name})")

        except Exception as e:
            lines.append(f"  확인 못 함  {name} :{mask_text(str(e))[:160]}")

    return lines


async def run(dry_run:bool, keep_images:bool) -> int:
    async with AsyncSessionLocal() as db:
        report=await Deploy_Service.services_deploy_session_end(db, keep_images=keep_images, dry_run=dry_run)
        sweep=await sweep_accounts(db, dry_run)

    print("작업 종료 점검" + (" (보기만 - 실제로 멈추려면 --yes)" if dry_run else ""))
    print(f"리전 {settings.aws_region}\n")

    touched=False
    for key, label in LABELS.items():
        for item in report[key]:
            touched=True
            print(f"  {label}{' 예정' if dry_run and key in ('stopped', 'purged') else ''}  {item}")

    if not touched:
        print("  멈출 배포가 없습니다. 떠 있는 서비스도, 올려 둔 이미지도 없습니다.")

    if sweep:
        print("\n계정 점검")
        print("\n".join(sweep))

    if any("aws login" in line for line in sweep + report["failed"]):
        print("\nAWS 로그인이 만료되었습니다. aws login 을 다시 한 뒤 이 스크립트를 한 번 더 실행하세요 - 그 전에는 AWS 쪽을 확인하거나 멈출 수 없습니다.")

    leftovers=[line for line in sweep if "남아 있음" in line]
    if leftovers and not dry_run:
        print("\n방금 내린 서비스는 사라지는 데 몇 분 걸립니다. 계속 남아 있으면 python scripts/cleanup.py 로 확인하세요.")

    print("\n남겨 둔 것(무료): CloudFormation 스택·IAM 역할, GitHub 앱 설치, 배포 기록(data/wizard.db), .env")
    print("이어서 하려면: aws login -> 서버 실행 -> 화면에서 멈춘 배포의 [다시 켜기]")

    return 1 if report["failed"] else 0


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--yes", action="store_true", help="실제로 멈춘다")
    parser.add_argument("--keep-images", action="store_true", help="ECR 이미지는 남긴다 (다시 켤 때 빌드를 건너뛴다)")
    args=parser.parse_args()

    sys.exit(asyncio.run(run(dry_run=not args.yes, keep_images=args.keep_images)))


if __name__ == "__main__":
    main()
