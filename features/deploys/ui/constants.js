// features/deploys/models.py 의 status 값과 같아야 한다
export const STEPS = [
  { key: 'cloning', label: '클론' },
  { key: 'analyzing', label: '판별' },
  { key: 'generating', label: 'Dockerfile' },
  { key: 'building', label: '빌드' },
  { key: 'pushing', label: '푸시' },
  { key: 'deploying', label: '배포' },
  { key: 'running', label: '완료' },
]

export const STATUS_LABEL = {
  queued: '대기',
  cloning: '클론 중',
  analyzing: '판별 중',
  generating: 'Dockerfile 생성 중',
  building: '빌드 중',
  pushing: '푸시 중',
  needs_input: '입력 필요',
  deploying: '배포 중',
  running: '정상',
  failed: '실패',
  stopped: '멈춤',
  deleting: '삭제 중',
  deleted: '삭제됨',
}

// 마지막 헬스체크 요약 글 (features/deploys 의 health_state 값과 같다)
export const HEALTH_STATE_LABEL = { healthy: '응답 정상', unhealthy: '응답 없음', unknown: '확인 전' }

export const PROGRESS = ['queued', 'cloning', 'analyzing', 'generating', 'building', 'pushing', 'deploying', 'deleting']

export const isProgress = (status) => PROGRESS.includes(status)

// 환경변수 목록이 생기는 단계부터 상세 화면에 환경변수 카드를 보여 준다
const ENV_CARD_STATUSES = ['analyzing', 'generating', 'building', 'pushing', 'needs_input', 'deploying', 'running', 'failed', 'stopped']

export const showsEnvCard = (status) => ENV_CARD_STATUSES.includes(status)

// 없는 배포 안내 (설정·상세 화면 공용)
export const DEPLOY_NOT_FOUND_TEXT = '배포를 찾을 수 없습니다. 이미 삭제된 배포일 수 있습니다.'

export const repoName = (repo_url) => repo_url.replace('https://github.com/', '')
