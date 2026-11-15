import { toMs } from '../../../shared/ui/time.js'

const SLOT_MS = 15 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MAX_HOURS = 24

// 헬스체크 이력을 15분 칸으로 나눈다 - 칸은 ok | failed | none (실패가 하나라도 있으면 failed), 퍼센트는 점검 횟수 기준 (없으면 null)
// 기준 끝은 지금과 가장 늦은 기록 중 늦은 쪽이다 (브라우저 시계가 서버보다 늦어도 최근 기록을 버리지 않는다)
export function healthBuckets(checks, now = Date.now(), hours = MAX_HOURS) {
  const count = Math.max(1, Math.min(96, Math.round((hours * HOUR_MS) / SLOT_MS)))
  const span = count * SLOT_MS
  const parsed = (Array.isArray(checks) ? checks : [])
    .filter((c) => c && typeof c === 'object' && typeof c.ok === 'boolean')
    .map((c) => ({ ok: c.ok, ms: toMs(c.checked_at) }))
    .filter((c) => !Number.isNaN(c.ms))
  const end = parsed.reduce((latest, c) => Math.max(latest, c.ms), now)
  const start = end - span
  const cells = Array(count).fill('none')
  let total = 0
  let okCount = 0
  parsed.forEach((c) => {
    if (c.ms < start) return
    const slot = Math.min(count - 1, Math.floor((c.ms - start) / SLOT_MS))
    total += 1
    if (c.ok) okCount += 1
    if (!c.ok) cells[slot] = 'failed'
    else if (cells[slot] === 'none') cells[slot] = 'ok'
  })
  let percent = null
  if (total > 0) {
    percent = Math.round((okCount / total) * 100)
    if (okCount < total) percent = Math.min(99, percent)
    if (okCount > 0) percent = Math.max(1, percent)
  }
  return { cells, percent }
}
