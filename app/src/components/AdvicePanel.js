import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from './Text'
import { confidenceLabel, needLabel, tierLabel } from '../constants'
import { monoFont, radius, spacing, useColors } from '../theme'

const COST_UNKNOWN = '아직 계산할 수 없습니다 (실제 배포로 요금 구성을 확인한 뒤 표시됩니다). 트래픽에 따라 늘어납니다.'

// 배지 색 조합 - ok 초록, warn 주황, 그 외 흐림
function badgeTone(kind, colors) {
  if (kind === 'ok') return { bg: colors.okBg, fg: colors.ok }
  if (kind === 'warn') return { bg: colors.warnBg, fg: colors.warn }
  return { bg: colors.surface2, fg: colors.muted }
}

// 작은 알약 배지
function Badge({ kind, children }) {
  const colors = useColors()
  const tone = badgeTone(kind, colors)
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]}>
      <Text style={[styles.badgeText, { color: tone.fg }]}>{children}</Text>
    </View>
  )
}

// 글머리표 한 줄 - 긴 문장은 줄바꿈된다
function Bullet({ color, children }) {
  const colors = useColors()
  return (
    <View style={styles.bullet}>
      <Text style={[styles.text, { color: colors.muted }]}>•</Text>
      <Text style={[styles.text, styles.bulletText, { color }]}>{children}</Text>
    </View>
  )
}

// 비용 줄 - 숫자가 둘 다 있을 때만 범위를 보여 주고, 하나라도 없으면 "아직 계산할 수 없습니다" (0 이나 지어낸 숫자를 쓰지 않는다)
function CostLine({ cost }) {
  const colors = useColors()
  const known = Number.isFinite(cost?.monthly_min) && Number.isFinite(cost?.monthly_max)

  if (!known) return <Text style={[styles.text, { color: colors.text }]}>예상 비용: {COST_UNKNOWN}</Text>

  return (
    <Text style={[styles.text, { color: colors.text }]}>
      예상 비용: {cost.monthly_min}~{cost.monthly_max} {cost.currency}/월
      {cost.basis_date && <Text style={[styles.small, { color: colors.muted }]}> 기준일 {cost.basis_date}</Text>}
      {cost.note && <Text style={[styles.small, { color: colors.muted }]}> {cost.note}</Text>}
    </Text>
  )
}

// 필요한 것 한 줄 - 마법사가 만들어 주지 못하는 것은 흐리게 하고 이유를 붙인다
function NeedItem({ need }) {
  const colors = useColors()
  const label = needLabel(need.kind)

  if (!need.supported) {
    return <Bullet color={colors.muted}>{label}{need.message ? ` — ${need.message}` : ''}</Bullet>
  }
  if (need.kind === 'env_vars' && need.count > 0) {
    return <Bullet color={colors.text}>환경변수 {need.count}개 입력이 필요합니다</Bullet>
  }
  return <Bullet color={colors.text}>{label}{need.message ? ` — ${need.message}` : ''}</Bullet>
}

// 접힌 채 시작하는 "알 수 없었던 것" - 제목을 누르면 펼친다
function Unknowns({ items }) {
  const colors = useColors()
  const [open, setOpen] = useState(false)
  return (
    <View style={styles.block}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [styles.toggle, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Text style={[styles.text, { color: colors.muted }]}>{open ? '▾' : '▸'}</Text>
        <Text style={[styles.heading, { color: colors.text }]}>
          알 수 없었던 것 <Text style={[styles.small, { color: colors.muted }]}>({items.length})</Text>
        </Text>
      </Pressable>
      {open && items.map((item, i) => <Bullet key={i} color={colors.text}>{item}</Bullet>)}
    </View>
  )
}

// 배포 전 분석 결과 (S-20) - 보여 주기만 한다. 배포·초기화는 부모가 처리한다
export default function AdvicePanel({ advice, busy, onDeploy, onReset, headingRef }) {
  const colors = useColors()

  if (!advice) return null

  const reasons = advice.reasons || []
  const needs = advice.needs || []
  const unknowns = advice.unknowns || []
  const official = advice.support_level === 'official'
  const confidenceKind = advice.confidence === 'low' ? 'warn' : advice.confidence === 'high' ? 'ok' : 'neutral'

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text ref={headingRef} accessibilityRole="header" style={[styles.title, { color: colors.text }]}>분석 결과</Text>

      <View style={styles.row}>
        <View style={[styles.code, { backgroundColor: colors.surface2 }]}>
          <Text style={[styles.codeText, { color: colors.text }]}>{advice.language}</Text>
        </View>
        <Badge kind={official ? 'ok' : 'warn'}>{official ? '공식 지원' : '실험 지원'}</Badge>
        {!!advice.app_dir && advice.app_dir !== '.' && (
          <Text style={[styles.small, { color: colors.text }]}>
            앱 폴더: <Text style={{ fontFamily: monoFont }}>{advice.app_dir}</Text>
          </Text>
        )}
      </View>

      <View style={styles.row}>
        <Text style={[styles.tier, { color: colors.text }]}>추천 수준: {tierLabel(advice.tier)}</Text>
        <Badge kind={confidenceKind}>확신도 {confidenceLabel(advice.confidence)}</Badge>
      </View>
      {advice.confidence === 'low' && (
        <Text style={[styles.small, { color: colors.warn }]}>추정입니다. 근거가 부족해 틀릴 수 있습니다.</Text>
      )}

      {reasons.length > 0 && (
        <View style={styles.block}>
          <Text style={[styles.heading, { color: colors.text }]}>왜 이렇게 추천했나</Text>
          {reasons.map((reason, i) => <Bullet key={i} color={colors.text}>{reason}</Bullet>)}
        </View>
      )}

      <CostLine cost={advice.cost} />

      {needs.length > 0 && (
        <View style={styles.block}>
          <Text style={[styles.heading, { color: colors.text }]}>필요한 것</Text>
          {needs.map((need, i) => <NeedItem key={`${need.kind}-${i}`} need={need} />)}
        </View>
      )}

      {unknowns.length > 0 && <Unknowns items={unknowns} />}

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onDeploy}
          style={({ pressed }) => [styles.button, { backgroundColor: colors.accent, opacity: busy ? 0.5 : pressed ? 0.7 : 1 }]}
        >
          <Text style={[styles.buttonText, { color: colors.accentText }]}>이 레포로 배포</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onReset}
          style={({ pressed }) => [styles.button, { borderWidth: 1, borderColor: colors.border, opacity: busy ? 0.5 : pressed ? 0.7 : 1 }]}
        >
          <Text style={[styles.buttonText, { color: colors.text }]}>다른 레포로</Text>
        </Pressable>
      </View>
      <Text style={[styles.small, { color: colors.muted }]}>분석은 읽기만 합니다. 배포를 누르기 전에는 AWS에 아무것도 만들지 않습니다.</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { padding: spacing.lg, borderWidth: 1, borderRadius: radius.md, gap: spacing.md },
  title: { fontSize: 18, fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  code: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: radius.sm },
  codeText: { fontFamily: monoFont, fontSize: 13 },
  badge: { paddingHorizontal: 10, paddingVertical: spacing.xs / 2, borderRadius: radius.pill },
  badgeText: { fontSize: 12, fontWeight: '700' },
  tier: { fontSize: 15, fontWeight: '700' },
  block: { gap: spacing.xs },
  heading: { fontSize: 15, fontWeight: '700' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  text: { fontSize: 14, lineHeight: 20 },
  small: { fontSize: 13, lineHeight: 18 },
  bullet: { flexDirection: 'row', gap: spacing.sm },
  bulletText: { flex: 1, minWidth: 0 },
  actions: { gap: spacing.sm },
  button: { minHeight: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
  buttonText: { fontSize: 15, fontWeight: '700' },
})
