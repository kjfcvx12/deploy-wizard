from pydantic_settings import BaseSettings
from pydantic import Field
from pathlib import Path

#BaseSettings 환경변수 기반 설정 관리 클래스(DB, AWS, LLM 관련설정)
#alias로 환경변수값이 있는지 확인->해당 값으로 필드 채움
class Settings(BaseSettings):
    db_url:str=Field("sqlite+aiosqlite:///./data/wizard.db", alias="DB_URL")

    # AWS - 키는 받지 않는다. 프로파일 또는 기본 자격증명 체인만 사용
    aws_profile:str|None=Field(None, alias="AWS_PROFILE")
    aws_region:str=Field("ap-northeast-2", alias="AWS_REGION")
    ecs_execution_role_arn:str|None=Field(None, alias="ECS_EXECUTION_ROLE_ARN")
    ecs_infrastructure_role_arn:str|None=Field(None, alias="ECS_INFRASTRUCTURE_ROLE_ARN")
    ecs_cpu:str|None=Field(None, alias="ECS_CPU")
    ecs_memory:str|None=Field(None, alias="ECS_MEMORY")

    # 우리가 만든 리소스 표시용 태그 (수정·삭제는 이 태그가 붙은 것만)
    managed_tag_key:str=Field("managed-by", alias="MANAGED_TAG_KEY")
    managed_tag_value:str=Field("deploy-wizard", alias="MANAGED_TAG_VALUE")

    # LLM
    llm_enabled:bool=Field(True, alias="LLM_ENABLED")
    llm_model:str=Field("claude-opus-5", alias="LLM_MODEL")

    # 빌드
    work_dir:str=Field("./data/work", alias="WORK_DIR")
    cache_dir:str=Field("./data/cache", alias="CACHE_DIR")
    build_timeout_official:int=Field(900, alias="BUILD_TIMEOUT_OFFICIAL")
    build_timeout_experimental:int=Field(1800, alias="BUILD_TIMEOUT_EXPERIMENTAL")
    fix_limit_official:int=Field(2, alias="FIX_LIMIT_OFFICIAL")
    fix_limit_experimental:int=Field(1, alias="FIX_LIMIT_EXPERIMENTAL")

    # 배포 대기
    deploy_timeout:int=Field(1200, alias="DEPLOY_TIMEOUT")
    deploy_poll_seconds:int=Field(10, alias="DEPLOY_POLL_SECONDS")

    cors_origins:str=Field("http://localhost:5173,http://127.0.0.1:5173", alias="CORS_ORIGINS")

    # M6 - shared/secrets.py 암호화 키 (Fernet)
    secret_key:str|None=Field(None, alias="SECRET_KEY")

    # M6 - GitHub App (github.com/settings/apps/new 에서 한 번 수동 등록)
    github_app_id:str|None=Field(None, alias="GITHUB_APP_ID")
    github_app_slug:str|None=Field(None, alias="GITHUB_APP_SLUG")
    github_app_private_key_path:str|None=Field(None, alias="GITHUB_APP_PRIVATE_KEY_PATH")
    github_webhook_secret:str|None=Field(None, alias="GITHUB_WEBHOOK_SECRET")

    # M6 - watches 폴링 주기 (초). 웹훅을 놓쳤을 때의 백업
    watch_poll_seconds:int=Field(3600, alias="WATCH_POLL_SECONDS")
    # M6 - 짧은 시간에 연속 푸시되면 마지막 것만 배포 (기획서 03장)
    watch_debounce_seconds:int=Field(30, alias="WATCH_DEBOUNCE_SECONDS")

    # D1 - 헬스 모니터 (running 배포의 endpoint + health_check_path 만 부른다)
    health_monitor_enabled:bool=Field(True, alias="HEALTH_MONITOR_ENABLED")
    health_interval_seconds:int=Field(60, alias="HEALTH_INTERVAL_SECONDS")
    # 연속 실패가 이 횟수에 닿으면 인시던트를 연다
    health_failure_threshold:int=Field(3, alias="HEALTH_FAILURE_THRESHOLD")
    health_timeout_seconds:int=Field(10, alias="HEALTH_TIMEOUT_SECONDS")
    health_retention_days:int=Field(7, alias="HEALTH_RETENTION_DAYS")

    # D1 - 자동 복구 한도 (Hard rule 3: 재시작·직전 정상 이미지로 되돌리기 둘뿐)
    recovery_max_attempts_per_incident:int=Field(2, alias="RECOVERY_MAX_ATTEMPTS_PER_INCIDENT")
    recovery_daily_limit:int=Field(6, alias="RECOVERY_DAILY_LIMIT")
    # 복구 동작 뒤 헬스를 다시 보기까지 기다리는 시간
    recovery_wait_seconds:int=Field(120, alias="RECOVERY_WAIT_SECONDS")
    # 이 시간 동안 정상이 이어지면 해결로 본다
    recovery_verify_seconds:int=Field(300, alias="RECOVERY_VERIFY_SECONDS")
    # 새 배포 직후 이 시간 안의 문제는 나쁜 릴리스를 의심한다
    new_release_window_seconds:int=Field(900, alias="NEW_RELEASE_WINDOW_SECONDS")

    # D1 - 알림 메일(SMTP). MAIL_HOST 또는 MAIL_TO 가 없으면 메일은 꺼진다
    mail_host:str|None=Field(None, alias="MAIL_HOST")
    mail_port:int=Field(587, alias="MAIL_PORT")
    mail_user:str|None=Field(None, alias="MAIL_USER")
    mail_password:str|None=Field(None, alias="MAIL_PASSWORD")
    mail_from:str|None=Field(None, alias="MAIL_FROM")
    mail_to:str|None=Field(None, alias="MAIL_TO")

    # D1 - 앱 푸시(Expo)와 알림에 넣을 앱 링크
    expo_push_url:str=Field("https://exp.host/--/api/v2/push/send", alias="EXPO_PUSH_URL")
    app_link_base:str=Field("deploywizard://", alias="APP_LINK_BASE")

    class Config:
        env_file=".env"
        case_sensitive=True
        extra="allow"
        populate_by_name=True

    #동적 프로퍼티
    #@property -> 메소드를 속성으로 접근가능
    @property
    def managed_tags(self) -> list[dict]:
        return [{"key": self.managed_tag_key, "value": self.managed_tag_value}]

    @property
    def work_path(self) -> Path:
        return Path(self.work_dir).resolve()

    @property
    def cache_path(self) -> Path:
        return Path(self.cache_dir).resolve()

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    # GitHub App 개인키 파일 내용 - JWT 서명에 쓴다
    @property
    def github_app_private_key(self) -> str:
        return Path(self.github_app_private_key_path).read_text(encoding="utf-8")


#전역 설정
settings=Settings()
