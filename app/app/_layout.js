import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useColors } from '../src/theme'

// 앱 공통 틀 - 헤더와 상태바가 시스템 색상 모드를 따른다
export default function RootLayout() {
  const colors = useColors()
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      />
    </>
  )
}
