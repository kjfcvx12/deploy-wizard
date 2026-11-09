import { StyleSheet, Text, View } from 'react-native'
import { STEPS } from '../constants'
import { radius, spacing, useColors } from '../theme'

// 단계별 진행률 - 실패하면 멈춘 단계를 빨갛게, 입력 대기(needs_input)는 배포 단계에서 노랗게 (웹 StepProgress 와 같은 규칙)
// 폰 폭에서는 칸마다 글자를 넣을 수 없어 지금 단계의 이름만 막대 아래에 보여 준다 (웹 640px 이하와 같다)
export default function StepProgress({ status, errorStep }) {
  const colors = useColors()
  const waiting = status === 'needs_input'
  const current = status === 'failed' ? errorStep : waiting ? 'deploying' : status
  const currentIndex = STEPS.findIndex((step) => step.key === current)

  const stateOf = (index) => {
    if (status === 'running' || index < currentIndex) return 'done'
    if (index === currentIndex) return status === 'failed' ? 'fail' : waiting ? 'wait' : 'now'
    return ''
  }
  const barColor = { done: colors.ok, now: colors.accent, fail: colors.err, wait: colors.warn, '': colors.surface2 }
  const stateText = { done: '완료', now: '진행 중', fail: '실패', wait: '입력 대기', '': '대기' }
  const caption = currentIndex >= 0 && status !== 'running' ? STEPS[currentIndex] : null

  return (
    <View>
      <View style={styles.bars}>
        {STEPS.map((step, index) => {
          const state = stateOf(index)
          return (
            <View
              key={step.key}
              testID={`step-${step.key}`}
              accessible
              accessibilityLabel={`${step.label} ${stateText[state]}`}
              style={[styles.bar, { backgroundColor: barColor[state] }]}
            />
          )
        })}
      </View>
      {caption && (
        <Text style={[styles.caption, { color: status === 'failed' ? colors.err : colors.text }]}>
          {caption.label}
        </Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  bars: { flexDirection: 'row', gap: spacing.xs },
  bar: { flex: 1, height: 5, borderRadius: radius.sm / 2 },
  caption: { marginTop: spacing.sm, fontSize: 12, fontWeight: '700' },
})
