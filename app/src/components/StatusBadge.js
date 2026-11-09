import { StyleSheet, Text, View } from 'react-native'
import { STATUS_LABEL, isProgress } from '../constants'
import { radius, spacing, useColors } from '../theme'

// 상태에 맞는 색 조합 - running 정상, failed 오류, 진행 중 강조, needs_input 경고, 나머지 흐림
function badgeTone(status, colors) {
  if (status === 'running') return { bg: colors.okBg, fg: colors.ok }
  if (status === 'failed') return { bg: colors.errBg, fg: colors.err }
  if (status === 'needs_input') return { bg: colors.warnBg, fg: colors.warn }
  if (isProgress(status)) return { bg: colors.infoBg, fg: colors.accent }
  return { bg: colors.surface2, fg: colors.muted }
}

// 배포 상태 배지 (웹 StatusBadge 와 같은 의미, 점 깜빡임은 뺐다)
export default function StatusBadge({ status }) {
  const colors = useColors()
  const tone = badgeTone(status, colors)
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]} testID="status-badge">
      {status !== 'needs_input' && <View style={[styles.dot, { backgroundColor: tone.fg }]} />}
      <Text style={[styles.label, { color: tone.fg }]}>{STATUS_LABEL[status] || status}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexShrink: 0,
    paddingHorizontal: 10,
    paddingVertical: spacing.xs / 2,
    borderRadius: radius.pill,
  },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  label: { fontSize: 12, fontWeight: '700' },
})
