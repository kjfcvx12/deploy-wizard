import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { radius, spacing, useColors } from '../theme'

// 카드 - 웹 .card 와 같은 면
export function Card({ children, style, testID }) {
  const colors = useColors()
  return <View testID={testID} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, style]}>{children}</View>
}

// 알림 띠 - tone: err(빨강) | info(파랑)
export function Notice({ tone = 'err', children, testID }) {
  const colors = useColors()
  const tones = { err: [colors.errBg, colors.err], info: [colors.infoBg, colors.text] }
  const [bg, fg] = tones[tone]
  return (
    <View testID={testID} accessibilityRole="alert" style={[styles.notice, { backgroundColor: bg }]}>
      <Text style={[styles.noticeText, { color: fg }]}>{children}</Text>
    </View>
  )
}

// 버튼 - variant: default(테두리) | primary(채움) | danger(빨강 테두리). 눌림 높이는 44pt 이상
export function Button({ label, onPress, disabled, variant = 'default', style }) {
  const colors = useColors()
  const filled = variant === 'primary'
  const border = variant === 'danger' ? colors.err : colors.border
  const fg = filled ? colors.accentText : variant === 'danger' ? colors.err : colors.text
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        filled ? { backgroundColor: colors.accent } : { borderWidth: 1, borderColor: border },
        { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 },
        style,
      ]}
    >
      <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  )
}

// 접힌 구역 - 제목을 누르면 펼쳐진다 (웹 details/summary)
export function Collapsible({ title, hint, children }) {
  const colors = useColors()
  const [open, setOpen] = useState(false)
  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        style={styles.summary}
      >
        <Text style={[styles.summaryText, { color: colors.text }]}>
          {open ? '▾ ' : '▸ '}{title}
          {!!hint && <Text style={[styles.hint, { color: colors.muted }]}>{` ${hint}`}</Text>}
        </Text>
      </Pressable>
      {open && children}
    </Card>
  )
}

const styles = StyleSheet.create({
  card: { padding: spacing.lg, borderWidth: 1, borderRadius: radius.md },
  notice: { padding: spacing.lg, borderRadius: radius.md },
  noticeText: { fontSize: 14, lineHeight: 20 },
  button: { minHeight: 44, paddingHorizontal: spacing.lg, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 15, fontWeight: '700' },
  summary: { minHeight: 44, justifyContent: 'center' },
  summaryText: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 13, fontWeight: '400' },
})
