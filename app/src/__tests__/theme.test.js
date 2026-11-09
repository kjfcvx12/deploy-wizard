import { lightColors, darkColors, spacing, radius } from '../theme'

const TOKENS = ['bg', 'surface', 'surface2', 'border', 'text', 'muted', 'accent', 'accentText',
  'ok', 'okBg', 'warn', 'warnBg', 'err', 'errBg', 'infoBg', 'termBg', 'termText', 'termMuted', 'termCmd', 'termWarn', 'termErr']

describe('theme', () => {
  test('밝은 색과 어두운 색이 같은 토큰 이름을 가진다', () => {
    expect(Object.keys(lightColors).sort()).toEqual([...TOKENS].sort())
    expect(Object.keys(darkColors).sort()).toEqual([...TOKENS].sort())
  })

  test('웹 토큰과 같은 대표 값', () => {
    expect(lightColors.accent).toBe('#2563eb')
    expect(darkColors.bg).toBe('#0d131c')
    expect(radius.md).toBe(10)
    expect(spacing.lg).toBe(16)
  })
})
