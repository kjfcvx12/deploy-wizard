import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import { notificationApi } from '../src/api'
import NotificationItem from '../src/components/ops/NotificationItem'
import { Button, Notice } from '../src/components/ui'
import { parseAppLink } from '../src/ops/links'
import { spacing, useColors } from '../src/theme'

// 서버가 한 번에 주는 건수 - 이만큼 받았으면 더 있을 수 있다
const PAGE_SIZE = 100
// 같은 줄을 연달아 누른 것으로 보는 시간(ms)
const DOUBLE_TAP_MS = 600

// 알림이 가리키는 화면 경로 - 인시던트 알림은 인시던트, 배포 알림은 배포 (번호가 없거나 올바르지 않으면 null)
function notificationRoute(item) {
  const isIncident = typeof item.kind === 'string' && item.kind.startsWith('incident_')
  const link = parseAppLink(isIncident ? `/incidents/${item.i_id}` : `/deploys/${item.d_id}`)
  return link ? link.route : null
}

// 지금 받은 목록에서 가장 오래된 n_id - 다음 쪽을 받을 기준(after)
const oldestId = (items) => items.reduce((min, item) => Math.min(min, item.n_id), Infinity)

// 알림 목록 화면 (S-12) - 읽지 않은 것은 굵게 + 점, 누르면 읽음 처리 후 관련 화면으로 간다
export default function NotificationsScreen() {
  const colors = useColors()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const listRef = useRef(null)
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [moreError, setMoreError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [moreBusy, setMoreBusy] = useState(false)
  const [readAllBusy, setReadAllBusy] = useState(false)
  const [pulling, setPulling] = useState(false)
  // 화면이 살아 있는지, 가장 최근 목록 번호, 같은 순간의 두 번째 누름 막기
  const alive = useRef(true)
  const loadSeq = useRef(0)
  const itemsRef = useRef(null)
  const moreBusyRef = useRef(false)
  const readAllRef = useRef(false)
  const pendingReads = useRef(new Set())
  const markSeq = useRef(0)
  const lastTap = useRef({ n_id: null, at: 0 })

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // 목록을 바꾼다 (최신 값을 ref 에도 둬서 비동기 안에서 읽을 수 있게)
  const put = (next) => {
    itemsRef.current = next
    setItems(next)
  }

  // 처음 쪽을 받아 목록을 바꾼다 - 늦게 온 응답은 버린다. 성공 여부를 돌려준다
  const load = async () => {
    const id = ++loadSeq.current
    try {
      const page = await notificationApi.getAll({})
      if (!alive.current || id !== loadSeq.current) return false
      put(page)
      setHasMore(page.length >= PAGE_SIZE)
      setError('')
      setMoreError('')
      return true
    } catch (e) {
      if (!alive.current || id !== loadSeq.current) return false
      setError(e.message)
      return false
    }
  }

  useEffect(() => { load() }, [])

  // 끌어당겨 새로고침 - 실패하면 목록은 그대로 두고 알린다
  const onPull = async () => {
    setPulling(true)
    try {
      await load()
    } finally {
      if (alive.current) setPulling(false)
    }
  }

  // 다음 쪽을 이어 붙인다 - after 는 가장 오래된 n_id, 이미 있는 n_id 는 건너뛴다. 받는 중 새로고침이 끼면 이 응답은 버린다
  const loadMore = async () => {
    if (moreBusyRef.current || !itemsRef.current || itemsRef.current.length === 0) return
    moreBusyRef.current = true
    setMoreBusy(true)
    setMoreError('')
    const id = loadSeq.current
    try {
      const page = await notificationApi.getAll({ after: oldestId(itemsRef.current) })
      if (!alive.current || id !== loadSeq.current) return
      const seen = new Set(itemsRef.current.map((item) => item.n_id))
      put([...itemsRef.current, ...page.filter((item) => !seen.has(item.n_id))])
      setHasMore(page.length >= PAGE_SIZE)
    } catch (e) {
      if (alive.current && id === loadSeq.current) setMoreError(e.message)
    } finally {
      moreBusyRef.current = false
      if (alive.current) setMoreBusy(false)
    }
  }

  // 오류를 맨 위 알림으로 올린다
  const fail = (message) => {
    setActionError(message)
    listRef.current?.scrollToOffset?.({ offset: 0, animated: true })
  }

  // 표시한 읽음 값을 되돌린다 - 그사이 다른 값으로 바뀐 줄은 건드리지 않는다
  const rollback = (marker, ids) => {
    put(itemsRef.current.map((item) => (ids.includes(item.n_id) && item.read_at === marker ? { ...item, read_at: null } : item)))
  }

  // 줄을 누르면: 읽지 않은 것은 먼저 읽음으로 보이고(요청은 뒤에서) 관련 화면으로 간다. 실패하면 되돌리고 알린다
  const onItem = (item) => {
    const now = Date.now()
    if (pendingReads.current.has(item.n_id)) return
    if (lastTap.current.n_id === item.n_id && now - lastTap.current.at < DOUBLE_TAP_MS) return
    lastTap.current = { n_id: item.n_id, at: now }
    setActionError('')
    const route = notificationRoute(item)
    if (!item.read_at) {
      const marker = `pending-${++markSeq.current}`
      pendingReads.current.add(item.n_id)
      put(itemsRef.current.map((row) => (row.n_id === item.n_id ? { ...row, read_at: marker } : row)))
      notificationApi.read(item.n_id)
        .then((saved) => {
          if (!alive.current) return
          const stamp = (saved && saved.read_at) || new Date().toISOString()
          put(itemsRef.current.map((row) => (row.n_id === item.n_id && row.read_at === marker ? { ...row, read_at: stamp } : row)))
        })
        .catch((e) => {
          if (!alive.current) return
          rollback(marker, [item.n_id])
          fail(`읽음으로 표시하지 못했습니다 :${e.message}`)
        })
        .finally(() => { pendingReads.current.delete(item.n_id) })
    }
    if (route) router.push(route)
  }

  // 모두 읽음 - 읽지 않던 줄만 먼저 읽음으로 보이고, 실패하면 그 줄들만 되돌린다
  const onReadAll = async () => {
    if (readAllRef.current || !itemsRef.current) return
    readAllRef.current = true
    setReadAllBusy(true)
    setActionError('')
    const marker = `pending-all-${++markSeq.current}`
    const ids = itemsRef.current.filter((item) => !item.read_at).map((item) => item.n_id)
    put(itemsRef.current.map((item) => (ids.includes(item.n_id) ? { ...item, read_at: marker } : item)))
    try {
      await notificationApi.readAll()
      if (!alive.current) return
      const stamp = new Date().toISOString()
      put(itemsRef.current.map((item) => (item.read_at === marker ? { ...item, read_at: stamp } : item)))
    } catch (e) {
      if (!alive.current) return
      rollback(marker, ids)
      fail(`모두 읽음으로 표시하지 못했습니다 :${e.message}`)
    } finally {
      readAllRef.current = false
      if (alive.current) setReadAllBusy(false)
    }
  }

  // 목록이 비었거나 아직 없을 때 보여 줄 것
  let empty = null
  if (!items && !error) {
    empty = <ActivityIndicator accessibilityLabel="불러오는 중" size="large" color={colors.accent} style={styles.spinner} />
  } else if (!items) {
    empty = (
      <View style={styles.gap}>
        <Notice>{`서버에 연결할 수 없습니다 :${error}`}</Notice>
        <Button label="다시 시도" onPress={() => { load() }} />
      </View>
    )
  } else if (items.length === 0) {
    empty = <Text style={[styles.emptyText, { color: colors.muted }]}>새 알림이 없습니다</Text>
  }

  const hasItems = !!items && items.length > 0
  return (
    <>
      <Stack.Screen options={{ title: '알림' }} />
      <FlatList
        ref={listRef}
        testID="notification-list"
        data={items || []}
        keyExtractor={(item) => String(item.n_id)}
        renderItem={({ item }) => <NotificationItem item={item} onPress={() => onItem(item)} />}
        ListHeaderComponent={(items && error) || actionError || hasItems ? (
          <View style={styles.gap}>
            {items && error ? <Notice>{`새로 받지 못했습니다 :${error}`}</Notice> : null}
            {actionError ? <Notice>{actionError}</Notice> : null}
            {hasItems ? <Button label="모두 읽음" onPress={() => { onReadAll() }} disabled={readAllBusy} style={styles.readAll} /> : null}
          </View>
        ) : null}
        ListFooterComponent={hasItems && hasMore ? (
          <View style={styles.gap}>
            {moreError ? <Notice>{`더 받지 못했습니다 :${moreError}`}</Notice> : null}
            <Button label="더 보기" onPress={() => { loadMore() }} disabled={moreBusy} />
          </View>
        ) : null}
        ListEmptyComponent={empty}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={colors.accent} colors={[colors.accent]} />}
        contentContainerStyle={[styles.content, { paddingBottom: spacing.xl * 2 + insets.bottom }]}
        style={{ backgroundColor: colors.bg }}
      />
    </>
  )
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  gap: { gap: spacing.md },
  readAll: { alignSelf: 'flex-end' },
  emptyText: { fontSize: 15, textAlign: 'center', paddingVertical: spacing.xl * 2 },
  spinner: { marginTop: spacing.xl * 2 },
})
