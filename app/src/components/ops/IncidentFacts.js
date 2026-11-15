import { StyleSheet, View } from 'react-native'
import { Text } from '../Text'
import { INCIDENT_KIND_LABEL } from '../../ops/constants'
import { durationText, formatClock, formatDate } from '../../ops/format'
import { spacing, useColors, wrapAnywhere } from '../../theme'
import { IncidentBadge } from './IncidentCard'

// 읽을 수 없는 값을 대신하는 글
const UNKNOWN = '확인 불가'

// 인시던트의 사실을 줄마다 "이름 | 값" 한 줄로 보여 준다 - 배포 · 문제 · 날짜 · 시간 · 원인 (해결되면 해결 줄 하나 더)
export default function IncidentFacts({ incident }) {
  const colors = useColors()
  const resolvedAt = incident.status === 'resolved' && incident.resolved_at ? incident.resolved_at : null
  const resolvedDate = resolvedAt ? formatDate(resolvedAt) : ''
  const resolvedClock = resolvedAt ? formatClock(resolvedAt) : ''
  const took = resolvedAt ? durationText(incident.detected_at, resolvedAt) : ''

  const rows = [
    { name: '배포', value: `#${incident.d_id}` },
    { name: '문제', node: <IncidentBadge status={incident.status} /> },
    { name: '날짜', value: formatDate(incident.detected_at) || UNKNOWN },
    { name: '시간', value: formatClock(incident.detected_at) || UNKNOWN },
    { name: '원인', value: INCIDENT_KIND_LABEL[incident.kind] || incident.kind || UNKNOWN },
  ]
  if (resolvedAt) {
    const when = resolvedDate && resolvedClock ? `${resolvedDate} ${resolvedClock}` : UNKNOWN
    rows.push({ name: '해결', value: took ? `${when} (${took})` : when })
  }

  return (
    <View style={styles.list}>
      {rows.map((row) => (
        <View key={row.name} testID="incident-fact" style={styles.row}>
          <Text style={[styles.name, { color: colors.muted }]}>{row.name}</Text>
          {row.node ? <View style={styles.node}>{row.node}</View> : (
            <Text style={[styles.value, wrapAnywhere, { color: colors.text }]}>{row.value}</Text>
          )}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  name: { width: 44, fontSize: 13, lineHeight: 19 },
  value: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 21 },
  node: { flex: 1, minWidth: 0, flexDirection: 'row' },
})
