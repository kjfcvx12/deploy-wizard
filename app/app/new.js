import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { Text } from '../src/components/Text'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, useFocusEffect, useRouter } from 'expo-router'
import { accountApi, adviceApi, deployApi } from '../src/api'
import AdvicePanel from '../src/components/AdvicePanel'
import { readPickedBlock } from '../src/accounts/pickedBlock'
import ConnectionPicker, { isUsableConnection, pickDefaultConnection } from '../src/components/ConnectionPicker'
import NoConnectionHint from '../src/components/NoConnectionHint'
import { radius, spacing, useColors } from '../src/theme'

// 빨간 오류 안내 - 서버가 준 detail 을 그대로 보여 준다
function ErrorNotice({ message }) {
  const colors = useColors()
  return (
    <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: colors.errBg }]}>
      <Text style={[styles.noticeText, { color: colors.err }]}>{message}</Text>
    </View>
  )
}

// 누를 수 있는 한 줄 (레포 목록, 브랜치 목록 공용) - 고른 것은 강조 테두리
function ChoiceRow({ label, tag, selected, onPress }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        { backgroundColor: pressed ? colors.surface2 : colors.surface, borderColor: selected ? colors.accent : colors.border },
      ]}
    >
      <Text style={[styles.choiceText, { color: colors.text }]}>{label}</Text>
      {tag && <Text style={[styles.tag, { color: colors.muted, backgroundColor: colors.surface2 }]}>{tag}</Text>}
    </Pressable>
  )
}

// 블록이 실제로 쓰는 AWS·GitHub 번호 - 이 번호가 바뀌면 분석 결과가 낡은 것이다
const effectiveIds = (item) => `${item?.aws?.status === 'verified' ? item.aws.a_id : ''}|${item?.github?.status === 'active' ? item.github.g_id : ''}`

// 아래 안내 문장 - 브랜치 기본값, GitHub 연결 여부에 따라 달라진다
function helperText(githubId, repoCount, hasBlocks) {
  const base = '브랜치를 고르지 않으면 레포의 기본 브랜치를 분석합니다.'
  if (githubId) {
    const list = repoCount > 0 ? ` — 아래 목록에서 이 계정의 레포 ${repoCount}개를 고를 수 있습니다` : ''
    return `${base} GitHub 연결을 골랐으니 private 레포도 됩니다${list}.`
  }
  if (hasBlocks) return `${base} 지금은 public 레포만 됩니다 — private 레포는 위에서 GitHub 연결을 고르세요.`
  return `${base} 지금은 public 레포만 됩니다 — private 레포는 계정 연결 화면에서 GitHub 연결을 만든 뒤 쓸 수 있습니다.`
}

// 새 배포 화면 (S-03, S-20) - 두 단계: [분석](읽기만 함) -> 결과를 보고 [이 레포로 배포]. 입력이 바뀌면 이전 분석 결과는 지운다
export default function NewDeployScreen() {
  const colors = useColors()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const scrollRef = useRef(null)
  const headingRef = useRef(null)
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [remote, setRemote] = useState(null)
  const [connections, setConnections] = useState([])
  const [connectionId, setConnectionId] = useState('')
  // 연결 목록을 한 번 받아 마쳤는지 (받는 동안·실패했을 때는 "연결 없음" 안내를 보이지 않는다), 사용자가 직접 블록을 골랐는지
  const [connectionsLoaded, setConnectionsLoaded] = useState(false)
  const userChose = useRef(false)
  // 지금 고른 블록 번호와 마지막으로 받은 쓸 수 있는 블록들 - 늦게 도착한 응답이 낡은 상태를 보지 않게 ref 로 둔다
  const connectionIdRef = useRef('')
  const connectionsRef = useRef([])
  const connectionsRequest = useRef(0)
  const mounted = useRef(true)
  const focusedOnce = useRef(false)
  const [repositories, setRepositories] = useState([])
  const [busy, setBusy] = useState(false)
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState('')
  const [advice, setAdvice] = useState(null)
  // 분석한 그대로의 입력 - 배포는 이 값으로 만든다
  const [analyzed, setAnalyzed] = useState(null)
  // 분석 요청 번호 - 입력이 바뀐 뒤 늦게 도착한 결과를 버리고, 같은 순간의 두 번째 누름을 막는다
  const analysisId = useRef(0)
  const analyzeInflight = useRef(false)
  const deployInflight = useRef(false)
  const repositoriesRequest = useRef(0)
  // 브랜치 요청 번호 - 입력이 바뀐 뒤 늦게 도착한 브랜치 목록(과 오류)을 버린다
  const branchesRequest = useRef(0)
  // 새 분석 결과가 처음 보일 때만 그 위치로 스크롤하고 읽기 초점을 옮긴다 (접기·펴기로 크기가 바뀔 때는 건드리지 않는다)
  const pendingReveal = useRef(false)

  const block = connections.find((item) => String(item.c_id) === connectionId)
  const awsId = block?.aws?.status === 'verified' ? String(block.aws.a_id) : ''
  const githubId = block?.github?.status === 'active' ? String(block.github.g_id) : ''
  const locked = busy || analyzing || loadingBranches

  // 입력이 바뀌면 이전 분석 결과를 지운다 (낡은 결과로 배포하지 않게). 진행 중인 분석 결과도 버린다
  const invalidate = () => {
    analysisId.current += 1
    branchesRequest.current += 1
    analyzeInflight.current = false
    pendingReveal.current = false
    setLoadingBranches(false)
    setAdvice(null)
    setAnalyzed(null)
    setAnalyzing(false)
    setError('')
  }

  // 레포 목록 불러오기 - 못 불러오면 빈 목록 (주소는 직접 입력할 수 있다). 늦게 온 목록은 버린다
  const loadRepositories = (g_id) => {
    const request = ++repositoriesRequest.current
    setRepositories([])
    if (!g_id) return
    accountApi.getGithubRepositories(g_id).then((list) => {
      // 주소가 없는 항목은 건너뛴다
      if (request === repositoriesRequest.current) setRepositories(Array.isArray(list) ? list.filter((repo) => typeof repo?.html_url === 'string' && typeof repo.full_name === 'string') : [])
    }).catch(() => {})
  }

  // 연결 블록 하나를 적용 - 그 블록의 GitHub 설치로 레포 목록을 다시 받고, 브랜치 목록은 비운다
  const applyBlock = (picked) => {
    connectionIdRef.current = picked ? String(picked.c_id) : ''
    setConnectionId(connectionIdRef.current)
    setRemote(null)
    setBranch('')
    loadRepositories(picked?.github?.status === 'active' ? picked.github.g_id : null)
  }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // 연결 목록과 계정 연결 화면에서 [선택]해 둔 블록 번호를 함께 받아 적용한다 (저장소를 못 읽으면 null - 목록은 그대로 쓴다). 늦게 온 응답은 버리고, 실패하면 지금 화면을 그대로 둔다
  const loadConnections = () => {
    const request = ++connectionsRequest.current
    Promise.all([accountApi.getConnections(), readPickedBlock()]).then(([data, stored]) => {
      if (!mounted.current || request !== connectionsRequest.current) return
      const usable = (data || []).filter(isUsableConnection)
      const before = connectionsRef.current
      connectionsRef.current = usable
      setConnections(usable)
      setConnectionsLoaded(true)
      const current = connectionIdRef.current
      if (current !== '') {
        // 고른 블록이 사라졌거나 쓸 수 없게 됐으면 선택을 비운다. 아직 쓸 수 있어도 쓰는 AWS·GitHub 가 바뀌었으면 레포 목록을 다시 받고 분석 결과를 지운다. 그대로면 건드리지 않는다
        const now = usable.find((item) => String(item.c_id) === current)
        if (!now) { applyBlock(null); invalidate() } else if (effectiveIds(now) !== effectiveIds(before.find((item) => String(item.c_id) === current))) {
          loadRepositories(now.github?.status === 'active' ? now.github.g_id : null)
          invalidate()
        }
        return
      }
      // 연결은 한 번 해 두고 계속 쓰는 것이다 - 선택해 둔 블록(여럿일 때), 아니면 하나뿐인 블록을 미리 골라 둔다. 사용자가 이미 고른 것(연결 안 함 포함)은 덮지 않는다 (바꿀 수 있다)
      const initial = userChose.current ? null : pickDefaultConnection(usable, stored)
      if (initial) { applyBlock(initial); invalidate() }
    }).catch(() => {})
  }

  useEffect(() => { loadConnections() }, [])

  // 다른 화면(계정 연결)에 다녀와 다시 포커스를 받으면 연결 목록을 다시 받는다. 처음 열 때는 위 효과가 이미 받는다
  useFocusEffect(useCallback(() => {
    if (!focusedOnce.current) { focusedOnce.current = true; return }
    loadConnections()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []))

  // 연결 블록을 바꿨을 때
  const chooseConnection = (value) => {
    userChose.current = true
    applyBlock(connections.find((item) => String(item.c_id) === value))
    invalidate()
  }

  // 브랜치 목록 불러오기 - 고르고 싶을 때만
  const loadBranches = async () => {
    if (locked || !repoUrl.trim()) return
    const id = ++branchesRequest.current
    setError('')
    setLoadingBranches(true)
    try {
      const data = await deployApi.getRemote(repoUrl.trim(), githubId)
      if (id !== branchesRequest.current) return
      setRemote(data)
      setBranch(data.default_branch || '')
      invalidate()
    } catch (e) {
      if (id !== branchesRequest.current) return
      setRemote(null)
      setError(e.message)
    } finally {
      if (id === branchesRequest.current) setLoadingBranches(false)
    }
  }

  // 분석 - 레포를 읽기만 한다 (AWS 에 아무것도 만들지 않는다)
  const analyze = async () => {
    if (locked || analyzeInflight.current || !repoUrl.trim()) return
    analyzeInflight.current = true
    const id = ++analysisId.current
    const inputs = { repo_url: repoUrl.trim(), branch: branch || null, aws_account_id: awsId || null, github_installation_id: githubId || null }
    pendingReveal.current = false
    setError('')
    setAdvice(null)
    setAnalyzing(true)
    try {
      const data = await adviceApi.analyze(inputs)
      if (id === analysisId.current) { pendingReveal.current = true; setAdvice(data); setAnalyzed(inputs) }
    } catch (e) {
      if (id === analysisId.current) setError(e.message)
    } finally {
      if (id === analysisId.current) { analyzeInflight.current = false; setAnalyzing(false) }
    }
  }

  // 분석 결과를 본 뒤 배포 - 입력이 바뀌면 결과가 지워지므로 분석한 그대로의 입력으로 만든다
  const deploy = async () => {
    if (locked || deployInflight.current || !analyzed) return
    deployInflight.current = true
    setError('')
    setBusy(true)
    try {
      const created = await deployApi.create(analyzed.repo_url, analyzed.branch, analyzed.aws_account_id, analyzed.github_installation_id)
      router.replace(`/deploys/${created.d_id}`)
    } catch (e) {
      setError(e.message)
      setBusy(false)
      deployInflight.current = false
    }
  }

  // 새 결과 패널이 처음 배치되면 그 위치로 스크롤하고, 화면 읽기 초점을 제목으로 옮긴다 (웹 AdvicePanel 의 제목 포커스와 같은 목적)
  const onPanelLayout = (e) => {
    if (!pendingReveal.current) return
    pendingReveal.current = false
    scrollRef.current?.scrollTo?.({ y: e.nativeEvent.layout.y, animated: true })
    if (Platform.OS !== 'web' && headingRef.current && typeof AccessibilityInfo.sendAccessibilityEvent === 'function') {
      AccessibilityInfo.sendAccessibilityEvent(headingRef.current, 'focus')
    }
  }

  const typed = repoUrl.trim().toLowerCase()
  const exact = repositories.some((repo) => repo.html_url.toLowerCase() === typed)
  const shownRepositories = exact ? [] : repositories.filter((repo) => repo.html_url.toLowerCase().includes(typed))

  return (
    <>
      <Stack.Screen options={{ title: '새 배포' }} />
      <KeyboardAvoidingView testID="keyboard-avoiding" behavior={Platform.OS === 'android' ? 'height' : undefined} style={styles.flex}>
        <ScrollView
          testID="new-scroll"
          ref={scrollRef}
          style={{ backgroundColor: colors.bg }}
          contentContainerStyle={[styles.content, { paddingBottom: spacing.xl * 2 + insets.bottom }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
        >
          <ConnectionPicker connections={connections} value={connectionId} onChange={chooseConnection} />
          {connectionsLoaded && connections.length === 0 && <NoConnectionHint />}

          <TextInput
            style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
            placeholder={repositories.length > 0 ? '레포를 고르거나 주소를 입력하세요' : 'https://github.com/소유자/레포'}
            placeholderTextColor={colors.muted}
            value={repoUrl}
            onChangeText={(text) => { setRepoUrl(text); setRemote(null); setBranch(''); invalidate() }}
            onSubmitEditing={() => { analyze() }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            accessibilityLabel="GitHub 레포 주소"
          />
  
          {shownRepositories.length > 0 && (
            <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={styles.list} contentContainerStyle={styles.listContent}>
              {shownRepositories.map((repo) => (
                <ChoiceRow
                  key={repo.full_name}
                  label={repo.full_name}
                  tag={repo.private ? 'private' : 'public'}
                  onPress={() => { setRepoUrl(repo.html_url); setRemote(null); setBranch(''); invalidate() }}
                />
              ))}
            </ScrollView>
          )}
  
          {remote && (
            <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={styles.list} contentContainerStyle={styles.listContent}>
              {remote.branches.map((name) => (
                <ChoiceRow
                  key={name}
                  label={name === remote.default_branch ? `${name} (기본)` : name}
                  selected={name === branch}
                  onPress={() => { setBranch(name); invalidate() }}
                />
              ))}
            </ScrollView>
          )}
  
          <View style={styles.actions}>
            {!remote && (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: locked || !repoUrl.trim() }}
                disabled={locked || !repoUrl.trim()}
                onPress={() => { loadBranches() }}
                style={({ pressed }) => [styles.button, styles.outline, { borderColor: colors.border, opacity: locked || !repoUrl.trim() ? 0.5 : pressed ? 0.7 : 1 }]}
              >
                <Text style={[styles.buttonText, { color: colors.text }]}>브랜치 고르기</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: locked || !repoUrl.trim() }}
              disabled={locked || !repoUrl.trim()}
              onPress={() => { analyze() }}
              style={({ pressed }) => [styles.button, { backgroundColor: colors.accent, opacity: locked || !repoUrl.trim() ? 0.5 : pressed ? 0.7 : 1 }]}
            >
              {analyzing && <ActivityIndicator size="small" color={colors.accentText} />}
              <Text style={[styles.buttonText, { color: colors.accentText }]}>{analyzing ? '분석 중...' : '분석'}</Text>
            </Pressable>
          </View>
  
          <Text style={[styles.helper, { color: colors.muted }]}>{helperText(githubId, repositories.length, connections.length > 0)}</Text>
          {!!error && !advice && <ErrorNotice message={error} />}
  
          {advice && (
            <View testID="advice-panel" onLayout={onPanelLayout}>
              <AdvicePanel advice={advice} busy={locked} onDeploy={() => { deploy() }} onReset={invalidate} headingRef={headingRef} />
            </View>
          )}
          {!!error && !!advice && <ErrorNotice message={error} />}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xl * 2, gap: spacing.md },
  input: { minHeight: 48, paddingHorizontal: spacing.md, borderWidth: 1, borderRadius: radius.md, fontSize: 15 },
  list: { maxHeight: 220 },
  listContent: { gap: spacing.sm },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
  },
  choiceText: { flex: 1, minWidth: 0, fontSize: 14 },
  tag: { fontSize: 12, fontWeight: '700', paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden' },
  actions: { flexDirection: 'row', gap: spacing.sm },
  button: {
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  outline: { borderWidth: 1 },
  buttonText: { fontSize: 15, fontWeight: '700' },
  helper: { fontSize: 13, lineHeight: 18 },
  notice: { padding: spacing.lg, borderRadius: radius.md },
  noticeText: { fontSize: 14, lineHeight: 20 },
})
