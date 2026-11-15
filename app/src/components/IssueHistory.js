import { StyleSheet, View } from 'react-native'
import { Text } from './Text'
import { STEPS } from '../constants'
import { formatTime } from '../ops/format'
import { spacing, useColors } from '../theme'
import { Collapsible } from './ui'

const STEP_LABEL = Object.fromEntries(STEPS.map((step) => [step.key, step.label]))

// 문제 이력 - 다시 배포해도 지난 실패를 모아서 본다 (접혀 있다가 누르면 펼쳐진다, 웹 IssueHistory 와 같은 의미)
export default function IssueHistory({ issues }) {
  const colors = useColors()
  if (!issues?.length) return null

  return (
    <Collapsible title="문제 이력" hint={`(${issues.length}건)`}>
      {issues.map((issue) => (
        <View key={issue.d_i_id} style={[styles.item, { borderTopColor: colors.border }]}>
          <View style={styles.row}>
            <Text style={[styles.step, { color: colors.text }]}>{STEP_LABEL[issue.step] || issue.step}</Text>
            <Text style={[styles.small, { color: colors.muted }]}>{formatTime(issue.created_at)}</Text>
          </View>
          <Text style={[styles.small, styles.message, { color: colors.muted }]}>{issue.explain?.summary || issue.error_msg}</Text>
        </View>
      ))}
    </Collapsible>
  )
}

const styles = StyleSheet.create({
  item: { paddingVertical: spacing.md, borderTopWidth: 1 },
  row: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.sm },
  step: { fontSize: 14, fontWeight: '700' },
  small: { fontSize: 13 },
  message: { marginTop: spacing.xs, lineHeight: 18 },
})
