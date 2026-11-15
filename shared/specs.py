from shared.settings import settings

# Fargate 표준 작업 크기 중 쓰는 (CPU 단위, MiB) 조합 4개 - 비용 추정(features/pricing)과 서비스 생성(features/express)이 같은 목록을 쓰도록 shared 에 둔다 (feature 끼리 직접 import 하지 않는다)
# Express 가 이 조합을 모두 받는지는 첫 실제 배포에서 확인 전
SPEC_PAIRS=(("256", "512"), ("512", "1024"), ("1024", "2048"), ("2048", "4096"))


# 사양 한 쌍이 프리셋 조합인지
def specs_pair_valid(cpu:str|None, memory:str|None) -> bool:
    return (cpu, memory) in SPEC_PAIRS


# .env 에 ECS_CPU·ECS_MEMORY 가 하나라도 적혀 있는지 (빈 글자는 안 적은 것)
def specs_env_set() -> bool:
    return bool((settings.ecs_cpu or "").strip() or (settings.ecs_memory or "").strip())


# .env 의 기본 사양 - 둘 다 적혀 있고 프리셋 조합일 때만 (cpu, memory), 아니면 None (한쪽만 있거나 프리셋이 아니면 무시한다)
def specs_env_pair() -> tuple[str, str] | None:
    cpu=(settings.ecs_cpu or "").strip()
    memory=(settings.ecs_memory or "").strip()

    if specs_pair_valid(cpu, memory):
        return cpu, memory

    return None
