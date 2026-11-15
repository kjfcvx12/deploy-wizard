// 서버 시각을 밀리초로 읽는다 - 서버는 UTC 를 Z 없이 보내므로 시간대 표시가 없으면 UTC 로 본다 (읽을 수 없으면 NaN)
export function toMs(iso) {
  if (typeof iso !== 'string' || !iso) return NaN
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)
  // 소수점 초는 3자리(밀리초)까지만 둔다
  const trimmed = iso.replace(/(\.\d{3})\d+/, '$1')
  return new Date(hasZone ? trimmed : `${trimmed}Z`).getTime()
}

// 브라우저의 현지 시각으로 "11월 9일 12:12" 를 만든다 (읽을 수 없으면 빈 글자)
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
