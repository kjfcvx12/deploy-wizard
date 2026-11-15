import { HEALTH_STATE_LABEL } from './constants.js'

// 서버 응답 상태 점 - 모르는 값이나 값이 없으면(옛 서버) 그리지 않는다
export default function HealthDot({ state }) {
  if (!Object.hasOwn(HEALTH_STATE_LABEL, state)) return null
  const label = HEALTH_STATE_LABEL[state]
  const tone = state === 'healthy' ? 'ok' : state === 'unhealthy' ? 'err' : 'muted'
  return <span className={`health-dot ${tone}`} role="img" aria-label={`헬스체크: ${label}`} title={label} />
}
