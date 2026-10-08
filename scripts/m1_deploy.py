import sys
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.aws_session import get_aws_session

from features.express.services import Express_Service

# M1 - 코드로 컨테이너 하나 띄우기
# 콘솔에서 손으로 한 M0 배포를 boto3로 재현한다. 스크립트 한 번 실행에 주소가 나오면 완료
#
# python scripts/m1_deploy.py
# python scripts/m1_deploy.py --image public.ecr.aws/nginx/nginx:latest --port 80 --name dw-m1-nginx
#
# 끝나면 반드시 python scripts/cleanup.py 로 지운다 (ALB는 떠 있는 동안 계속 과금)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--image", default="public.ecr.aws/nginx/nginx:latest")
    parser.add_argument("--port", type=int, default=80)
    parser.add_argument("--name", default="dw-m1-nginx")
    parser.add_argument("--health", default="/")
    args=parser.parse_args()

    # 세션은 여기서 만들어 주입한다. M6에서는 get_assumed_session 으로 바꾸기만 하면 된다
    session=get_aws_session()

    print(f"서비스 생성 :{args.name} <- {args.image}")
    created=Express_Service.services_express_create(session, args.name, args.image, args.port, args.health)
    print(f"arn :{created.service_arn}")

    status=Express_Service.services_express_wait(session, created.service_arn, on_progress=lambda m: print(f"  {m}"))

    print(f"\n완료 :{status.endpoint}")
    print("다 봤으면 python scripts/cleanup.py 로 정리하세요.")


if __name__ == "__main__":
    main()
