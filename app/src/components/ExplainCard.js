import { StyleSheet, Text, View } from 'react-native'
import { monoFont, radius, spacing, useColors } from '../theme'
import { Button } from './ui'

// 해설을 어디서 만들었는지 (웹 ExplainCard 와 같다)
const SOURCE_LABEL = { rule: '알려진 에러', llm: 'AI 해설', none: '' }

// 실패 해설 + 선택지 - 묻는 방식은 열린 질문이 아니라 버튼 두세 개 (기획서 03장)
export default function ExplainCard({ explain, errorStep, errorMsg, hasResources, busy, onRedeploy, onCleanup }) {
  const colors = useColors()
  const source = explain && SOURCE_LABEL[explain.source]

  return (
    <View testID="explain-card" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, borderLeftColor: colors.err }]}>
      <View style={styles.head}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.err }]}>
          {explain?.summary || `${errorStep} 단계에서 실패했습니다.`}
        </Text>
        {!!source && (
          <View style={[styles.badge, { backgroundColor: colors.surface2 }]}>
            <Text style={[styles.badgeText, { color: colors.muted }]}>{source}{explain.cached ? ' (캐시)' : ''}</Text>
          </View>
        )}
      </View>

      {!!explain?.cause && <Text style={[styles.body, { color: colors.text }]}>{explain.cause}</Text>}

      {explain?.actions?.length > 0 && (
        <View style={styles.actions}>
          {explain.actions.map((action, index) => (
            <View key={`${index}-${action}`} style={styles.actionRow}>
              <Text style={[styles.body, styles.num, { color: colors.text }]}>{index + 1}.</Text>
              <Text style={[styles.body, styles.actionText, { color: colors.text }]}>{action}</Text>
            </View>
          ))}
        </View>
      )}

      {!!errorMsg && <Text style={[styles.raw, { color: colors.muted }]}>{errorMsg}</Text>}

      <View style={styles.buttons}>
        <Button variant="primary" label="다시 배포" onPress={onRedeploy} disabled={busy} />
        {hasResources && <Button variant="danger" label="만들어진 리소스 정리" onPress={onCleanup} disabled={busy} />}
        <Text style={[styles.note, { color: colors.muted }]}>아무것도 누르지 않으면 그대로 둡니다. 자동으로 지우지 않습니다.</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { padding: spacing.lg, borderWidth: 1, borderLeftWidth: 4, borderRadius: radius.md, gap: spacing.sm },
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  title: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '700', lineHeight: 24 },
  badge: { flexShrink: 0, paddingHorizontal: 10, paddingVertical: 2, borderRadius: radius.pill },
  badgeText: { fontSize: 12, fontWeight: '700' },
  body: { fontSize: 14, lineHeight: 21 },
  actions: { gap: spacing.xs },
  actionRow: { flexDirection: 'row', gap: spacing.sm },
  num: { width: 20 },
  actionText: { flex: 1, minWidth: 0 },
  raw: { fontFamily: monoFont, fontSize: 12.5, lineHeight: 18, marginTop: spacing.xs },
  buttons: { gap: spacing.sm, marginTop: spacing.md },
  note: { fontSize: 13, lineHeight: 18 },
})
