import boto3
import uuid

from shared.settings import settings

# 설계 제약 (기획서 03장) - 모든 AWS 호출은 세션을 주입받는다
# 전역 boto3.client(...) 금지. M6에서 아래 assume 세션으로 갈아끼우기만 하면 된다


# 개발 중 - 내 계정 세션
# aws login 프로파일(login_session)도 여기로 들어온다 - botocore 가 ~/.aws/login/cache 토큰을 읽고 알아서 갱신한다 (awscrt 필요)
def get_aws_session() -> boto3.Session:
    if settings.aws_profile:
        return boto3.Session(profile_name=settings.aws_profile, region_name=settings.aws_region)
    return boto3.Session(region_name=settings.aws_region)


# 세션이 자격증명을 얻은 방식 - aws login 이면 'login', 못 찾으면 None
def get_credential_method(session:boto3.Session) -> str|None:
    creds=session.get_credentials()
    return creds.method if creds else None


# 프로파일에 적힌 리전 (aws login 할 때 고른 값) - 없으면 None
def get_profile_region() -> str|None:
    if settings.aws_profile:
        return boto3.Session(profile_name=settings.aws_profile).region_name
    return boto3.Session().region_name


# M6 - 사용자 역할을 위임받은 1시간짜리 세션
def get_assumed_session(role_arn:str, external_id:str, base_session:boto3.Session|None=None) -> boto3.Session:
    base=base_session or get_aws_session()
    sts=base.client("sts")

    result=sts.assume_role(
        RoleArn=role_arn,
        RoleSessionName=f"deploy-wizard-{uuid.uuid4().hex[:8]}",
        ExternalId=external_id,
        DurationSeconds=3600,
    )

    creds=result["Credentials"]

    return boto3.Session(
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
        region_name=base.region_name,
    )


# 세션의 계정 id 조회
def get_account_id(session:boto3.Session) -> str:
    return session.client("sts").get_caller_identity()["Account"]
