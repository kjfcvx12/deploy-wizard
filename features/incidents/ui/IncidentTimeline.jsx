import { formatTime } from '@shared/ui/time.js'

import { incidentTimeline } from './timeline.js'

// 마법사가 한 일 - 감지, 자동 조치(재시작·되돌리기)와 결과를 시간순 세로 줄로 보여 준다 (읽기 전용 기록)
export default function IncidentTimeline({ incident }) {
  const events = incidentTimeline(incident)
  return (
    <>
      <h2>마법사가 한 일</h2>
      <ol className="timeline">
        {events.map((event) => {
          const time = formatTime(event.time)
          return (
            <li key={event.key} className="tl-item">
              <span className={`tl-dot ${event.tone}`} aria-hidden="true" />
              <div className="tl-body">
                <div className="tl-title">{event.title}</div>
                {!!time && <div className="tl-time">{time}</div>}
                {!!event.detail && <div className="tl-detail">{event.detail}</div>}
              </div>
            </li>
          )
        })}
      </ol>
    </>
  )
}
