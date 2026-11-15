import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { incidentApi } from './api.js'
import IncidentBadge from './IncidentBadge.jsx'

// 배포 상세의 인시던트 카드 - 한 줄 요약을 받아 보여 주고 누르면 인시던트 화면, 요약을 못 받아도 카드는 남는다 (refreshKey 가 바뀌면 다시 받는다)
export default function IncidentCard({ d_id, i_id, refreshKey }) {
  const [incident, setIncident] = useState(null)

  // 다른 인시던트로 바뀌면 지난 요약을 비운다 (같은 인시던트의 갱신 때는 남겨 둔다)
  useEffect(() => { setIncident(null) }, [i_id])

  useEffect(() => {
    let alive = true
    incidentApi.getOne(i_id).then((result) => alive && setIncident(result)).catch(() => {})
    return () => { alive = false }
  }, [i_id, refreshKey])

  const summary = incident?.summary || incident?.explain?.summary || '처리 중인 문제가 있습니다'
  return (
    <Link to={`/incidents/${i_id}`} className="card incident-card" aria-label={`배포 #${d_id} 문제 상세 보기: ${summary}`}>
      <div className="row spread incident-card-head">
        <strong className="incident-card-title">문제가 있습니다</strong>
        {incident && <IncidentBadge status={incident.status} />}
      </div>
      <p className="body-text">{summary}</p>
      <span className="incident-card-more">자세히 보기 ›</span>
    </Link>
  )
}
