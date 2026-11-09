import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { deployApi } from '../../src/api'
import EndpointCard from '../../src/components/EndpointCard'
import EnvVarsCard from '../../src/components/EnvVarsCard'
import ExplainCard from '../../src/components/ExplainCard'
import IssueHistory from '../../src/components/IssueHistory'
import LogTerminal, { appendLogs } from '../../src/components/LogTerminal'
import HealthDot from '../../src/components/ops/HealthDot'
import IncidentCard from '../../src/components/ops/IncidentCard'
import { problemLabel } from '../../src/components/ops/ProblemBanner'
import StatusBadge from '../../src/components/StatusBadge'
import StepProgress from '../../src/components/StepProgress'
import { Button, Card, Collapsible, Notice } from '../../src/components/ui'
import { isProgress, repoName, showsEnvCard } from '../../src/constants'
import { confirmAction } from '../../src/confirm'
import { confirmStopDeploy } from '../../src/deployConfirms'
import { STOP_POLLING, usePolling } from '../../src/hooks/usePolling'
import { monoFont, radius, spacing, useColors } from '../../src/theme'

// 갱신 간격 (웹 DeployDetailPage 와 같다) - 진행 중이거나 로그가 들어오는 동안 1.5초, 조회가 실패하면 5초
const FAST_MS = 1500
const RETRY_MS = 5000

// 다음 조회까지 기다릴 시간 - 진행 중도 아니고 새 로그도 없으면 멈춘다 (다시 시작은 round 가 바뀔 때)
function detailDelay(value, error) {
  if (error) return RETRY_MS
  return isProgress(value.deploy.status) || value.logs.length > 0 ? FAST_MS : STOP_POLLING
}

// 상세 화면 (S-04..S-07, S-16) - 주소의 d_id 가 바뀌면 화면을 새로 만들어 다른 배포의 상태가 남지 않게 한다
export default function DeployDetailScreen() {
  const { d_id } = useLocalSearchParams()
  return <DeployDetail key={d_id} d_id={d_id} />
}

// 배포 한 건의 진행·로그·해설·동작
function DeployDetail({ d_id }) {
  const colors = useColors()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const afterRef = useRef(0)
  const busyRef = useRef(false)

  const [logs, setLogs] = useState([])
  const [issues, setIssues] = useState([])
  const [health, setHealth] = useState(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [round, setRound] = useState(0)
  const [pulling, setPulling] = useState(false)

  // 상태와 로그를 함께 폴링 - 로그는 마지막 d_l_id 이후 것만 받는다
  const { data, error, loading, refresh } = usePolling(async () => {
    const [deploy, newLogs] = await Promise.all([deployApi.getOne(d_id), deployApi.getLogs(d_id, afterRef.current)])
    return { deploy, logs: newLogs }
  }, detailDelay, [d_id])
  const deploy = data?.deploy
  const status = deploy?.status

  // 받아들인 응답의 로그만 쌓고 커서를 옮긴다 (버려진 응답의 로그는 커서에 반영하지 않는다)
  useEffect(() => {
    if (!data || data.logs.length === 0) return
    afterRef.current = Math.max(afterRef.current, data.logs[data.logs.length - 1].d_l_id)
    setLogs((prev) => appendLogs(prev, data.logs))
  }, [data])

  // round 가 바뀌면(다시 배포·다시 켜기·이어서 배포) 로그를 처음부터 다시 받고 폴링을 다시 시작한다
  useEffect(() => {
    if (round === 0) return
    afterRef.current = 0
    setLogs([])
    refresh()
  }, [round, refresh])

  // 떠 있는 서비스만 헬스체크 - running 이 되었을 때 한 번
  useEffect(() => {
    if (status !== 'running') { setHealth(null); return }
    let alive = true
    deployApi.getHealth(d_id).then((result) => alive && setHealth(result)).catch(() => {})
    return () => { alive = false }
  }, [d_id, status === 'running'])

  // 문제 이력 - 다시 배포할 때, 실패가 막 쌓였을 때 새로 받는다
  useEffect(() => {
    let alive = true
    deployApi.getIssues(d_id).then((result) => alive && setIssues(result)).catch(() => {})
    return () => { alive = false }
  }, [d_id, round, status])

  const bumpRound = useCallback(() => setRound((n) => n + 1), [])

  // 동작 하나를 실행한다 - 실행하는 동안 버튼을 잠그고, 실패하면 빨간 알림을 띄운다
  const perform = async (call, onDone) => {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setActionError('')
    try {
      await call()
      onDone()
      return true
    } catch (e) {
      setActionError(e.message)
      return false
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // 다시 배포 - 성공 여부(true/false)를 돌려주는 쪽은 환경변수 카드용이다 (성공했을 때만 안내를 지운다)
  const redeployNow = () => perform(() => deployApi.redeploy(d_id), bumpRound)
  // 눌렀을 때 동작이 끝나기를 기다리지 않도록 값을 돌려주지 않는다
  const redeploy = () => { redeployNow() }
  const start = () => { perform(() => deployApi.start(d_id), bumpRound) }

  // 멈춤 - 요금이 나가는 서비스만 내린다. 이미지는 남아서 [다시 켜기]가 빌드 없이 끝난다
  const askStop = () => confirmStopDeploy(() => { perform(() => deployApi.stop(d_id), bumpRound) })

  // 목록으로 돌아간다 - 아래에 목록이 있으면 그 목록으로 되돌아가 낡은 목록이 남지 않게 하고, 없으면(주소로 바로 들어온 경우) 목록으로 바꾼다
  const backToList = () => {
    if (router.canGoBack()) router.dismissTo('/')
    else router.replace('/')
  }

  // 삭제 - AWS 리소스까지 지우므로 확인 뒤에만 부른다
  const askRemove = () => confirmAction({
    title: '이 배포를 삭제할까요?',
    message: 'AWS에 만든 ECS 서비스와 ECR 이미지가 함께 지워져 이 배포의 요금이 모두 멈춥니다. 되돌릴 수 없습니다.',
    cancelText: '그대로 두기',
    confirmText: '삭제',
    onConfirm: () => { perform(() => deployApi.remove(d_id), backToList) },
  })

  // 끌어당겨 새로고침
  const onPull = async () => {
    setPulling(true)
    try {
      await refresh()
    } finally {
      setPulling(false)
    }
  }

  let body
  if (!deploy) {
    body = loading
      ? <ActivityIndicator accessibilityLabel="불러오는 중" size="large" color={colors.accent} style={styles.spinner} />
      : (
        <View style={styles.stack}>
          <Notice>{error?.message}</Notice>
          <Button label="다시 시도" onPress={refresh} style={styles.self} />
        </View>
      )
  } else {
    const hasResources = Boolean(deploy.service_arn || deploy.image_uri)
    const idle = !isProgress(status) && status !== 'failed'
    body = (
      <View style={styles.stack}>
        {status === 'needs_input' && (
          <Notice tone="info">환경변수 입력이 필요합니다. 아래에서 값을 입력하거나 건너뛴 뒤 [이어서 배포]를 누르세요.</Notice>
        )}

        <Card>
          <View style={styles.headTop}>
            <View style={styles.headBody}>
              <Text accessibilityRole="header" style={[styles.name, { color: colors.text }]}>{repoName(deploy.repo_url)}</Text>
              <Text style={[styles.meta, { color: colors.muted }]}>
                {`#${deploy.d_id}`}
                {deploy.branch ? ` · ${deploy.branch}` : ''}
                {deploy.commit_sha ? ` · ${deploy.commit_sha.slice(0, 7)}` : ''}
                {deploy.language ? ` · ${deploy.language}` : ''}
                {deploy.app_dir && deploy.app_dir !== '.' ? ` · ${deploy.app_dir}/` : ''}
              </Text>
            </View>
            <StatusBadge status={status} />
          </View>
          <View style={styles.badges}>
            {deploy.support_level === 'experimental' && <Tag text="실험 지원" />}
            {deploy.fix_count > 0 && <Tag text={`자가수정 ${deploy.fix_count}회`} />}
            {status === 'running' && <HealthDot state={deploy.health_state} withLabel />}
          </View>
          <StepProgress status={status} errorStep={deploy.error_step} />
        </Card>

        {showsEnvCard(status) && <EnvVarsCard deploy={deploy} onContinued={bumpRound} onRedeploy={redeployNow} />}

        {status === 'running' && deploy.endpoint && (
          <EndpointCard endpoint={deploy.endpoint} health={health} onError={setActionError} />
        )}

        {!!deploy.open_incident_id && (
          <IncidentCard d_id={deploy.d_id} i_id={deploy.open_incident_id} label={problemLabel(deploy)} onPress={() => router.push(`/incidents/${deploy.open_incident_id}`)} />
        )}

        {status === 'stopped' && (
          <Card style={styles.stack}>
            <Text style={[styles.strong, { color: colors.text }]}>멈춘 상태입니다.</Text>
            <Text style={[styles.small, { color: colors.muted }]}>
              컨테이너와 주소는 내려갔습니다. 이미지만 남겨 두었고(소액의 저장 요금), [다시 켜기]를 누르면 빌드 없이 같은 버전이 다시 뜹니다.
            </Text>
            <Button variant="primary" label="다시 켜기" onPress={start} disabled={busy} />
          </Card>
        )}

        {status === 'failed' && (
          <ExplainCard
            explain={deploy.explain}
            errorStep={deploy.error_step}
            errorMsg={deploy.error_msg}
            hasResources={hasResources}
            busy={busy}
            onRedeploy={redeploy}
            onCleanup={askRemove}
          />
        )}

        {!!error && <Notice>{error.message}</Notice>}
        {!!actionError && <Notice>{actionError}</Notice>}

        <LogTerminal logs={logs} />

        {!!deploy.dockerfile && (
          <Collapsible title="Dockerfile" hint={`(${deploy.dockerfile_source} · 포트 ${deploy.port})`}>
            <ScrollView horizontal testID="dockerfile-box" style={[styles.code, { backgroundColor: colors.surface2 }]} contentContainerStyle={styles.codeContent}>
              <Text style={[styles.codeText, { color: colors.text }]}>{deploy.dockerfile}</Text>
            </ScrollView>
          </Collapsible>
        )}

        <IssueHistory issues={issues} />

        <Button label="설정" accessibilityLabel={`배포 #${d_id} 설정`} onPress={() => router.push(`/deploy-settings/${d_id}`)} />

        {idle && (
          <View style={styles.stack}>
            {status !== 'stopped' && status !== 'needs_input' && <Button label="다시 배포" onPress={redeploy} disabled={busy} />}
            {status === 'running' && <Button label="멈춤" onPress={askStop} disabled={busy} />}
            <Button variant="danger" label="삭제" onPress={askRemove} disabled={busy} />
          </View>
        )}
      </View>
    )
  }

  return (
    <>
      <Stack.Screen options={{ title: `배포 #${d_id}` }} />
      <KeyboardAvoidingView testID="keyboard-avoiding" behavior={Platform.OS === 'android' ? 'height' : undefined} style={styles.flex}>
        <ScrollView
          testID="detail-scroll"
          refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={colors.accent} colors={[colors.accent]} />}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={[styles.content, { paddingBottom: spacing.xl * 2 + insets.bottom }]}
          style={{ backgroundColor: colors.bg }}
        >
          {body}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  )
}

// 작은 주황 배지 (실험 지원, 자가수정)
function Tag({ text }) {
  const colors = useColors()
  return (
    <View style={[styles.tag, { backgroundColor: colors.warnBg }]}>
      <Text style={[styles.tagText, { color: colors.warn }]}>{text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  stack: { gap: spacing.md },
  self: { alignSelf: 'flex-start' },
  spinner: { marginTop: spacing.xl * 2 },
  headTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  headBody: { flex: 1, minWidth: 0 },
  name: { fontSize: 18, fontWeight: '700' },
  meta: { fontSize: 13, marginTop: spacing.xs, lineHeight: 18 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginVertical: spacing.sm },
  tag: { paddingHorizontal: 10, paddingVertical: 2, borderRadius: radius.pill },
  tagText: { fontSize: 12, fontWeight: '700' },
  strong: { fontSize: 15, fontWeight: '700' },
  small: { fontSize: 13, lineHeight: 19 },
  code: { borderRadius: radius.sm, marginTop: spacing.sm },
  codeContent: { padding: spacing.md },
  codeText: { fontFamily: monoFont, fontSize: 12.5, lineHeight: 18 },
})
