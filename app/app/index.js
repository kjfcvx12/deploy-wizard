import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import { Text } from '../src/components/Text'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, useFocusEffect, useRouter } from 'expo-router'
import { deployApi } from '../src/api'
import BellButton from '../src/components/ops/BellButton'
import HealthDot from '../src/components/ops/HealthDot'
import ProblemBanner from '../src/components/ops/ProblemBanner'
import QuickLinks from '../src/components/ops/QuickLinks'
import StatusBadge from '../src/components/StatusBadge'
import { isProgress, repoName } from '../src/constants'
import { usePolling } from '../src/hooks/usePolling'
import { useUnreadCount } from '../src/hooks/useUnreadCount'
import { radius, spacing, useColors } from '../src/theme'

// 목록 갱신 간격 (웹 DeployListPage 와 같다) - 진행 중이면 3초, 아니면 15초, 실패하면 10초
const FAST_MS = 3000
const SLOW_MS = 15000
const RETRY_MS = 10000

// 다음 조회까지 기다릴 시간을 정한다
function listDelay(value, error) {
  if (error) return RETRY_MS
  return value.some((d) => isProgress(d.status)) ? FAST_MS : SLOW_MS
}

// 카드 한 줄 메타 - #번호 · 브랜치 · 언어 · 주소 · 환경변수 안내 (웹과 같은 조립)
function metaLine(deploy) {
  return `#${deploy.d_id}`
    + (deploy.branch ? ` · ${deploy.branch}` : '')
    + (deploy.language ? ` · ${deploy.language}` : '')
    + (deploy.endpoint ? ` · ${deploy.endpoint.replace('https://', '')}` : '')
    + (deploy.env_pending > 0 ? ` · 환경변수 ${deploy.env_pending}개 입력 필요` : '')
}

// 헤더·빈 화면의 버튼 - 헤더에서는 글자만(flat), 빈 화면에서는 채운 버튼. 눌림 높이는 44pt 이상
function ActionButton({ label, onPress, flat = false }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.primary, !flat && { backgroundColor: colors.accent }, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={[styles.primaryText, { color: flat ? colors.accent : colors.accentText }]}>{label}</Text>
    </Pressable>
  )
}

// 서버에 닿지 못했을 때의 앞머리 문장 (api.js 의 연결 실패 메시지와 같다)
const NETWORK_MESSAGE = '서버에 연결할 수 없습니다'

// 서버에 닿지 못했을 때의 안내와 다시 시도 버튼 - 메시지가 앞머리와 같으면 한 번만 보여 준다
function ErrorNotice({ message, onRetry }) {
  const colors = useColors()
  return (
    <View style={[styles.notice, { backgroundColor: colors.errBg }]}>
      <Text style={[styles.noticeText, { color: colors.err }]}>{message === NETWORK_MESSAGE ? message : `${NETWORK_MESSAGE} :${message}`}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        style={({ pressed }) => [styles.secondary, { borderColor: colors.err, opacity: pressed ? 0.7 : 1 }]}
      >
        <Text style={[styles.secondaryText, { color: colors.err }]}>다시 시도</Text>
      </Pressable>
    </View>
  )
}

// 배포 한 건 카드 - 누르면 상세 화면으로 간다
function DeployCard({ deploy, onPress }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: pressed ? colors.surface2 : colors.surface, borderColor: colors.border },
      ]}
    >
      <View style={styles.cardBody}>
        <Text style={[styles.name, { color: colors.text }]}>{repoName(deploy.repo_url)}</Text>
        <Text style={[styles.meta, { color: colors.muted }]}>{metaLine(deploy)}</Text>
      </View>
      <View style={styles.badges}>
        <StatusBadge status={deploy.status} />
        {deploy.status === 'running' && <HealthDot state={deploy.health_state} />}
      </View>
    </Pressable>
  )
}

// 배포 목록 화면 (S-02) - 내가 배포한 서비스와 현재 상태
export default function DeployListScreen() {
  const colors = useColors()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [pulling, setPulling] = useState(false)
  const { data, error, loading, refresh } = usePolling(() => deployApi.getAll(), listDelay, [])
  const { count: unread, refresh: refreshUnread } = useUnreadCount()

  // 열린 인시던트가 있는 배포 - 목록 위에 배너로 알린다
  const problems = data ? data.filter((d) => d.open_incident_id) : []

  const goNew = () => router.push('/new')
  const goAccounts = () => router.push('/accounts')
  const goNotifications = () => router.push('/notifications')
  const goNotificationSettings = () => router.push('/notification-settings')

  // 다른 화면에서 돌아오면 목록과 안 읽은 알림 수를 다시 받는다 (계정 연결·새 배포·상세·알림 화면에서 바뀐 것이 낡게 남지 않게). 처음 열 때는 usePolling 이 이미 받는다
  const focusedOnce = useRef(false)
  useFocusEffect(useCallback(() => {
    if (!focusedOnce.current) { focusedOnce.current = true; return }
    refresh()
    refreshUnread()
  }, [refresh, refreshUnread]))

  // 끌어당겨 새로고침
  const onPull = async () => {
    setPulling(true)
    try {
      await refresh()
    } finally {
      setPulling(false)
    }
  }

  // 목록이 비었거나 아직 없을 때 보여 줄 것
  let empty = null
  if (!data && loading) {
    empty = <ActivityIndicator accessibilityLabel="불러오는 중" size="large" color={colors.accent} style={styles.spinner} />
  } else if (!data && error) {
    empty = <ErrorNotice message={error.message} onRetry={refresh} />
  } else if (data && data.length === 0) {
    empty = (
      <View style={styles.empty}>
        <Text style={[styles.emptyText, { color: colors.muted }]}>아직 배포한 것이 없습니다.</Text>
        <ActionButton label="＋ 새 배포" onPress={goNew} />
      </View>
    )
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{
        title: '배포',
        headerRight: () => (
          <View style={styles.headerRight}>
            <BellButton count={unread} onPress={goNotifications} />
            <ActionButton flat label="＋ 새 배포" onPress={goNew} />
          </View>
        ),
      }} />
      <QuickLinks links={[{ label: '계정 연결', onPress: goAccounts }, { label: '알림 설정', onPress: goNotificationSettings }]} />
      <FlatList
        testID="deploy-list"
        data={data || []}
        keyExtractor={(deploy) => String(deploy.d_id)}
        renderItem={({ item }) => <DeployCard deploy={item} onPress={() => router.push(`/deploys/${item.d_id}`)} />}
        ListHeaderComponent={(data && error) || problems.length > 0 ? (
          <View style={styles.header}>
            {data && error ? <ErrorNotice message={error.message} onRetry={refresh} /> : null}
            {problems.map((d) => <ProblemBanner key={d.d_id} deploy={d} onPress={() => router.push(`/incidents/${d.open_incident_id}`)} />)}
          </View>
        ) : null}
        ListEmptyComponent={empty}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={colors.accent} colors={[colors.accent]} />}
        contentContainerStyle={[styles.content, { paddingBottom: spacing.xl * 2 + insets.bottom }]}
        style={{ backgroundColor: colors.bg }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xl * 2, gap: spacing.md },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    minHeight: 64,
    padding: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.md,
  },
  cardBody: { flex: 1, minWidth: 0 },
  badges: { alignItems: 'flex-end', gap: spacing.sm },
  header: { gap: spacing.md },
  name: { fontSize: 16, fontWeight: '700' },
  meta: { fontSize: 13, marginTop: spacing.xs },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  primary: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontSize: 15, fontWeight: '700' },
  secondary: {
    minHeight: 44,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { fontSize: 15, fontWeight: '700' },
  notice: { padding: spacing.lg, borderRadius: radius.md, gap: spacing.md },
  noticeText: { fontSize: 14 },
  empty: { alignItems: 'center', gap: spacing.lg, paddingVertical: spacing.xl * 2 },
  emptyText: { fontSize: 15, textAlign: 'center' },
  spinner: { marginTop: spacing.xl * 2 },
})
