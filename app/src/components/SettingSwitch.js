import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { radius, spacing, useColors } from '../theme'

// 설정 한 줄 - 줄 전체가 하나의 스위치 요소(이름·설명·상태). 안쪽 Switch 는 보이기만 하고 따로 읽히거나 눌리지 않는다
export default function SettingSwitch({ title, description, value, busy, accessibilityLabel, onToggle }) {
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
      style={({ pressed }) => [styles.row, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.description, { color: colors.muted }]}>{description}</Text>
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
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '700', lineHeight: 21 },
  description: { fontSize: 13, lineHeight: 19, marginTop: spacing.xs },
})
