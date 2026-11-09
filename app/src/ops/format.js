import { RECOVERY_ACTION_LABEL, RECOVERY_RESULT_LABEL, RECOVERY_RESULT_TONE } from './constants'

// 서버 시각을 밀리초로 읽는다 - 서버는 UTC 를 Z 없이 보내므로 시간대 표시가 없으면 UTC 로 본다 (읽을 수 없으면 NaN)
const toMs = (iso) => {
  if (typeof iso !== 'string' || !iso) return NaN
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)
  return new Date(hasZone ? iso : `${iso}Z`).getTime()
}

// 기기의 현지 시각으로 "11월 9일 12:12" 를 만든다 (읽을 수 없으면 빈 글자)
export function formatTime(iso) {
  const ms = toMs(iso)
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 두 시각 사이를 "3분 20초" 처럼 보여 준다 (읽을 수 없거나 b 가 a 보다 앞이면 빈 글자)
export function durationText(a, b) {
  const from = toMs(a)
  const to = toMs(b)
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return ''
  const total = Math.floor((to - from) / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const join = (big, bigUnit, small, smallUnit) => (small ? `${big}${bigUnit} ${small}${smallUnit}` : `${big}${bigUnit}`)
  if (days) return join(days, '일', hours, '시간')
  if (hours) return join(hours, '시간', minutes, '분')
  if (minutes) return join(minutes, '분', seconds, '초')
  return `${seconds}초`
}

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
