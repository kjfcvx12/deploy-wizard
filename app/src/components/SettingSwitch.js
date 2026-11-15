import { Pressable, StyleSheet, Switch, View } from 'react-native'
import { Text } from './Text'
import { radius, spacing, useColors } from '../theme'

// 설정 한 줄 (compact 면 안쪽 여백과 설명 글을 줄인다) - 줄 전체가 하나의 스위치 요소(이름·설명·상태). 안쪽 Switch 는 보이기만 하고 따로 읽히거나 눌리지 않는다
export default function SettingSwitch({ title, description, value, busy, accessibilityLabel, onToggle, compact = false }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={description}
      accessibilityState={{ checked: value, busy: !!busy }}
      aria-checked={value}
      aria-busy={!!busy}
      onPress={onToggle}
      style={({ pressed }) => [styles.row, compact && styles.rowCompact, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.description, compact && styles.descriptionCompact, { color: colors.muted }]}>{description}</Text>
      </View>
      <View pointerEvents="none" aria-hidden>
        <Switch
          value={value}
          disabled={!!busy}
          trackColor={{ false: colors.border, true: colors.accent }}
          thumbColor={value ? colors.accentText : colors.muted}
          ios_backgroundColor={colors.border}
        />
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderWidth: 1, borderRadius: radius.md },
  rowCompact: { minHeight: 44, padding: spacing.md },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '700', lineHeight: 21 },
  description: { fontSize: 13, lineHeight: 19, marginTop: spacing.xs },
  descriptionCompact: { fontSize: 12, lineHeight: 17, marginTop: 2 },
})
