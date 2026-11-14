import { toMs } from '../../../shared/ui/time.js'
import { RECOVERY_ACTION_LABEL, RECOVERY_RESULT_LABEL, RECOVERY_RESULT_TONE } from './constants.js'

// 인시던트 상세의 "마법사가 한 일" 세로 줄 - 감지, 조치마다 시작·결과, 해결 또는 확인 필요 (시간순, 같은 시각은 만든 순서)
// time 은 서버 값 그대로 (화면에서 formatTime), detail 은 서버가 마스킹한 글을 그대로 둔다
export function incidentTimeline(incident) {
  const events = []
  const add = (key, time, title, detail, tone) => events.push({ key, time, title, detail: detail || null, tone })

  add('detected', incident.detected_at, '문제를 감지했습니다', incident.summary || incident.explain?.summary, 'warn')

  const actions = [...(incident.actions || [])].sort((x, y) => {
    const diff = toMs(x.started_at) - toMs(y.started_at)
    return diff || x.r_a_id - y.r_a_id
  })
  actions.forEach((action) => {
    const name = RECOVERY_ACTION_LABEL[action.action] || action.action
    add(`action-${action.r_a_id}-start`, action.started_at, `${name} 시도`, null, 'accent')
    if (action.result !== 'running') {
      const result = RECOVERY_RESULT_LABEL[action.result] || action.result
      add(`action-${action.r_a_id}-result`, action.finished_at || action.started_at, `${name} ${result}`,
        action.detail, RECOVERY_RESULT_TONE[action.result] || 'muted')
    }
  })

  if (incident.status === 'resolved') {
    add('resolved', incident.resolved_at || incident.updated_at, '정상으로 돌아왔습니다', null, 'ok')
  } else if (incident.status === 'needs_action') {
    // 갱신 시각이 마지막 조치보다 앞서 있어도 줄은 맨 끝에 둔다
    const latest = events.reduce((a, e) => (toMs(e.time) > toMs(a.time) ? e : a), events[0])
    const time = toMs(incident.updated_at) >= toMs(latest.time) ? incident.updated_at : latest.time
    add('needs_action', time, '확인이 필요합니다', null, 'err')
  }

  // 시각을 읽을 수 없는 줄은 맨 뒤로, 같은 시각은 만든 순서 (정렬 전 번호)
  return events
    .map((event, index) => ({ event, index, ms: toMs(event.time) }))
    .sort((x, y) => {
      const xs = Number.isNaN(x.ms) ? Infinity : x.ms
      const ys = Number.isNaN(y.ms) ? Infinity : y.ms
      return xs === ys ? x.index - y.index : xs < ys ? -1 : 1
    })
    .map(({ event }) => event)
}
