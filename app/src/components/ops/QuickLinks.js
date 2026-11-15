import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from '../Text'
import { radius, spacing, useColors } from '../../theme'

// 목록 헤더 바로 아래의 보조 줄 - 헤더에 다 못 담는 이동 링크(계정 연결 등)를 칩으로 둔다. 눌림 높이는 44pt 이상
export default function QuickLinks({ links }) {
  const colors = useColors()
  return (
    <View testID="quick-links" style={[styles.row, { backgroundColor: colors.bg }]}>
      {links.map((link) => (
        <Pressable
          key={link.label}
          accessibilityRole="button"
          onPress={link.onPress}
          style={({ pressed }) => [styles.chip, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.6 : 1 }]}
        >
          <Text style={[styles.chipText, { color: colors.accent }]}>{link.label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  chip: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 14, fontWeight: '700' },
})
