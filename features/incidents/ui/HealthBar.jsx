import { healthBuckets } from './health.js'

// 최근 24시간 헬스체크 막대 - 칸마다 색, 읽어 주는 글은 요약 한 줄만. checks: undefined 면 아직 받는 중(그리지 않음), null 이면 이력을 못 받은 것
export default function HealthBar({ checks, hours = 24 }) {
  if (checks === undefined) return null

  const { cells, percent } = healthBuckets(checks, Date.now(), hours)
  const label = percent === null ? `최근 ${hours}시간 확인 기록 없음` : `최근 ${hours}시간 정상 ${percent}%`

  return (
    <>
      <h2>헬스체크 이력</h2>
      {checks === null ? (
        <p className="muted small" style={{ margin: 0 }}>헬스 이력을 불러오지 못했습니다</p>
      ) : (
        <div role="img" aria-label={label}>
          <div className="health-bar">
            {cells.map((cell, i) => <span key={i} className={`hb-cell ${cell}`} />)}
          </div>
          <div className="health-axis">
            <span>{`${hours}시간 전`}</span>
            <span>{percent === null ? '확인 기록 없음' : `정상 ${percent}%`}</span>
            <span>지금</span>
          </div>
        </div>
      )}
    </>
  )
}
