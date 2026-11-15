import { INCIDENT_STATUS_BADGE, INCIDENT_STATUS_LABEL } from './constants.js'

// 인시던트 상태 배지 - 모르는 상태는 서버 글자 그대로
export default function IncidentBadge({ status }) {
  return <span className={`badge ${INCIDENT_STATUS_BADGE[status] || ''}`}>{INCIDENT_STATUS_LABEL[status] || status}</span>
}
