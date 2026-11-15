import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from '../Text'
import { NOTIFICATION_KIND_ICON, NOTIFICATION_KIND_LABEL } from '../../ops/constants'
import { formatTime } from '../../ops/format'
import { radius, spacing, toneColors, useColors } from '../../theme'

// 종류별 색 톤
const KIND_TONE = {
  incident_opened: 'warn',
  incident_recovered: 'ok',
  incident_needs_action: 'err',
  deploy_succeeded: 'ok',
  deploy_failed: 'err',
  new_commit: 'accent',
}

// 알림 한 줄 - 종류 아이콘, 제목, 한 줄 본문, 시각. 읽지 않은 것은 굵은 제목과 점. 라벨에 종류와 제목을 넣어 반복되는 줄을 구분한다
export default function NotificationItem({ item, onPress }) {
  const colors = useColors()
  const unread = !item.read_at
  const kind = NOTIFICATION_KIND_LABEL[item.kind] || item.kind
  const tone = toneColors(colors, KIND_TONE[item.kind])
  // 글자 모양 선택자(U+FE0E)를 붙여 iOS 가 ⚠ ✔ ✖ ‼ 를 색깔 이모지로 그리지 않게 한다
  const icon = `${NOTIFICATION_KIND_ICON[item.kind] || '•'}\uFE0E`
  const time = formatTime(item.created_at)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${unread ? '읽지 않음 · ' : ''}${kind}: ${item.title}`}
      accessibilityHint={time ? `${time}에 온 알림` : undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.surface2 : colors.surface, borderColor: colors.border }]}
    >
      <View style={[styles.icon, { backgroundColor: tone.bg }]}>
        <Text style={[styles.iconText, { color: tone.fg }]}>{icon}</Text>
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.text, fontWeight: unread ? '700' : '400' }]}>{item.title}</Text>
        {!!item.body && <Text numberOfLines={1} style={[styles.text, { color: colors.muted }]}>{item.body}</Text>}
        <Text style={[styles.time, { color: colors.muted }]}>{time}</Text>
      </View>
      {unread && <View testID="unread-dot" style={[styles.dot, { backgroundColor: colors.accent }]} />}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    minHeight: 64,
    padding: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.md,
  },
  icon: { width: 32, height: 32, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 16, fontWeight: '700' },
  body: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 15, lineHeight: 21 },
  text: { fontSize: 13 },
  time: { fontSize: 12 },
  dot: { width: 10, height: 10, borderRadius: radius.pill, marginTop: spacing.xs },
})
