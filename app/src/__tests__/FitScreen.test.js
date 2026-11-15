import { createRef } from 'react'
import { RefreshControl, StyleSheet, Text } from 'react-native'
import { render, screen } from '@testing-library/react-native'
import FitScreen from '../components/FitScreen'
import FooterSlot from '../components/FooterSlot'
import { spacing } from '../theme'

describe('FitScreen', () => {
  test('자식과 testID 를 그리고 contentContainerStyle 이 flexGrow 1 이다', async () => {
    await render(<FitScreen testID="fit"><Text>안쪽 글</Text></FitScreen>)
    expect(screen.getByText('안쪽 글')).toBeTruthy()
    const style = StyleSheet.flatten(screen.getByTestId('fit').props.contentContainerStyle)
    expect(style.flexGrow).toBe(1)
    expect(style.paddingBottom).toBeGreaterThanOrEqual(spacing.lg)
    expect(style.gap).toBe(spacing.md)
  })

  test('scrollRef 로 ScrollView 를 잡을 수 있다', async () => {
    const ref = createRef()
    await render(<FitScreen scrollRef={ref} testID="fit"><Text>x</Text></FitScreen>)
    expect(ref.current).not.toBeNull()
  })

  test('refreshControl 을 넘기면 그대로 전달되고 alwaysBounceVertical 이 켜진다 / 안 넘기면 꺼진다', async () => {
    const control = <RefreshControl refreshing={false} onRefresh={() => {}} />
    const view = await render(<FitScreen testID="fit" refreshControl={control}><Text>x</Text></FitScreen>)
    expect(screen.getByTestId('fit').props.alwaysBounceVertical).toBe(true)
    expect(screen.getByTestId('fit').props.refreshControl).toBeTruthy()
    await view.unmount()
    await render(<FitScreen testID="fit"><Text>x</Text></FitScreen>)
    expect(screen.getByTestId('fit').props.alwaysBounceVertical).toBe(false)
    expect(screen.getByTestId('fit').props.refreshControl).toBeFalsy()
  })
})

describe('FooterSlot', () => {
  test('message 가 없으면 note 글을 보이고, 있으면 note 대신 message(역할 alert)를 보인다', async () => {
    const view = await render(<FooterSlot note="기본 안내 글" />)
    expect(screen.getByText('기본 안내 글')).toBeTruthy()
    expect(screen.queryByText('저장했습니다')).toBeNull()
    await view.rerender(<FooterSlot note="기본 안내 글" message={{ tone: 'info', text: '저장했습니다' }} />)
    // 안내 띠는 alert 역할의 View 안에 글이 들어 있다
    expect(screen.getByText('저장했습니다').parent.props.accessibilityRole).toBe('alert')
    expect(screen.queryByText('기본 안내 글')).toBeNull()
  })

  test('오류 안내는 긴 문장도 그대로 alert 안에 들어 있다 (잘라내지 않음)', async () => {
    const long = '서버가 준 아주 긴 오류 문장입니다. '.repeat(8).trim()
    await render(<FooterSlot note="기본 안내 글" message={{ tone: 'err', text: long }} />)
    expect(screen.getByText(long).parent.props.accessibilityRole).toBe('alert')
    expect(screen.getByText(long).props.numberOfLines).toBeUndefined()
  })

  test('바깥 상자의 최소 높이는 52 로 안내가 바뀌어도 자리가 변하지 않는다', async () => {
    await render(<FooterSlot note="기본 안내 글" />)
    const note = screen.getByText('기본 안내 글')
    expect(StyleSheet.flatten(note.parent.props.style).minHeight).toBe(52)
  })
})
