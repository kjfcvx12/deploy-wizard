import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import SettingTile from '../SettingTile'
import { NOTIFICATION_KIND_LABEL, NOTIFICATION_KINDS } from '../../ops/constants'
import { KIND_HINT } from '../../ops/notificationSettings'
import { radius, spacing, useColors } from '../../theme'

// 받을 알림 종류 - 6개를 2열 타일로 놓고, 종류별 설명은 [설명 보기] 를 눌러야 펼친다 (스크린리더에는 항상 hint 로 읽힌다)
export default function NotificationKinds({ kinds, busy, onToggle }) {
  const colors = useColors()
  const [expanded, setExpanded] = useState(false)
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>받을 알림</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((v) => !v)}
          style={({ pressed }) => [styles.toggle, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={[styles.toggleText, { color: colors.text }]}>{expanded ? '설명 닫기' : '설명 보기'}</Text>
        </Pressable>
      </View>
      <View style={styles.grid}>
        {NOTIFICATION_KINDS.map((kind) => (
          <View key={kind} style={styles.cell}>
            <SettingTile
              title={NOTIFICATION_KIND_LABEL[kind]}
              value={kinds.includes(kind)}
              busy={busy}
              accessibilityLabel={`${NOTIFICATION_KIND_LABEL[kind]} 알림`}
              accessibilityHint={KIND_HINT[kind]}
              onToggle={() => onToggle(kind)}
            />
          </View>
        ))}
      </View>
      {expanded && (
        <View style={styles.hints}>
          {NOTIFICATION_KINDS.map((kind) => (
            <Text key={kind} style={[styles.small, { color: colors.muted }]}>{`${NOTIFICATION_KIND_LABEL[kind]} — ${KIND_HINT[kind]}`}</Text>
          ))}
        </View>
      )}
      <Text style={[styles.small, { color: colors.muted }]}>끈 종류는 앱 안 알림 목록에도 남지 않습니다</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  heading: { flexShrink: 1, fontSize: 15, fontWeight: '700', lineHeight: 21 },
  toggle: { minHeight: 44, paddingHorizontal: spacing.md, borderWidth: 1, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  toggleText: { fontSize: 14, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cell: { flexBasis: '48%', flexGrow: 1 },
  hints: { gap: spacing.xs },
  small: { fontSize: 12, lineHeight: 16 },
})
