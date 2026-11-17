import { useEffect, useRef } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { Text } from '../src/components/Text'
import { Button, Notice } from '../src/components/ui'
import { AuthProvider, useAuth } from '../src/auth/AuthProvider'
import { authRoute, notificationRouteAllowed } from '../src/auth/logic'
import { useNotificationRouting } from '../src/hooks/useNotificationRouting'
import { darkColors, lightColors, spacing, useColors } from '../src/theme'

// 내비게이션 기본 테마에 우리 색 토큰을 덮어쓴다 (헤더 경계선 등이 시스템 색상 모드를 따르게)
const navTheme = (base, c) => ({
  ...base,
  colors: { ...base.colors, primary: c.accent, background: c.bg, card: c.surface, text: c.text, border: c.border },
})
const LIGHT_NAV = navTheme(DefaultTheme, lightColors)
const DARK_NAV = navTheme(DarkTheme, darkColors)

// 경로 보호 + 공통 틀 - Stack 은 첫 렌더부터 늘 그린다 (expo-router 는 루트 레이아웃이 내비게이터를 그리기 전의 이동을 거절한다)
// 정해지기 전·이동 중에는 그 위를 바탕색 화면으로 덮고, 연결 오류면 다시 시도를 보인다
function RootNavigator() {
  const colors = useColors()
  const router = useRouter()
  const segments = useSegments()
  const { config, configError, status, retryConfig } = useAuth()
  const decision = authRoute({ config, configError, status, segments })
  // 알림 탭 이동은 정말 들어온 뒤에만 (로그인 필요 서버의 로그인 화면에서는 기다렸다가 로그인 뒤 한 번 이동)
  useNotificationRouting(notificationRouteAllowed({ config, configError, status, segments }))
  // 덮개 뒤 화면의 바깥 틀 (웹 번들에서 inert 를 거는 DOM 노드)
  const behindRef = useRef(null)

  // 로그인이 필요하면 로그인 화면으로, 로그인했는데 로그인 화면이면 목록으로
  useEffect(() => {
    const target = decision === 'to_login' ? '/login' : decision === 'leave_login' ? '/' : null
    if (!target) return
    try {
      router.replace(target)
    } catch {
      // 아직 화면 이동을 받을 수 없는 순간 - 다음 렌더에서 다시 정한다
    }
  }, [decision, router])

  const covered = decision !== 'allow'

  // 웹 번들: aria-hidden 은 읽기만 숨기고 Tab 초점은 막지 못해 덮인 동안 inert 를 건다 (react-native-web 0.21 은 inert 를 넘기지 않아 DOM 노드에 직접)
  useEffect(() => {
    const node = behindRef.current
    if (Platform.OS !== 'web' || !node || !('inert' in node)) return
    node.inert = covered
  }, [covered])

  return (
    <ThemeProvider value={colors === darkColors ? DARK_NAV : LIGHT_NAV}>
      <StatusBar style="auto" />
      {/* 덮인 동안 뒤 화면은 TalkBack·웹 보조기기에서 숨긴다 (보이지 않는 화면을 조작하지 않게) */}
      <View
        ref={behindRef}
        testID="auth-behind"
        style={styles.behind}
        importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
        aria-hidden={covered}
      >
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.text,
            contentStyle: { backgroundColor: colors.bg },
          }}
        />
      </View>
      {covered && (
        <View testID="auth-cover" accessibilityViewIsModal aria-modal style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: colors.bg }]}>
          {decision === 'error'
            ? (
              <View style={styles.errorBox}>
                <Notice tone="err">서버에 연결할 수 없습니다</Notice>
                <Button label="다시 시도" onPress={retryConfig} />
              </View>
            )
            : <Text style={[styles.loading, { color: colors.muted }]}>불러오는 중…</Text>}
        </View>
      )}
    </ThemeProvider>
  )
}

// 앱 공통 틀 - 로그인 상태(AuthProvider)로 감싸고, 헤더와 상태바가 시스템 색상 모드를 따른다
export default function RootLayout() {
  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  )
}

const styles = StyleSheet.create({
  behind: { flex: 1 },
  cover: { justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  errorBox: { alignSelf: 'stretch', gap: spacing.md },
  loading: { fontSize: 15, lineHeight: 22 },
})
