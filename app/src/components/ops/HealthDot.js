import { StyleSheet, Text, View } from 'react-native'
import { HEALTH_STATE_LABEL } from '../../ops/constants'
import { spacing, useColors } from '../../theme'

// 서버 응답 상태 점 - 모르는 값이나 값이 없으면(옛 서버) 그리지 않는다. withLabel 이면 글자도 붙인다
export default function HealthDot({ state, withLabel = false }) {
  const colors = useColors()
  const label = HEALTH_STATE_LABEL[state]
  if (!label) return null
  const color = state === 'healthy' ? colors.ok : state === 'unhealthy' ? colors.err : colors.muted
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={`서버 응답 ${label}`} style={styles.row}>
      <View testID="health-dot" style={[styles.dot, { backgroundColor: color }]} />
      {withLabel && <Text style={[styles.label, { color }]}>{label}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  label: { fontSize: 12, fontWeight: '700' },
})
