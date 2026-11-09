import { Pressable, StyleSheet, Text, View } from 'react-native'
import { radius, spacing, useColors } from '../theme'

// 쓸 수 있는 블록 - AWS 가 확인됐거나 GitHub 가 살아 있는 것 (웹 AccountPicker 와 같다)
export const isUsableConnection = (block) => block.aws?.status === 'verified' || block.github?.status === 'active'

// 블록 한 줄 이름 - 블록 이름과 AWS 계정, GitHub 계정
export const connectionLabel = (block) => `${block.label} — AWS ${block.aws?.status === 'verified' ? block.aws.aws_account_id : '개발 계정'}`
  + ` · GitHub ${block.github?.status === 'active' ? block.github.account_login : '없음 (public만)'}`

// 선택지 한 줄 (라디오 모양)
function Option({ label, selected, onPress }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        { backgroundColor: pressed ? colors.surface2 : colors.surface, borderColor: selected ? colors.accent : colors.border },
      ]}
    >
      <View style={[styles.radio, { borderColor: selected ? colors.accent : colors.muted }]}>
        {selected && <View style={[styles.radioDot, { backgroundColor: colors.accent }]} />}
      </View>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
    </Pressable>
  )
}

// 연결 블록 고르기 (읽기 전용) - value 는 고른 블록의 c_id 문자열, 빈 문자열이면 "연결 안 함". 쓸 수 있는 블록이 없으면 그리지 않는다
export default function ConnectionPicker({ connections, value, onChange }) {
  if (!connections || connections.length === 0) return null

  return (
    <View accessibilityRole="radiogroup" style={styles.group}>
      <Option label="연결 안 함 (개발 계정 · public 레포만)" selected={value === ''} onPress={() => onChange('')} />
      {connections.map((block) => (
        <Option
          key={block.c_id}
          label={connectionLabel(block)}
          selected={value === String(block.c_id)}
          onPress={() => onChange(String(block.c_id))}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
  },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  label: { flex: 1, minWidth: 0, fontSize: 14 },
})
