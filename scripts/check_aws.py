import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.aws_session import get_aws_session, get_credential_method, get_profile_region, get_account_id
from shared.settings import settings
from shared.masking import mask_text

from features.explains.services import Explain_Service

# 지금 설정으로 AWS에 붙는지 확인한다. 읽기 전용 - sts:GetCallerIdentity 한 번만 부른다
# aws login 직후, 또는 배포가 자격증명 에러로 멈췄을 때 실행
#
# python scripts/check_aws.py

METHOD_LABELS={
    "login": "aws login (콘솔 로그인, 최대 12시간)",
    "sso": "aws sso login (IAM Identity Center)",
    "shared-credentials-file": "액세스 키 (~/.aws/credentials)",
    "env": "환경변수 액세스 키",
}


# 실패를 한국어 해설로 출력
def print_failure(error:Exception) -> None:
    text=mask_text(f"{type(error).__name__}: {error}")
    explain=Explain_Service.services_explain_by_rule(text)

    print(f"\n실패  {text}")
    if explain:
        print(f"\n{explain.summary}\n{explain.cause}")
        for action in explain.actions:
            print(f"  - {action}")


def main():
    print(f"프로파일  {settings.aws_profile or '(default)'}")
    print(f"리전      {settings.aws_region}")

    try:
        session=get_aws_session()
        method=get_credential_method(session)

        if method is None:
            raise RuntimeError("Unable to locate credentials")

        account_id=get_account_id(session)
        profile_region=get_profile_region()

    except Exception as e:
        print_failure(e)
        sys.exit(1)

    print(f"방식      {METHOD_LABELS.get(method, method)}")
    print(f"계정      {account_id}")
    print("\n연결되었습니다.")

    if method == "login" and profile_region and profile_region != settings.aws_region:
        print(f"\n주의  aws login 은 {profile_region} 에서 했는데 .env 의 AWS_REGION 은 {settings.aws_region} 입니다.")
        print("      자격증명 갱신이 실패하면 리전을 맞춰 다시 로그인하세요 (aws configure set region 으로 바꾼 뒤 aws login).")


if __name__ == "__main__":
    main()
