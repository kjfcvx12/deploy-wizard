import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useNotificationRouting } from '../src/hooks/useNotificationRouting'
import { darkColors, lightColors, useColors } from '../src/theme'

// 내비게이션 기본 테마에 우리 색 토큰을 덮어쓴다 (헤더 경계선 등이 시스템 색상 모드를 따르게)
const navTheme = (base, c) => ({
  ...base,
  colors: { ...base.colors, primary: c.accent, background: c.bg, card: c.surface, text: c.text, border: c.border },
})
const LIGHT_NAV = navTheme(DefaultTheme, lightColors)
const DARK_NAV = navTheme(DarkTheme, darkColors)

// 앱 공통 틀 - 헤더와 상태바가 시스템 색상 모드를 따른다
export default function RootLayout() {
  const colors = useColors()
  useNotificationRouting()
  return (
    <ThemeProvider value={colors === darkColors ? DARK_NAV : LIGHT_NAV}>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      />
    </ThemeProvider>
  )
}
