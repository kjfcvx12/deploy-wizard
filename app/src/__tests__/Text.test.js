import fs from 'fs'
import path from 'path'
import { createRef } from 'react'
import { Platform, StyleSheet, Text as RNText } from 'react-native'
import { render, screen } from '@testing-library/react-native'
import DefaultText, { Text } from '../components/Text'

describe('Text 래퍼', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('children 과 testID 와 accessibilityRole 을 그대로 그린다', async () => {
    await render(<Text testID="t1" accessibilityRole="header">안녕하세요</Text>)
    expect(screen.getByText('안녕하세요')).toBeTruthy()
    expect(screen.getByTestId('t1')).toBeTruthy()
    expect(screen.getByRole('header')).toBeTruthy()
  })

  it('default export 와 named export 가 같다', () => {
    expect(DefaultText).toBe(Text)
  })

  it('iOS 에서는 lineBreakStrategyIOS 가 hangul-word 다', async () => {
    await render(<Text testID="t2">가나다</Text>)
    expect(screen.getByTestId('t2').props.lineBreakStrategyIOS).toBe('hangul-word')
  })

  it('호출자가 lineBreakStrategyIOS 를 넘기면 그것이 이긴다', async () => {
    await render(<Text testID="t3" lineBreakStrategyIOS="standard">가나다</Text>)
    expect(screen.getByTestId('t3').props.lineBreakStrategyIOS).toBe('standard')
  })

  it('iOS 에서는 웹용 줄바꿈 스타일이 없다', async () => {
    await render(<Text testID="t4" style={{ color: 'red' }}>가나다</Text>)
    const flat = StyleSheet.flatten(screen.getByTestId('t4').props.style)
    expect(flat.color).toBe('red')
    expect(flat.wordBreak).toBeUndefined()
    expect(flat.overflowWrap).toBeUndefined()
  })

  it('웹에서는 기본 스타일에 wordBreak keep-all 과 overflowWrap break-word 가 들어가고 호출자 style 이 덮어쓴다', async () => {
    jest.replaceProperty(Platform, 'OS', 'web')
    const { rerender } = await render(<Text testID="t5">가나다</Text>)
    let flat = StyleSheet.flatten(screen.getByTestId('t5').props.style)
    expect(flat.wordBreak).toBe('keep-all')
    expect(flat.overflowWrap).toBe('break-word')

    await rerender(<Text testID="t5" style={[{ fontSize: 14 }, { wordBreak: 'break-all', overflowWrap: 'anywhere' }]}>가나다</Text>)
    flat = StyleSheet.flatten(screen.getByTestId('t5').props.style)
    expect(flat.fontSize).toBe(14)
    expect(flat.wordBreak).toBe('break-all')
    expect(flat.overflowWrap).toBe('anywhere')
  })

  it('ref 가 Text 인스턴스로 전달된다', async () => {
    const ref = createRef()
    const rnRef = createRef()
    await render(<RNText ref={rnRef}>기준</RNText>)
    await render(<Text ref={ref}>가나다</Text>)
    expect(ref.current).toBeTruthy()
    expect(ref.current.constructor).toBe(rnRef.current.constructor)
  })
})

// app/app 과 app/src 의 .js 파일을 모은다 (테스트 폴더와 Text 래퍼 자신은 뺀다)
function collectSources(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      collectSources(full, out)
    } else if (entry.name.endsWith('.js')) {
      out.push(full)
    }
  }
  return out
}

describe('Text 가드', () => {
  it('화면·컴포넌트는 react-native 가 아니라 래퍼에서 Text 를 가져온다', () => {
    const root = path.resolve(__dirname, '..', '..')
    const wrapper = path.join(root, 'src', 'components', 'Text.js')
    const files = [...collectSources(path.join(root, 'app'), []), ...collectSources(path.join(root, 'src'), [])]
      .filter((f) => f !== wrapper)
    expect(files.length).toBeGreaterThan(30)
    const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]react-native['"]/g
    const offenders = []
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8')
      for (const m of src.matchAll(importRe)) {
        const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)
        if (names.includes('Text')) offenders.push(path.relative(root, file))
      }
    }
    expect(offenders).toEqual([])
  })
})
