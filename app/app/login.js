import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { Text } from '../src/components/Text'
import FitScreen from '../src/components/FitScreen'
import FooterSlot from '../src/components/FooterSlot'
import { Button, Card, Notice } from '../src/components/ui'
import { useAuth } from '../src/auth/AuthProvider'
import GoogleWebButton from '../src/auth/GoogleWebButton'
import { loginErrorText, loginViewState } from '../src/auth/logic'
import { spacing, useColors } from '../src/theme'

const INTRO_TEXT = 'Google 계정으로 로그인합니다. 허용된 계정만 들어올 수 있습니다.'
const OFF_NOTE_TEXT = '로그인하지 않아도 쓸 수 있습니다. 로그인하면 내 정보와 개인 토큰을 관리할 수 있습니다.'
const UNAVAILABLE_TEXT = '이 서버는 아직 로그인이 설정되지 않았습니다 (GOOGLE_CLIENT_ID_WEB·AUTH_JWT_KEY).'
const BUTTON_TEXT = 'Google 계정으로 로그인'
const BUSY_TEXT = '로그인하는 중…'

// 로그인 화면 (S-01) - 네이티브는 Google 계정 선택 창 버튼, 웹 번들은 GIS 버튼. 성공하면 경로 보호가 목록으로 보낸다
export default function LoginScreen() {
  const colors = useColors()
  const router = useRouter()
  const { config, configError, status, retryConfig, signIn } = useAuth()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  // 진행 중인 로그인 - 연타·GIS 콜백이 여러 번 와도 하나씩만
  const busyRef = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const view = loginViewState({ config, configError, status })
  const clientId = config?.google_client_id_web ?? null

  // 로그인 한 번 - 웹 번들은 GIS 가 준 id_token 을 넘긴다. 취소는 아무 안내 없이 끝, 실패는 맨 아래 자리에 문구 (토큰은 화면에 넣지 않는다)
  const start = useCallback(async (webIdToken) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setMessage(null)
    try {
      const result = await signIn(typeof webIdToken === 'string' ? webIdToken : undefined)
      if (result === 'signed_in') return
    } catch (e) {
      if (alive.current) setMessage({ tone: 'err', text: loginErrorText(e) })
    }
    busyRef.current = false
    if (alive.current) setBusy(false)
  }, [signIn])

  // GIS 버튼을 불러오지 못했을 때의 안내
  const onWebButtonError = useCallback((text) => setMessage({ tone: 'err', text }), [])

  let body
  if (view.kind === 'loading' || view.kind === 'redirect') {
    body = <Text style={[styles.muted, { color: colors.muted }]}>{view.kind === 'loading' ? '불러오는 중…' : '이동하는 중…'}</Text>
  } else if (view.kind === 'error') {
    body = (
      <>
        <Notice tone="err">서버에 연결할 수 없습니다</Notice>
        <Button label="다시 시도" onPress={retryConfig} />
      </>
    )
  } else {
    body = (
      <>
        {view.offNote && <Text style={[styles.body, { color: colors.muted }]}>{OFF_NOTE_TEXT}</Text>}
        {view.kind === 'ready' && (
          <>
            <Text style={[styles.body, { color: colors.text }]}>{INTRO_TEXT}</Text>
            {Platform.OS === 'web' && !busy
              ? <GoogleWebButton clientId={clientId} onCredential={start} onError={onWebButtonError} />
              : <Button variant="primary" label={busy ? BUSY_TEXT : BUTTON_TEXT} disabled={busy} onPress={() => { start() }} />}
          </>
        )}
        {view.kind === 'unavailable' && <Notice tone="warn">{UNAVAILABLE_TEXT}</Notice>}
        {view.offNote && <Button label="로그인하지 않고 계속" disabled={busy} onPress={() => router.replace('/')} />}
      </>
    )
  }

  return (
    <FitScreen testID="login-screen">
      <Stack.Screen options={{ title: '로그인' }} />
      <Card style={styles.card}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>AWS 자동 배포 마법사</Text>
        <View style={styles.stack}>{body}</View>
      </Card>
      <View style={styles.spacer} />
      <FooterSlot message={message} note="" />
    </FitScreen>
  )
}

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  title: { fontSize: 20, lineHeight: 28, fontWeight: '700' },
  stack: { gap: spacing.md },
  body: { fontSize: 15, lineHeight: 22 },
  muted: { fontSize: 14, lineHeight: 20 },
  spacer: { flexGrow: 1 },
})
