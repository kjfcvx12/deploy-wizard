// 웹의 상수와 같은 값 - features/deploys/ui/constants.js, features/envvars/ui/constants.js, features/advice/ui/constants.js
// 상태값 문자열은 여기서만 정의한다 (features/deploys/models.py 의 status 와 같아야 한다)
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

export const PROGRESS = ['queued', 'cloning', 'analyzing', 'generating', 'building', 'pushing', 'deploying', 'deleting']

// 진행 중인 상태인지 (needs_input 은 사용자를 기다리는 중이라 진행 중이 아니다)
export const isProgress = (status) => PROGRESS.includes(status)

// 환경변수 목록이 생기는 단계부터 상세 화면에 환경변수 카드를 보여 준다
const ENV_CARD_STATUSES = ['analyzing', 'generating', 'building', 'pushing', 'needs_input', 'deploying', 'running', 'failed', 'stopped']

export const showsEnvCard = (status) => ENV_CARD_STATUSES.includes(status)

export const repoName = (repo_url) => repo_url.replace('https://github.com/', '')

// features/envvars 의 kind 값과 같아야 한다 (docs/api-spec.md Env_Read)
export const ENV_KINDS = [
  { key: 'database', label: '데이터베이스 주소' },
  { key: 'cache', label: '캐시 주소' },
  { key: 'external_api', label: '외부 서비스 키' },
  { key: 'secret', label: '비밀값' },
  { key: 'config', label: '일반 설정' },
]

// 시크릿으로 다루는 종류 - 값 입력을 받지 않는다 (서버가 501)
export const ENV_SECRET_KINDS = new Set(['database', 'cache', 'external_api', 'secret'])

// 종류 키를 한국어 이름으로 바꾼다 (모르는 키는 '알 수 없음')
export const kindLabel = (key) => ENV_KINDS.find((k) => k.key === key)?.label || '알 수 없음'

// docs/api-spec.md Deploy_Advice 의 값과 같아야 한다
export const TIER_LABEL = { small: '가벼움', medium: '보통', large: '무거움' }

export const CONFIDENCE_LABEL = { high: '높음', medium: '보통', low: '낮음' }

export const NEED_LABEL = {
  database: '데이터베이스',
  cache: '캐시',
  worker: '백그라운드 작업',
  env_vars: '환경변수',
  disk_write: '디스크 쓰기',
  static_site: '정적 사이트',
}

// 모르는 키는 키 그대로 보여 준다
export const tierLabel = (key) => TIER_LABEL[key] || key
export const confidenceLabel = (key) => CONFIDENCE_LABEL[key] || key
export const needLabel = (key) => NEED_LABEL[key] || key
