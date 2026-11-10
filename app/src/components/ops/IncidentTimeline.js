import { StyleSheet, Text, View } from 'react-native'
import { formatTime, incidentTimeline } from '../../ops/format'
import { spacing, toneColors, useColors, wrapAnywhere } from '../../theme'

// 마법사가 한 일 - 감지, 자동 조치(재시작·되돌리기)와 결과를 시간순 세로 줄로 보여 준다 (읽기 전용 기록)
export default function IncidentTimeline({ incident }) {
  const colors = useColors()
  const events = incidentTimeline(incident)
  return (
    <View style={styles.wrap}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>마법사가 한 일</Text>
      {events.map((event, i) => {
        const tone = toneColors(colors, event.tone).fg
        const last = i === events.length - 1
        const time = formatTime(event.time)
        return (
          <View key={event.key} testID="timeline-item" style={styles.row}>
            <View style={styles.rail}>
              <View style={[styles.dot, { backgroundColor: tone }]} />
              {!last && <View style={[styles.line, { backgroundColor: colors.border }]} />}
            </View>
            <View style={[styles.body, !last && styles.bodyGap]}>
              <Text testID="timeline-title" style={[styles.eventTitle, wrapAnywhere, { color: colors.text }]}>{event.title}</Text>
              {!!time && <Text style={[styles.time, { color: colors.muted }]}>{time}</Text>}
              {!!event.detail && <Text style={[styles.detail, wrapAnywhere, { color: colors.muted }]}>{event.detail}</Text>}
            </View>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  title: { fontSize: 15, fontWeight: '700' },
  row: { flexDirection: 'row', gap: spacing.md },
  rail: { alignItems: 'center', width: 12 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 5 },
  line: { flex: 1, width: 2, marginTop: 2 },
  body: { flex: 1, minWidth: 0 },
  bodyGap: { paddingBottom: spacing.md },
  eventTitle: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
  time: { fontSize: 12, lineHeight: 18 },
  detail: { fontSize: 13, lineHeight: 19, marginTop: 2 },
})
