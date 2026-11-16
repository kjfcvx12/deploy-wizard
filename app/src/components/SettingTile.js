import { Pressable, StyleSheet, Switch, View } from 'react-native'
import { Text } from './Text'
import { radius, spacing, useColors } from '../theme'

// 설정 타일 한 칸 - 제목과 스위치만 있는 한 줄. 줄 전체가 하나의 스위치 요소이고 안쪽 Switch 는 보이기만 한다
export default function SettingTile({ title, value, busy, accessibilityLabel, accessibilityHint, onToggle }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ checked: value, busy: !!busy }}
      aria-checked={value}
      aria-busy={!!busy}
      onPress={onToggle}
      style={({ pressed }) => [styles.tile, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
    >
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      <View pointerEvents="none" aria-hidden>
        <Switch
          value={value}
          disabled={!!busy}
          trackColor={{ false: colors.border, true: colors.accent }}
          thumbColor={value ? colors.accentText : colors.muted}
        />
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  tile: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderRadius: radius.md },
  title: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '700', lineHeight: 20 },
})
