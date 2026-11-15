import { StyleSheet, View } from 'react-native'
import { Text } from '../Text'
import { toMs } from '../../ops/format'
import { radius, spacing, useColors } from '../../theme'

const SLOT_MS = 15 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MAX_HOURS = 24

// 헬스체크 이력을 15분 칸으로 나눈다 - 칸은 ok | failed | none (실패가 하나라도 있으면 failed), 퍼센트는 점검 횟수 기준 (없으면 null)
// 기준 끝은 지금과 가장 늦은 기록 중 늦은 쪽이다 (기기 시계가 서버보다 늦어도 최근 기록을 버리지 않는다)
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

// 최근 24시간 헬스체크 막대 - 칸마다 색, 접근성에는 요약 한 줄만 (칸은 숨긴다). checks 가 null 이면 이력을 못 받은 것
export default function HealthBar({ checks, now, hours = MAX_HOURS }) {
  const colors = useColors()
  const failedLoad = checks === null || checks === undefined
  const { cells, percent } = healthBuckets(checks, now, hours)
  const label = percent === null ? `최근 ${hours}시간 확인 기록 없음` : `최근 ${hours}시간 정상 ${percent}%`
  const paint = { ok: colors.ok, failed: colors.err, none: colors.border }

  return (
    <View style={styles.wrap}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>헬스체크 이력</Text>
      {failedLoad ? (
        <Text style={[styles.note, { color: colors.muted }]}>헬스 이력을 불러오지 못했습니다</Text>
      ) : (
        <View accessible accessibilityRole="image" accessibilityLabel={label} style={styles.wrap}>
          <View style={styles.bar}>
            {cells.map((cell, i) => (
              <View
                key={i}
                testID="health-cell"
                aria-hidden
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[styles.cell, { backgroundColor: paint[cell] }]}
              />
            ))}
          </View>
          <View style={styles.axis}>
            <Text style={[styles.note, { color: colors.muted }]}>{`${hours}시간 전`}</Text>
            <Text style={[styles.note, { color: colors.muted }]}>{percent === null ? '확인 기록 없음' : `정상 ${percent}%`}</Text>
            <Text style={[styles.note, { color: colors.muted }]}>지금</Text>
          </View>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  title: { fontSize: 15, fontWeight: '700' },
  bar: { flexDirection: 'row', height: 28, gap: 1 },
  cell: { flex: 1, minWidth: 0, borderRadius: radius.sm / 3 },
  axis: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  note: { fontSize: 12, lineHeight: 16 },
})
