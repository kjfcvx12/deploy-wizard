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
