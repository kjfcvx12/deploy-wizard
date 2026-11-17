import { useCallback, useEffect, useRef, useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { Text } from '../src/components/Text'
import FitScreen from '../src/components/FitScreen'
import { Button, Card, Notice } from '../src/components/ui'
import { useAuth } from '../src/auth/AuthProvider'
import { afterLogoutPath, meViewState, safePictureUrl } from '../src/auth/logic'
import { confirmAction } from '../src/confirm'
import { radius, spacing, useColors } from '../src/theme'

const LOGOUT_CONFIRM_TEXT = '로그아웃할까요? 이 기기의 푸시 알림 등록도 해제됩니다.'
const LOGOUT_FAILED_TEXT = '서버에서 로그아웃하지 못했습니다. 연결되면 다시 로그아웃해 주세요.'
const MCP_NOTE_TEXT = 'MCP 개인 토큰은 웹의 내 정보에서 만듭니다.'
// 이 화면의 경로 이름 - 로그아웃 중·실패 안내 동안 경로 보호가 건드리지 않게 붙들어 둔다
const SEGMENT = 'me'
const PHOTO_SIZE = 48

// 내 정보 화면 (S-15) - 계정 정보·알림 설정·로그아웃·계정 삭제. 로그아웃은 확인 창 뒤에, 서버 로그아웃을 못 끝냈으면 그 사실을 알린다
export default function MeScreen() {
  const colors = useColors()
  const router = useRouter()
  const { config, configError, status, user, signOut, holdRoute } = useAuth()
  // 로그아웃 중 - 세션이 지워져도 화면이 로그인 화면으로 먼저 튕겨 나가지 않게 한다
  const [busy, setBusy] = useState(false)
  // 서버 로그아웃을 못 끝냈을 때의 안내 화면
  const [ended, setEnded] = useState(false)
  // 진행 중인 로그아웃 하나 - 확인 창 버튼을 여러 번 눌러도 한 번만
  const busyRef = useRef(false)
  const alive = useRef(true)
  const release = useRef(null)
  // 로그아웃으로 사용자가 지워져도 화면 위 정보는 그대로 두려고 마지막으로 본 사용자를 기억한다
  const lastUser = useRef(user)
  if (user) lastUser.current = user
  const shown = user ?? lastUser.current

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      release.current?.()
      release.current = null
    }
  }, [])

  const view = meViewState({ config, configError, status, ended, hold: busy })

  // 로그인이 필요 없는 서버에서 로그인 없이 열렸으면 처음 화면으로 (로그인이 필요한 서버는 경로 보호가 맡는다)
  useEffect(() => {
    if (view.kind !== 'redirect') return
    try {
      router.replace(view.to)
    } catch {
      // 아직 화면 이동을 받을 수 없는 순간 - 다음 렌더에서 다시 정한다
    }
  }, [view.kind, view.to, router])

  const target = afterLogoutPath(config)

  // 로그아웃 - 서버에서 못 끝냈으면 이 기기는 로그아웃하되 그 사실을 알린다. 이동은 여기서 한 번만 (경로 보호는 붙들어 둔다)
  const logout = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    release.current = holdRoute(SEGMENT)
    let serverLoggedOut = false
    try {
      serverLoggedOut = (await signOut({ navigate: false }))?.serverLoggedOut === true
    } catch {
      // 순서 안의 오류는 signOut 이 삼킨다 - 여기까지 오면 서버에서 못 끝낸 것으로 본다
    }
    if (!alive.current) return
    if (!serverLoggedOut) {
      setBusy(false)
      setEnded(true)
      return
    }
    try {
      router.replace(target)
    } catch {
      // 아직 화면 이동을 받을 수 없는 순간 - 경로 보호가 처리한다
    }
  }, [holdRoute, signOut, router, target])

  // 로그아웃 버튼 - 확인 창(취소가 먼저)을 거친다
  const askLogout = () => {
    if (busyRef.current) return
    confirmAction({ title: '로그아웃', message: LOGOUT_CONFIRM_TEXT, cancelText: '취소', confirmText: '로그아웃', onConfirm: logout })
  }

  if (view.kind === 'ended') {
    return (
      <FitScreen testID="me-screen">
        <Stack.Screen options={{ title: '내 정보' }} />
        <Card style={styles.stack}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>이 기기에서 로그아웃했습니다</Text>
          <Notice tone="warn">{LOGOUT_FAILED_TEXT}</Notice>
          <Button variant="primary" label={config?.auth_required ? '로그인 화면으로' : '처음으로'} onPress={() => router.replace(target)} />
        </Card>
      </FitScreen>
    )
  }
  if (view.kind !== 'ready') {
    return (
      <FitScreen testID="me-screen">
        <Stack.Screen options={{ title: '내 정보' }} />
        <Text style={[styles.muted, { color: colors.muted }]}>불러오는 중…</Text>
      </FitScreen>
    )
  }

  const picture = safePictureUrl(shown?.picture_url)
  return (
    <FitScreen testID="me-screen">
      <Stack.Screen options={{ title: '내 정보' }} />
      <Card style={styles.who}>
        {picture && (
          <Image
            source={{ uri: picture }}
            style={[styles.photo, { backgroundColor: colors.surface2 }]}
            accessible={false}
            importantForAccessibility="no"
            accessibilityElementsHidden
          />
        )}
        <View style={styles.id}>
          {!!shown?.name && <Text style={[styles.name, { color: colors.text }]}>{shown.name}</Text>}
          {!!shown?.email && <Text style={[styles.email, { color: colors.muted }]}>{shown.email}</Text>}
        </View>
      </Card>

      <Card style={styles.stack}>
        <Button label="알림 설정" onPress={() => router.push('/notification-settings')} />
        <Text style={[styles.note, { color: colors.muted }]}>{MCP_NOTE_TEXT}</Text>
      </Card>

      <Card style={styles.stack}>
        <Button label={busy ? '로그아웃하는 중…' : '로그아웃'} disabled={busy} onPress={askLogout} />
        <Button variant="danger" label="계정 삭제" disabled={busy} onPress={() => router.push('/delete-account')} />
      </Card>
    </FitScreen>
  )
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },
  who: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  photo: { width: PHOTO_SIZE, height: PHOTO_SIZE, borderRadius: radius.pill },
  id: { flex: 1, minWidth: 0 },
  name: { fontSize: 17, lineHeight: 24, fontWeight: '700' },
  email: { fontSize: 14, lineHeight: 20 },
  title: { fontSize: 18, lineHeight: 26, fontWeight: '700' },
  note: { fontSize: 13, lineHeight: 19 },
  muted: { fontSize: 14, lineHeight: 20 },
})
