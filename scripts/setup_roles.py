import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.aws_session import get_aws_session

# Express Mode에 필요한 IAM 역할 두 개를 만든다 (한 번만 실행)
# 역할 이름·신뢰 정책·정책 ARN은 Amazon ECS 개발자 안내서
# "Create your first Express Mode service using the AWS CLI" Step 1 그대로다
#
# python scripts/setup_roles.py

ROLES=[
    {
        "name": "ecsTaskExecutionRole",
        "principal": "ecs-tasks.amazonaws.com",
        "policy_arn": "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
        "env": "ECS_EXECUTION_ROLE_ARN",
    },
    {
        "name": "ecsInfrastructureRoleForExpressServices",
        "principal": "ecs.amazonaws.com",
        "policy_arn": "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices",
        "env": "ECS_INFRASTRUCTURE_ROLE_ARN",
    },
]


# 역할 없으면 생성, 있으면 그대로 사용
def setup_role(session, role:dict) -> str:
    iam=session.client("iam")

    try:
        role_arn=iam.get_role(RoleName=role["name"])["Role"]["Arn"]
        print(f"이미 있음  {role['name']}")

    except iam.exceptions.NoSuchEntityException:
        trust={
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"Service": role["principal"]},
                "Action": "sts:AssumeRole",
            }],
        }
        role_arn=iam.create_role(
            RoleName=role["name"],
            AssumeRolePolicyDocument=json.dumps(trust),
            Tags=[{"Key": "managed-by", "Value": "deploy-wizard"}],
        )["Role"]["Arn"]
        print(f"생성       {role['name']}")

    iam.attach_role_policy(RoleName=role["name"], PolicyArn=role["policy_arn"])
    return role_arn


def main():
    session=get_aws_session()

    print("아래 두 줄을 .env 에 넣으세요\n")
    lines=[f"{role['env']}={setup_role(session, role)}" for role in ROLES]
    print()
    print("\n".join(lines))
    print("\n방금 만든 역할은 전파에 1분쯤 걸립니다. 바로 배포하면 assume role 에러가 날 수 있습니다.")


if __name__ == "__main__":
    main()
