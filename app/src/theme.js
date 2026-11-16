import { Platform, useColorScheme } from 'react-native'

// 색 토큰 - shared/ui/styles.css 의 CSS 변수와 같은 값 (화면에는 색을 하드코딩하지 않는다)
// term* 은 어두운 터미널 바탕 위의 글자색 - 웹 .term-line 색과 같고 밝은/어두운 모드에서 같다
export const lightColors = {
  bg: '#f6f7f9',
  surface: '#ffffff',
  surface2: '#eef1f5',
  border: '#dde2ea',
  text: '#16202e',
  muted: '#64708a',
  accent: '#2563eb',
  accentText: '#ffffff',
  ok: '#15803d',
  okBg: '#e7f6ec',
  warn: '#b45309',
  warnBg: '#fdf3e1',
  err: '#b91c1c',
  errBg: '#fdecec',
  infoBg: '#e8effd',
  termBg: '#0f1722',
  termText: '#d5dde9',
  termMuted: '#8593ab',
  termCmd: '#7fb2ff',
  termWarn: '#f3c969',
  termErr: '#ff8a8a',
  scrim: 'rgba(0,0,0,0.45)',
}

export const darkColors = {
  bg: '#0d131c',
  surface: '#151d29',
  surface2: '#1c2635',
  border: '#2a3648',
  text: '#e6ebf3',
  muted: '#93a0b8',
  accent: '#5b8dff',
  accentText: '#0d131c',
  ok: '#4ade80',
  okBg: '#12301f',
  warn: '#fbbf24',
  warnBg: '#33270d',
  err: '#f87171',
  errBg: '#381616',
  infoBg: '#17243d',
  termBg: '#080c13',
  termText: '#d5dde9',
  termMuted: '#8593ab',
  termCmd: '#7fb2ff',
  termWarn: '#f3c969',
  termErr: '#ff8a8a',
  scrim: 'rgba(0,0,0,0.6)',
}

// 간격(pt)과 모서리 반지름 (웹 --radius 10px)
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }
export const radius = { sm: 6, md: 10, lg: 16, pill: 999 }

// 고정폭 글꼴
export const monoFont = 'monospace'

// 공백 없는 긴 글자(변수 이름 등)를 웹에서도 줄바꿈한다 - 안드로이드 앱은 기본으로 줄바꿈한다
export const wrapAnywhere = Platform.OS === 'web' ? { overflowWrap: 'anywhere', minWidth: 0 } : null

// 톤 이름(ok | warn | err | accent | muted)을 글자색·배경색 한 쌍으로 바꾼다 - 모르는 톤은 흐린 색
export function toneColors(colors, tone) {
  if (tone === 'ok') return { fg: colors.ok, bg: colors.okBg }
  if (tone === 'warn') return { fg: colors.warn, bg: colors.warnBg }
  if (tone === 'err') return { fg: colors.err, bg: colors.errBg }
  if (tone === 'accent') return { fg: colors.accent, bg: colors.infoBg }
  return { fg: colors.muted, bg: colors.surface2 }
}

// 시스템 색상 모드에 맞는 색 묶음을 돌려준다
export function useColors() {
  const scheme = useColorScheme()
  return scheme === 'dark' ? darkColors : lightColors
}
