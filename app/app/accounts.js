import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack } from 'expo-router'
import { accountApi } from '../src/api'
import { DELETE_TEXT } from '../src/accounts/constants'
import { readPickedBlock, writePickedBlock } from '../src/accounts/pickedBlock'
import AddBlockForm from '../src/components/accounts/AddBlockForm'
import BlockCard from '../src/components/accounts/BlockCard'
import { Button, Notice } from '../src/components/ui'
import { confirmAction } from '../src/confirm'
import { spacing, useColors } from '../src/theme'

// 계정 연결 화면 (웹 AccountsPage) - 블록 하나 = AWS 계정 하나 + GitHub 하나. 블록은 세로 카드 목록으로 보인다
export default function AccountsScreen() {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const scrollRef = useRef(null)
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [pickedId, setPickedId] = useState(null)
  // 화면이 살아 있는지, 가장 최근 불러오기 번호, 같은 순간의 두 번째 누름 막기, 저장된 선택을 읽었는지
  const alive = useRef(true)
  const loadSeq = useRef(0)
  const busyRef = useRef(false)
  const pickedRead = useRef(false)
  // 방금 만든 블록 - 카드가 처음 배치될 때 그 위치로 스크롤한다
  const scrollTarget = useRef(null)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // 블록·AWS·GitHub 목록을 함께 다시 받는다 - 늦게 온 응답은 버리고, 실패하면 알린다. 성공 여부를 돌려준다
  const reload = async () => {
    const id = ++loadSeq.current
    try {
      const [connections, aws, github, stored] = await Promise.all([
        accountApi.getConnections(),
        accountApi.listAws(),
        accountApi.listGithub(),
        pickedRead.current ? null : readPickedBlock(),
      ])
      if (!alive.current || id !== loadSeq.current) return false
      setData({ connections, aws, github })
      setLoadError('')
      // 처음에는 저장해 둔 블록(아직 있을 때만), 이후에는 지금 고른 블록(사라졌으면 비운다)
      if (!pickedRead.current) {
        pickedRead.current = true
        setPickedId(connections.some((item) => item.c_id === stored) ? stored : null)
      } else {
        setPickedId((prev) => (connections.some((item) => item.c_id === prev) ? prev : null))
      }
      return true
    } catch (e) {
      if (!alive.current || id !== loadSeq.current) return false
      setLoadError(e.message)
      return false
    }
  }

  useEffect(() => { reload() }, [])

  // 한 가지 일을 하는 동안 버튼을 잠그고, 실패하면 빨간 알림에 서버 메시지를 보인다 (끝나면 반드시 푼다)
  const run = async (work) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
    } catch (e) {
      if (alive.current) setError(e.message)
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }

  // 블록 추가 - 만든 뒤 폼을 닫고 목록을 다시 받아, 새 카드가 보이는 곳으로 스크롤한다
  const addBlock = (label) => run(async () => {
    const created = await accountApi.createConnection(label)
    if (!alive.current) return
    setAdding(false)
    scrollTarget.current = created.c_id
    await reload()
  })

  // 블록 삭제 - 확인 뒤에만 지운다. 안전한 선택(그대로 두기)이 먼저다
  const askDelete = (block) => confirmAction({
    title: DELETE_TEXT.block.title,
    message: DELETE_TEXT.block.body,
    cancelText: '그대로 두기',
    confirmText: '블록 삭제',
    onConfirm: () => {
      run(async () => {
        await accountApi.deleteConnection(block.c_id)
        await reload()
      })
    },
  })

  // 블록 선택 - 새 배포 화면이 이 블록을 미리 골라 둔다
  const pick = (block) => {
    writePickedBlock(block.c_id)
    setPickedId(block.c_id)
  }

  // 새로 만든 카드가 처음 배치되면 그 위치로 스크롤한다 (한 번만)
  const onCardLayout = (c_id, e) => {
    if (scrollTarget.current !== c_id) return
    scrollTarget.current = null
    scrollRef.current?.scrollTo?.({ y: e.nativeEvent.layout.y, animated: true })
  }

  const connections = data?.connections
  let body = null
  if (!connections && loadError) {
    body = (
      <View style={styles.gap}>
        <Notice>{`계정 연결을 불러오지 못했습니다. ${loadError}`}</Notice>
        <Button label="다시 시도" onPress={() => { reload() }} style={styles.self} />
      </View>
    )
  } else if (!connections) {
    body = <ActivityIndicator accessibilityLabel="불러오는 중" size="large" color={colors.accent} style={styles.spinner} />
  } else {
    body = (
      <>
        <Text style={[styles.intro, { color: colors.muted }]}>
          블록 하나에 AWS 계정 하나와 GitHub 하나를 묶어 연결합니다. 한 번 연결해 두면 그 블록으로 몇 개든 배포할 수 있어 보통 블록 하나면 충분합니다. 다른 AWS 계정에도 배포할 때만 블록을 추가하세요.
          {connections.length === 0 ? ' 아직 블록이 없습니다 — 아래 [＋ 블록 추가]로 시작하세요. 연결 없이도 public 레포는 개발용 계정으로 배포됩니다.' : ''}
        </Text>
        {!!loadError && <Notice>{`목록을 새로 받지 못했습니다. ${loadError}`}</Notice>}
        {adding
          ? <AddBlockForm busy={busy} onSubmit={addBlock} onCancel={() => setAdding(false)} />
          : <Button label="＋ 블록 추가" variant={connections.length === 0 ? 'primary' : 'default'} disabled={busy} onPress={() => setAdding(true)} />}
        {connections.map((block) => (
          <View key={block.c_id} testID={`block-row-${block.c_id}`} onLayout={(e) => onCardLayout(block.c_id, e)}>
            <BlockCard
              block={block}
              picked={connections.length === 1 || block.c_id === pickedId}
              busy={busy}
              onPick={pick}
              onDelete={askDelete}
            />
          </View>
        ))}
      </>
    )
  }

  return (
    <>
      <Stack.Screen options={{ title: '계정 연결' }} />
      <KeyboardAvoidingView testID="keyboard-avoiding" behavior={Platform.OS === 'android' ? 'height' : undefined} style={styles.flex}>
        <ScrollView
          testID="accounts-scroll"
          ref={scrollRef}
          style={{ backgroundColor: colors.bg }}
          contentContainerStyle={[styles.content, { paddingBottom: spacing.xl * 2 + insets.bottom }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
        >
          {!!error && <Notice>{error}</Notice>}
          {!!notice && <Notice tone="info">{notice}</Notice>}
          {body}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  gap: { gap: spacing.md },
  self: { alignSelf: 'flex-start' },
  intro: { fontSize: 14, lineHeight: 20 },
  spinner: { marginTop: spacing.xl * 2 },
})
