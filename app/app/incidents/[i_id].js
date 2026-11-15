import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { Text } from '../../src/components/Text'
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { deployApi, healthApi, incidentApi } from '../../src/api'
import FitScreen from '../../src/components/FitScreen'
import HealthBar from '../../src/components/ops/HealthBar'
import { IncidentBadge, IncidentExplain } from '../../src/components/ops/IncidentCard'
import IncidentTimeline from '../../src/components/ops/IncidentTimeline'
import { Button, Card, Notice } from '../../src/components/ui'
import { confirmStopDeploy } from '../../src/deployConfirms'
import { STOP_POLLING, usePolling } from '../../src/hooks/usePolling'
import { INCIDENT_ACTIVE_STATUSES, INCIDENT_KIND_LABEL } from '../../src/ops/constants'
import { durationText, formatTime } from '../../src/ops/format'
import { spacing, useColors, wrapAnywhere } from '../../src/theme'

// 갱신 간격(ms) - 복구 중에는 5초마다. 연결 실패가 이어지면 5, 10, 20초로 늘려 최대 30초까지, 성공하면 처음으로 (404 는 다시 부르지 않는다)
const POLL_MS = 5000
const MAX_BACKOFF_MS = 30000
// 헬스 이력은 처음·상태가 바뀔 때·수동 새로고침 때 받고, 그 밖에는 60초에 한 번만
const HEALTH_HOURS = 24
const HEALTH_REFRESH_MS = 60000
// 가운데 상자의 최소 높이 - 위·아래 고정 부분이 커도 이 아래로는 줄이지 않고 바깥 스크롤이 받는다
const MIDDLE_MIN = 160
const NOT_FOUND_TEXT = '문제를 찾을 수 없습니다. 이미 삭제된 배포이거나 지워진 기록일 수 있습니다.'

// 인시던트 상세 화면 (S-13) - 주소의 i_id 가 바뀌면 화면을 새로 만들어 다른 인시던트의 상태가 남지 않게 한다
export default function IncidentDetailScreen() {
  const { i_id } = useLocalSearchParams()
  return <IncidentDetail key={i_id} i_id={i_id} />
}

// 인시던트 한 건: 원인·고칠 곳·마법사가 한 일·헬스 이력. 확인이 필요할 때만 사용자가 누르는 버튼이 있다
function IncidentDetail({ i_id }) {
  const colors = useColors()
  const router = useRouter()
  const alive = useRef(false)
  const busyRef = useRef(false)
  const failsRef = useRef(0)
  const statusRef = useRef(null)
  const forceHistoryRef = useRef(false)
  const lastHistoryAt = useRef(0)
  const historySeq = useRef(0)

  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [acted, setActed] = useState(false)
  const [pulling, setPulling] = useState(false)
  // 가운데 상자의 최대 높이를 정하는 측정값 - 화면 내용 영역·위 고정 묶음·아래 고정 묶음의 높이 (아직 못 쟀으면 null)
  const [available, setAvailable] = useState(null)
  const [topH, setTopH] = useState(null)
  const [bottomH, setBottomH] = useState(null)
  // 헬스 이력 - undefined 면 아직 받는 중(막대를 그리지 않음), null 이면 한 번도 받지 못함, 배열이면 받은 이력
  const [checks, setChecks] = useState(undefined)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // 인시던트만 폴링한다 - 헬스 이력은 아래에서 따로 받아 느려도 갱신을 붙잡지 않는다
  const { data: incident, error, loading, refresh: poll } = usePolling(() => incidentApi.getOne(i_id), (value, failure) => {
    if (!failure) { failsRef.current = 0; return INCIDENT_ACTIVE_STATUSES.includes(value.status) ? POLL_MS : STOP_POLLING }
    if (failure.status === 404) return STOP_POLLING
    failsRef.current += 1
    return Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** (failsRef.current - 1))
  }, [i_id])

  // 지금 바로 새로 받는다 (수동 새로고침·포커스 복귀·동작 뒤) - 헬스 이력도 60초를 기다리지 않는다
  const refresh = useCallback(() => { forceHistoryRef.current = true; return poll() }, [poll])

  // 헬스 이력 - 첫 응답, 상태 변경, 수동 새로고침, 60초 경과 때만. 실패하면 지난 이력은 그대로 두고, 받은 적이 없으면 못 받았다고 알린다
  useEffect(() => {
    if (!incident) return
    const changed = statusRef.current !== incident.status
    statusRef.current = incident.status
    const now = Date.now()
    if (!changed && !forceHistoryRef.current && now - lastHistoryAt.current < HEALTH_REFRESH_MS) return
    forceHistoryRef.current = false
    lastHistoryAt.current = now
    const mine = ++historySeq.current
    healthApi.getHistory(incident.d_id, HEALTH_HOURS)
      .then((result) => { if (alive.current && mine === historySeq.current) setChecks(result) })
      .catch(() => { if (alive.current && mine === historySeq.current) setChecks((prev) => (Array.isArray(prev) ? prev : null)) })
  }, [incident])

  // 다른 화면에서 돌아오면 한 번 새로 받는다 (처음 열 때는 usePolling 이 이미 받는다)
  const focusedOnce = useRef(false)
  useFocusEffect(useCallback(() => {
    if (!focusedOnce.current) { focusedOnce.current = true; return }
    refresh()
  }, [refresh]))

  // 동작 하나를 실행한다 - 실행하는 동안 버튼을 잠그고, 성공하면 안내를 띄우고 다시 받고, 실패하면 빨간 알림을 띄운다
  const perform = async (call, doneMessage) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setActionError('')
    setNotice('')
    try {
      await call()
      if (!alive.current) return
      setActed(true)
      setNotice(doneMessage)
      refresh()
    } catch (e) {
      if (alive.current) setActionError(e.message)
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }

  const goDeploy = () => router.push(`/deploys/${incident.d_id}`)
  // 그대로 두기 - 아무것도 바꾸지 않고 돌아간다 (아래 화면이 없으면 목록으로)
  const leave = () => { if (router.canGoBack()) router.back(); else router.replace('/') }
  // 눌렀을 때 동작이 끝나기를 기다리지 않도록 값을 돌려주지 않는다
  const redeploy = () => { perform(() => deployApi.redeploy(incident.d_id), '다시 배포를 시작했습니다. 진행 상황은 [배포 보기]에서 확인하세요.') }
  const askStop = () => confirmStopDeploy(() => {
    perform(() => deployApi.stop(incident.d_id), '멈추도록 요청했습니다. 진행 상황은 [배포 보기]에서 확인하세요.')
  })

  // 끌어당겨 새로고침
  const onPull = async () => {
    setPulling(true)
    try {
      await refresh()
    } finally {
      if (alive.current) setPulling(false)
    }
  }

  // 위·아래 고정 묶음의 높이를 잰다 (같은 값이면 state 가 바뀌지 않아 다시 그리지 않는다)
  const onTopLayout = (event) => { setTopH(Math.round(event.nativeEvent.layout.height)) }
  const onBottomLayout = (event) => { setBottomH(Math.round(event.nativeEvent.layout.height)) }
  // 가운데 상자가 쓸 수 있는 최대 높이 - 측정이 하나라도 없으면 제한하지 않는다 (그룹 사이 간격은 둘)
  const middleMax = available == null || topH == null || bottomH == null
    ? undefined
    : Math.max(MIDDLE_MIN, available - topH - bottomH - spacing.md * 2)

  let body
  if (error?.status === 404) {
    // 인시던트나 배포가 지워졌다 - 처음 열 때든 보던 중이든 같은 안내
    body = (
      <View style={[styles.stack, styles.center]}>
        <Notice>{NOT_FOUND_TEXT}</Notice>
        <Button label="돌아가기" onPress={leave} style={styles.self} />
      </View>
    )
  } else if (!incident) {
    body = loading
      ? <ActivityIndicator accessibilityLabel="불러오는 중" size="large" color={colors.accent} style={styles.center} />
      : (
        <View style={[styles.stack, styles.center]}>
          <Notice>{error?.message}</Notice>
          <View style={styles.row}>
            <Button label="다시 시도" onPress={refresh} />
            <Button label="돌아가기" onPress={leave} />
          </View>
        </View>
      )
  } else {
    const label = (name) => `배포 #${incident.d_id} ${name}`
    const needsAction = incident.status === 'needs_action' && !acted
    const finished = incident.resolved_at ? durationText(incident.detected_at, incident.resolved_at) : ''
    body = (
      <View style={[styles.stack, styles.fill]}>
        <View testID="incident-top" onLayout={onTopLayout}>
          <Card style={styles.stack}>
            <View style={styles.headTop}>
              <Text accessibilityRole="header" style={[styles.summary, wrapAnywhere, { color: colors.text }]}>
                {incident.summary || incident.explain?.summary || '문제가 감지되었습니다'}
              </Text>
              <IncidentBadge status={incident.status} />
            </View>
            <Text style={[styles.meta, { color: colors.muted }]}>
              {`배포 #${incident.d_id} · ${INCIDENT_KIND_LABEL[incident.kind] || incident.kind} · 감지 ${formatTime(incident.detected_at)}`}
              {incident.status === 'resolved' && incident.resolved_at ? ` · 해결 ${formatTime(incident.resolved_at)}${finished ? ` (${finished})` : ''}` : ''}
            </Text>
            {INCIDENT_ACTIVE_STATUSES.includes(incident.status) && (
              <Text style={[styles.meta, { color: colors.muted }]}>마법사가 복구를 시도하고 있습니다. 이 화면은 5초마다 새로 고쳐집니다.</Text>
            )}
          </Card>
        </View>

        <Card testID="incident-middle" style={[styles.middle, middleMax != null && { maxHeight: middleMax }]}>
          <ScrollView testID="incident-body" nestedScrollEnabled bounces={false} alwaysBounceVertical={false} style={styles.grow} contentContainerStyle={styles.stack}>
            <IncidentExplain flat explain={incident.explain} onError={setActionError} />
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <IncidentTimeline incident={incident} />
          </ScrollView>
        </Card>

        <View testID="incident-bottom" onLayout={onBottomLayout} style={styles.stack}>
          {checks !== undefined && <Card><HealthBar checks={checks} hours={HEALTH_HOURS} /></Card>}

          {!!error && <Notice>{error.message}</Notice>}
          {!!actionError && <Notice>{actionError}</Notice>}
          {!!notice && <Notice tone="info">{notice}</Notice>}

          {needsAction ? (
            <View style={styles.stack}>
              <View style={styles.buttonRow}>
                <Button variant="primary" label="다시 배포" accessibilityLabel={label('다시 배포')} onPress={redeploy} disabled={busy} style={styles.flex} />
                <Button label="멈춤" accessibilityLabel={label('멈춤')} onPress={askStop} disabled={busy} style={styles.flex} />
                <Button label="그대로 두기" accessibilityLabel={label('그대로 두기')} onPress={leave} disabled={busy} style={styles.flex} />
              </View>
              <Text style={[styles.meta, { color: colors.muted }]}>아무것도 누르지 않으면 그대로 둡니다. 마법사가 자동으로 지우거나 바꾸지 않습니다.</Text>
            </View>
          ) : (
            <Button label="배포 보기" accessibilityLabel={label('보기')} onPress={goDeploy} disabled={busy} />
          )}
        </View>
      </View>
    )
  }

  return (
    <>
      <Stack.Screen options={{ title: `문제 #${i_id}` }} />
      <FitScreen
        testID="incident-scroll"
        onAvailableHeight={setAvailable}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={colors.accent} colors={[colors.accent]} />}
      >
        {body}
      </FitScreen>
    </>
  )
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  self: { alignSelf: 'flex-start' },
  // 웹 번들에서는 flex: 1 (기준 0%) 이 내용 높이로 풀려 flexBasis: 0 이 필요했다. 네이티브(Yoga)는 부모 높이가 정해지지 않으면 flexBasis 를 무시하므로
  // 가운데 상자의 maxHeight 를 onLayout 측정값에서 계산해 건다 (yoga-layout@3 스크래치 스크립트로만 확인했고 실제 기기에서는 아직 재지 않았다)
  fill: { flexGrow: 1 },
  flex: { flex: 1 },
  grow: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  center: { flex: 1, justifyContent: 'center' },
  middle: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: MIDDLE_MIN },
  divider: { height: 1 },
  buttonRow: { flexDirection: 'row', gap: spacing.sm },
  headTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  summary: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '700', lineHeight: 24 },
  meta: { fontSize: 13, lineHeight: 19 },
})
