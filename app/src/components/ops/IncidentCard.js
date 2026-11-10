import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { incidentApi } from '../../api'
import { INCIDENT_STATUS_LABEL, INCIDENT_STATUS_TONE } from '../../ops/constants'
import { monoFont, radius, spacing, toneColors, useColors, wrapAnywhere } from '../../theme'
import { Button, Card } from '../ui'

// 인시던트 상태 배지 - 색은 상태 톤 (open 주황, recovering accent, resolved ok, needs_action err)
export function IncidentBadge({ status }) {
  const colors = useColors()
  const tone = toneColors(colors, INCIDENT_STATUS_TONE[status])
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]}>
      <View style={[styles.badgeDot, { backgroundColor: tone.fg }]} />
      <Text style={[styles.badgeText, { color: tone.fg }]}>{INCIDENT_STATUS_LABEL[status] || status}</Text>
    </View>
  )
}

// 배포 상세의 인시던트 카드 - 한 줄 요약을 받아 보여 주고 누르면 인시던트 화면. 요약을 못 받아도 카드는 남는다
// refreshKey 가 바뀌면(부모가 배포를 새로 받으면) 요약을 다시 받는다
export default function IncidentCard({ d_id, i_id, label, onPress, refreshKey }) {
  const colors = useColors()
  const [incident, setIncident] = useState(null)

  useEffect(() => {
    let alive = true
    incidentApi.getOne(i_id).then((result) => alive && setIncident(result)).catch(() => {})
    return () => { alive = false }
  }, [i_id, refreshKey])

  const summary = incident?.summary || incident?.explain?.summary || '처리 중인 문제가 있습니다'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`배포 #${d_id} 문제 상세 보기: ${summary}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: pressed ? colors.surface2 : colors.surface, borderColor: colors.border, borderLeftColor: colors.warn },
      ]}
    >
      <View style={styles.head}>
        <Text style={[styles.cardTitle, { color: colors.warn }]}>{label ? `문제가 있습니다 · ${label}` : '문제가 있습니다'}</Text>
        {!!incident && <IncidentBadge status={incident.status} />}
      </View>
      <Text style={[styles.summary, wrapAnywhere, { color: colors.text }]}>{summary}</Text>
      <Text style={[styles.more, { color: colors.accent }]}>자세히 보기 ›</Text>
    </Pressable>
  )
}

// 복사됨 표시를 거두는 시간(ms)
const COPIED_MS = 2000

// 원인 · 고칠 곳(고정폭, 선택·복사 가능) · 해야 할 일 - explain 이 null 이거나 일부만 있어도 그린다 (글자로만 그린다)
export function IncidentExplain({ explain, onError }) {
  const colors = useColors()
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  const cause = explain?.cause || '아직 원인을 확인하지 못했습니다'
  const fixWhere = explain?.fix_where
  const actions = Array.isArray(explain?.actions) ? explain.actions : []

  // 고칠 곳을 복사한다 - false 로 끝나면 복사되지 않은 것이다
  const copy = async () => {
    try {
      if ((await Clipboard.setStringAsync(fixWhere)) === false) throw new Error('copy failed')
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    } catch (e) {
      onError('고칠 곳을 복사하지 못했습니다')
    }
  }

  return (
    <>
      <Card style={styles.stack}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.text }]}>원인</Text>
        <Text style={[styles.body, wrapAnywhere, { color: colors.text }]}>{cause}</Text>
      </Card>

      {!!fixWhere && (
        <Card style={styles.stack}>
          <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.text }]}>고칠 곳</Text>
          <Text selectable style={[styles.mono, wrapAnywhere, { color: colors.text, backgroundColor: colors.surface2 }]}>{fixWhere}</Text>
          <Button label={copied ? '복사됨' : '복사'} accessibilityLabel="고칠 곳 복사" onPress={copy} style={styles.self} />
        </Card>
      )}

      {actions.length > 0 && (
        <Card style={styles.stack}>
          <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.text }]}>해야 할 일</Text>
          {actions.map((action, index) => (
            <View key={`${index}-${action}`} style={styles.actionRow}>
              <Text style={[styles.body, styles.num, { color: colors.text }]}>{`${index + 1}.`}</Text>
              <Text style={[styles.body, styles.actionText, wrapAnywhere, { color: colors.text }]}>{action}</Text>
            </View>
          ))}
        </Card>
      )}
    </>
  )
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', flexShrink: 0, paddingHorizontal: 10, paddingVertical: spacing.xs / 2, borderRadius: radius.pill },
  badgeDot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  card: { minHeight: 44, padding: spacing.lg, borderWidth: 1, borderLeftWidth: 4, borderRadius: radius.md, gap: spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  cardTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '700' },
  summary: { fontSize: 14, lineHeight: 20 },
  more: { fontSize: 13, fontWeight: '700' },
  stack: { gap: spacing.sm },
  sectionTitle: { fontSize: 15, fontWeight: '700' },
  body: { fontSize: 14, lineHeight: 21 },
  mono: { fontFamily: monoFont, fontSize: 13, lineHeight: 19, padding: spacing.md, borderRadius: radius.sm },
  self: { alignSelf: 'flex-start' },
  actionRow: { flexDirection: 'row', gap: spacing.sm },
  num: { width: 22 },
  actionText: { flex: 1, minWidth: 0 },
})
