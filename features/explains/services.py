import re
import hashlib

from shared.settings import settings
from shared.llm import LLM_Client, LLM_Unavailable
from shared.masking import mask_text

from features.explains.scheme import Explain_Result

# 에러 해설 - 규칙 필터 먼저, 모르는 것만 LLM에 묻는다 (기획서 07장 비용 구조)
# 같은 에러는 반드시 다시 만난다. 만날 때마다 아래 표에 추가한다 (기획서 06장 작업 규칙)
# 규칙에 없는 에러는 에러 시그니처로 캐시한다 - 같은 문구가 다시 나오면 LLM을 다시 부르지 않는다

SYSTEM_EXPLAIN="""너는 배포 도구의 에러 해설 담당이다. 배포가 실패한 단계와 로그를 보고 한국어로 설명한다.
- 독자는 배포를 처음 해 보는 개발자다. 용어는 풀어서 쓴다.
- 로그에 근거가 있는 원인만 말한다. 근거가 없으면 모른다고 쓴다.
- 조치는 사용자가 직접 할 수 있는 것만, 구체적인 순서로 쓴다.
- 비밀 값으로 보이는 문자열은 옮겨 적지 않는다."""

# (패턴, 요약, 원인, 조치)
EXPLAIN_RULES=[
    (re.compile(r"exec format error", re.I),
     "이미지의 CPU 아키텍처가 맞지 않습니다.",
     "arm64(M1/M2 맥 등)에서 만든 이미지를 amd64 서버에서 실행하려 했습니다. 실행 파일 형식이 달라 컨테이너가 시작하자마자 죽습니다.",
     ["docker build 에 --platform linux/amd64 를 붙여 다시 빌드합니다.", "베이스 이미지가 amd64를 지원하는지 확인합니다."]),

    (re.compile(r"no basic auth credentials|authorization token has expired|denied: Your authorization token", re.I),
     "ECR 로그인이 만료되었거나 되어 있지 않습니다.",
     "ECR 로그인 토큰은 12시간이면 만료됩니다. 어제 되던 푸시가 오늘 안 되는 가장 흔한 이유입니다.",
     ["다시 배포하면 토큰을 새로 받습니다.", "계속 실패하면 AWS 자격증명(프로파일)이 유효한지 확인합니다."]),

    (re.compile(r"AccessDenied|is not authorized to perform|UnauthorizedOperation", re.I),
     "AWS 권한이 부족합니다.",
     "지금 쓰는 자격증명에 이 작업을 할 권한이 없습니다. 에러 메시지의 'not authorized to perform' 뒤에 나오는 동작 이름이 빠진 권한입니다.",
     ["에러에 나온 동작(예: ecs:CreateExpressGatewayService)을 IAM 정책에 추가합니다.", "처음에는 넓게 열고, 배포가 된 뒤에 좁히는 편이 빠릅니다."]),

    (re.compile(r"Unable to assume the service linked role|cannot be assumed|iam:PassRole", re.I),
     "ECS가 역할을 넘겨받지 못했습니다.",
     "방금 만든 IAM 역할은 전파되는 데 1분쯤 걸립니다. 또는 내 자격증명에 iam:PassRole 권한이 없습니다.",
     ["1분 뒤에 다시 배포합니다.", "계속 실패하면 iam:PassRole 권한과 역할의 신뢰 정책(ecs.amazonaws.com, ecs-tasks.amazonaws.com)을 확인합니다."]),

    (re.compile(r"reauthenticate (?:using|with) 'aws login'|running 'aws login' again|signin:CreateOAuth2Token|refreshing a login session profile", re.I),
     "aws login 세션이 만료되었거나 없습니다.",
     "aws login 으로 받은 임시 자격증명은 최대 12시간까지만 자동으로 갱신됩니다. 그 시간이 지났거나, 이 프로파일로 아직 로그인한 적이 없거나, 콘솔 비밀번호가 바뀌었습니다.",
     ["터미널에서 aws login 을 다시 실행합니다 (.env에 AWS_PROFILE 이 있으면 aws login --profile <이름>).", "IAM 사용자라면 SignInLocalDevelopmentAccess 정책이 붙어 있는지 확인합니다.", "python scripts/check_aws.py 로 연결을 확인한 뒤 다시 배포합니다."]),

    (re.compile(r"pip install \"?botocore\[crt\]", re.I),
     "aws login 프로파일을 읽는 데 필요한 패키지가 없습니다.",
     "aws login 자격증명은 서명에 awscrt 패키지를 씁니다. 가상환경에 이 패키지가 설치되어 있지 않습니다.",
     ["pip install -r requirements.txt 를 다시 실행합니다."]),

    (re.compile(r"Unable to locate credentials|NoCredentialsError|ExpiredToken|InvalidClientTokenId|The config profile \(.*?\) could not be found", re.I),
     "AWS 자격증명을 찾지 못했거나 만료되었습니다.",
     "이 컴퓨터에 AWS 자격증명이 설정되어 있지 않거나, 임시 자격증명의 수명이 끝났습니다.",
     ["aws login 으로 로그인합니다 (액세스 키를 만들지 않아도 됩니다).", ".env의 AWS_PROFILE 이름이 맞는지 확인합니다."]),

    (re.compile(r"AWS 계정 연결이 완료되지 않았습니다|is not authorized to assume role|AccessDenied.*AssumeRole", re.I),
     "연결된 AWS 계정에 배포할 수 없습니다.",
     "역할 ARN이 아직 등록되지 않았거나, 사용자가 CloudFormation 스택을 지워 연결이 끊어졌습니다 (기획서 03장 - 언제든 회수 가능).",
     ["/accounts 화면에서 연결 상태를 확인합니다.", "스택을 다시 만들고 역할 ARN을 다시 붙여넣습니다."]),

    (re.compile(r"GitHub 연결이 끊어졌습니다|Bad credentials|GitHub App.*suspended", re.I),
     "연결된 GitHub 설치에 접근할 수 없습니다.",
     "사용자가 GitHub App을 제거했거나 설치를 일시 중지했습니다 (기획서 03장 - 언제든 회수 가능). 또는 GitHub App 설정(개인키·App ID)이 서버에 잘못 등록돼 있습니다.",
     ["/accounts 화면에서 GitHub 연결 상태를 확인합니다.", "github.com/settings/installations 에서 앱이 설치돼 있는지 확인합니다.", "다시 연결이 필요하면 [GitHub 연결]로 재설치합니다."]),

    (re.compile(r"default VPC|no subnets? (?:found|available)", re.I),
     "기본 VPC 또는 서브넷을 찾지 못했습니다.",
     "Express Mode는 기본 VPC의 퍼블릭 서브넷에 로드밸런서를 만듭니다. 계정에 기본 VPC가 없으면 실패합니다.",
     ["VPC 콘솔에서 '기본 VPC 생성'을 실행합니다.", "다른 리전을 쓰고 있다면 .env의 AWS_REGION 을 확인합니다."]),

    (re.compile(r"Cannot connect to the Docker daemon|docker daemon is not running|error during connect", re.I),
     "Docker가 실행 중이 아닙니다.",
     "이미지를 빌드하려면 이 컴퓨터에서 Docker 엔진이 돌고 있어야 합니다.",
     ["Docker Desktop을 실행하고 완전히 켜질 때까지 기다린 뒤 다시 배포합니다."]),

    (re.compile(r"Repository not found|Authentication failed|could not read Username", re.I),
     "레포를 가져오지 못했습니다.",
     "주소가 틀렸거나, private 레포인데 GitHub 연결이 없거나, 연결한 GitHub 앱에 이 레포가 허용되어 있지 않습니다.",
     ["주소를 브라우저에 붙여 넣어 열리는지 확인합니다.",
      "private 레포면 계정 연결에서 GitHub를 연결하고, 배포할 때 그 연결 블록을 고릅니다.",
      "GitHub 앱을 '선택한 레포만'으로 설치했다면 github.com/settings/installations 에서 이 레포를 추가하거나 All repositories 로 바꿉니다."]),

    (re.compile(r"Remote branch .* not found", re.I),
     "브랜치를 찾지 못했습니다.",
     "입력한 브랜치가 레포에 없습니다.",
     ["브랜치 이름의 철자와 대소문자를 확인합니다."]),

    (re.compile(r"ERROR: (?:Could not find a version|No matching distribution)", re.I),
     "파이썬 패키지 설치에 실패했습니다.",
     "requirements.txt에 적힌 버전이 이 파이썬 버전용으로 배포되지 않았습니다. 주로 파이썬 버전과 패키지 버전이 안 맞을 때 납니다.",
     ["로그에서 실패한 패키지 이름을 확인합니다.", "로컬에서 쓰는 파이썬 버전을 .python-version 파일에 적어 둡니다."]),

    (re.compile(r"npm ERR!|npm error", re.I),
     "npm 설치 또는 빌드에 실패했습니다.",
     "의존성 설치나 build 스크립트가 0이 아닌 코드로 끝났습니다. 로그의 첫 번째 npm error 줄이 실제 원인입니다.",
     ["로컬에서 npm ci && npm run build 가 되는지 확인합니다.", "package-lock.json이 package.json과 맞는지 확인합니다."]),

    (re.compile(r"health ?check|unhealthy|Target\.FailedHealthChecks", re.I),
     "헬스체크에 실패했습니다.",
     "컨테이너는 떴지만 로드밸런서가 보낸 확인 요청에 200으로 답하지 못했습니다. 포트가 다르거나, 127.0.0.1에만 바인딩했거나, 시작할 때 DB 연결에 실패해 앱이 죽었을 수 있습니다.",
     ["서버가 0.0.0.0 에 바인딩하는지 확인합니다.", "앱이 듣는 포트와 배포에 쓴 포트가 같은지 확인합니다.", "시작할 때 필요한 환경변수·DB가 있는지 CloudWatch 로그에서 확인합니다."]),

    (re.compile(r"시간 초과|timed? ?out", re.I),
     "시간 안에 끝나지 않았습니다.",
     "정해 둔 대기 시간을 넘겼습니다. 빌드가 원래 오래 걸리는 언어이거나, 네트워크가 느리거나, 배포가 진행되지 못하고 멈춰 있습니다.",
     ["다시 배포해 봅니다.", "빌드가 원래 오래 걸린다면 .env의 BUILD_TIMEOUT 값을 늘립니다."]),
]


class Explain_Service:

    # 에러 해설 - 규칙에 걸리면 LLM을 부르지 않는다. 규칙에도 없으면 시그니처 캐시를 본다
    @staticmethod
    async def services_explain_error(step:str, error_msg:str, log_tail:str="") -> Explain_Result:
        text=mask_text(f"{error_msg}\n{log_tail}")

        by_rule=Explain_Service.services_explain_by_rule(text)
        if by_rule:
            return by_rule

        signature=Explain_Service.services_explain_signature(step, error_msg)
        cached=Explain_Service.services_explain_cache_get(signature)
        if cached:
            return cached

        try:
            result=await LLM_Client.llm_parse(
                SYSTEM_EXPLAIN,
                f"실패한 단계: {step}\n\n## 에러\n{mask_text(error_msg)}\n\n## 로그 (마지막 부분)\n{text[-6000:]}",
                Explain_Result,
            )
            result.source="llm"
            Explain_Service.services_explain_cache_set(signature, result)
            return result

        except LLM_Unavailable:
            return Explain_Result(
                summary=f"{step} 단계에서 실패했습니다.",
                cause="알려진 에러 목록에 없는 실패입니다. 아래 로그의 마지막 부분에 원인이 있습니다.",
                actions=["로그의 마지막 에러 줄을 확인합니다.", "LLM을 켜면(LLM_ENABLED=true) 원인을 풀어서 설명해 줍니다."],
                source="none",
            )


    # 규칙 기반 해설
    @staticmethod
    def services_explain_by_rule(text:str) -> Explain_Result|None:
        for pattern, summary, cause, actions in EXPLAIN_RULES:
            if pattern.search(text):
                return Explain_Result(summary=summary, cause=cause, actions=actions, source="rule")
        return None


    # 에러 시그니처 - 같은 에러는 문구가 거의 그대로 반복된다. 로그 꼬리는 변하는 부분이라 뺀다
    @staticmethod
    def services_explain_signature(step:str, error_msg:str) -> str:
        normalized=" ".join(mask_text(error_msg).lower().split())[:500]
        return hashlib.sha256(f"{step}|{normalized}".encode("utf-8")).hexdigest()[:32]


    # 캐시 조회
    @staticmethod
    def services_explain_cache_get(signature:str) -> Explain_Result|None:
        path=settings.cache_path / f"explain_{signature}.json"

        if not path.is_file():
            return None

        try:
            result=Explain_Result.model_validate_json(path.read_text(encoding="utf-8"))
            result.cached=True
            return result
        except Exception:
            return None


    # 캐시 저장 - LLM이 만든 해설만 저장한다 (규칙은 이미 공짜, LLM 없을 때의 기본 안내는 다시 물어야 한다)
    @staticmethod
    def services_explain_cache_set(signature:str, result:Explain_Result) -> None:
        settings.cache_path.mkdir(parents=True, exist_ok=True)
        path=settings.cache_path / f"explain_{signature}.json"
        path.write_text(result.model_dump_json(), encoding="utf-8")
