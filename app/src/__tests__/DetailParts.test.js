import { Alert, Platform, ScrollView, StyleSheet } from 'react-native'
import { render, screen, fireEvent } from '@testing-library/react-native'
import { confirmAction } from '../confirm'
import ExplainCard from '../components/ExplainCard'
import IssueHistory from '../components/IssueHistory'
import LogTerminal, { MAX_LOG_LINES, appendLogs } from '../components/LogTerminal'
import StepProgress from '../components/StepProgress'
import { darkColors, lightColors } from '../theme'

afterEach(() => {
  jest.restoreAllMocks()
  delete globalThis.confirm
})

const logs = (n, from = 1, level = 'info') => Array.from({ length: n }, (_, i) => ({ d_l_id: from + i, step: 'building', level, message: `줄 ${from + i}` }))

describe('confirmAction', () => {
  const args = (onConfirm) => ({ title: '제목', message: '본문', cancelText: '그대로 두기', confirmText: '삭제', onConfirm })

  test('앱: 취소가 먼저, 위험한 선택이 뒤이고 누른 뒤에만 onConfirm', () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    const onConfirm = jest.fn()
    confirmAction(args(onConfirm))
    const [title, message, buttons] = Alert.alert.mock.calls[0]
    expect([title, message]).toEqual(['제목', '본문'])
    expect(buttons.map((b) => [b.text, b.style])).toEqual([['그대로 두기', 'cancel'], ['삭제', 'destructive']])
    expect(onConfirm).not.toHaveBeenCalled()
    buttons[1].onPress()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  test('웹: 브라우저 confirm 을 쓰고, 확인했을 때만 onConfirm', () => {
    jest.replaceProperty(Platform, 'OS', 'web')
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    const onConfirm = jest.fn()
    globalThis.confirm = jest.fn(() => false)
    confirmAction(args(onConfirm))
    expect(Alert.alert).not.toHaveBeenCalled()
    expect(globalThis.confirm.mock.calls[0][0]).toContain('제목')
    expect(globalThis.confirm.mock.calls[0][0]).toContain('본문')
    expect(globalThis.confirm.mock.calls[0][0]).toContain('그대로 두기')
    expect(onConfirm).not.toHaveBeenCalled()

    globalThis.confirm = jest.fn(() => true)
    confirmAction(args(onConfirm))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  test('웹: confirm 이 없으면 아무것도 하지 않는다 (지우지 않는 쪽)', () => {
    jest.replaceProperty(Platform, 'OS', 'web')
    const onConfirm = jest.fn()
    confirmAction(args(onConfirm))
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('StepProgress', () => {
  const labels = () => ['클론', '판별', 'Dockerfile', '빌드', '푸시', '배포', '완료'].map((l) => screen.getByLabelText(new RegExp(`^${l} `)).props.accessibilityLabel)

  test('building: 앞 단계는 완료, 지금은 진행 중, 뒤는 대기', async () => {
    await render(<StepProgress status="building" errorStep={null} />)
    expect(labels()).toEqual(['클론 완료', '판별 완료', 'Dockerfile 완료', '빌드 진행 중', '푸시 대기', '배포 대기', '완료 대기'])
  })

  test('failed: 멈춘 단계가 실패, 앞은 완료, 막대는 빨강', async () => {
    await render(<StepProgress status="failed" errorStep="pushing" />)
    expect(labels()).toEqual(['클론 완료', '판별 완료', 'Dockerfile 완료', '빌드 완료', '푸시 실패', '배포 대기', '완료 대기'])
    expect(StyleSheet.flatten(screen.getByTestId('step-pushing').props.style).backgroundColor).toBe(lightColors.err)
  })

  test('needs_input: 푸시까지 완료, 배포가 입력 대기(노랑)', async () => {
    await render(<StepProgress status="needs_input" errorStep={null} />)
    expect(labels()).toEqual(['클론 완료', '판별 완료', 'Dockerfile 완료', '빌드 완료', '푸시 완료', '배포 입력 대기', '완료 대기'])
    expect(StyleSheet.flatten(screen.getByTestId('step-deploying').props.style).backgroundColor).toBe(lightColors.warn)
  })

  test('running: 전부 완료이고 지금 단계 이름은 따로 적지 않는다', async () => {
    await render(<StepProgress status="running" errorStep={null} />)
    expect(labels().every((l) => l.endsWith('완료') && !l.endsWith('대기'))).toBe(true)
    expect(screen.queryByText('완료')).toBeNull()
  })

  test('stopped·queued: 아무 단계도 칠하지 않는다', async () => {
    await render(<StepProgress status="stopped" errorStep={null} />)
    expect(labels().every((l) => l.endsWith('대기'))).toBe(true)
  })

  test('지금 단계 이름이 막대 아래에 나온다', async () => {
    await render(<StepProgress status="generating" errorStep={null} />)
    expect(screen.getByText('Dockerfile')).toBeTruthy()
  })
})

describe('appendLogs', () => {
  test('이미 있는 번호는 건너뛰고 새 줄만 붙인다', () => {
    const merged = appendLogs(logs(3), logs(3, 2))
    expect(merged.map((l) => l.d_l_id)).toEqual([1, 2, 3, 4])
  })

  test('새 줄이 없으면 같은 배열을 돌려준다', () => {
    const prev = logs(3)
    expect(appendLogs(prev, logs(2))).toBe(prev)
  })

  test('마지막 500줄만 남긴다', () => {
    const merged = appendLogs(logs(450), logs(100, 451))
    expect(merged).toHaveLength(MAX_LOG_LINES)
    expect(merged[0].d_l_id).toBe(51)
    expect(merged[499].d_l_id).toBe(550)
  })
})

describe('LogTerminal', () => {
  test('600줄을 받아도 500줄만 보여 준다', async () => {
    await render(<LogTerminal logs={logs(600)} />)
    expect(screen.getByLabelText('실행 로그 500줄')).toBeTruthy()
  })

  test('줄 앞에 [단계]를 붙이고 수준별 색을 쓴다', async () => {
    const lines = [
      { d_l_id: 1, step: 'cloning', level: 'cmd', message: 'git clone x' },
      { d_l_id: 2, step: 'building', level: 'warn', message: '경고 줄' },
      { d_l_id: 3, step: 'building', level: 'error', message: '에러 줄' },
      { d_l_id: 4, step: 'building', level: 'info', message: '보통 줄' },
    ]
    await render(<LogTerminal logs={lines} />)
    const colorOf = (text) => StyleSheet.flatten(screen.getByText(new RegExp(text)).props.style).color
    expect(screen.getByText(/\[cloning\]/)).toBeTruthy()
    expect(colorOf('git clone x')).toBe(darkColors.termCmd)
    expect(colorOf('경고 줄')).toBe(darkColors.termWarn)
    expect(colorOf('에러 줄')).toBe(darkColors.termErr)
    expect(colorOf('보통 줄')).toBe(darkColors.termText)
  })

  test('바닥을 보고 있을 때만 따라 내려간다', async () => {
    const scrollToEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd').mockImplementation(() => {})
    await render(<LogTerminal logs={logs(50)} />)
    const list = screen.getByTestId('log-terminal')
    const metrics = (y) => ({ nativeEvent: { contentOffset: { y }, contentSize: { height: 2000, width: 300 }, layoutMeasurement: { height: 360, width: 300 } } })

    await fireEvent(list, 'contentSizeChange', 300, 2000)
    expect(scrollToEnd).toHaveBeenCalledTimes(1)

    await fireEvent.scroll(list, metrics(100))
    await fireEvent(list, 'contentSizeChange', 300, 2100)
    expect(scrollToEnd).toHaveBeenCalledTimes(1)

    await fireEvent.scroll(list, metrics(1640))
    await fireEvent(list, 'contentSizeChange', 300, 2200)
    expect(scrollToEnd).toHaveBeenCalledTimes(2)
  })
})

describe('ExplainCard', () => {
  const explain = { summary: '요약', cause: '원인', actions: ['하나', '둘'], source: 'llm', cached: false }

  test('AI 해설 배지와 번호 붙은 선택지, 버튼 콜백', async () => {
    const onRedeploy = jest.fn()
    const onCleanup = jest.fn()
    await render(<ExplainCard explain={explain} errorStep="building" errorMsg="원문" hasResources busy={false} onRedeploy={onRedeploy} onCleanup={onCleanup} />)
    expect(screen.getByText('AI 해설')).toBeTruthy()
    expect(screen.getByText('2.')).toBeTruthy()
    await fireEvent.press(screen.getByText('다시 배포'))
    await fireEvent.press(screen.getByText('만들어진 리소스 정리'))
    expect(onRedeploy).toHaveBeenCalledTimes(1)
    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  test('busy 이면 버튼이 눌리지 않고, source 가 none 이면 배지가 없다', async () => {
    const onRedeploy = jest.fn()
    await render(<ExplainCard explain={{ ...explain, source: 'none' }} errorStep="building" errorMsg={null} hasResources busy onRedeploy={onRedeploy} onCleanup={jest.fn()} />)
    expect(screen.queryByText('AI 해설')).toBeNull()
    await fireEvent.press(screen.getByText('다시 배포'))
    expect(onRedeploy).not.toHaveBeenCalled()
  })
})

describe('IssueHistory', () => {
  test('이력이 없으면 아무것도 그리지 않는다', async () => {
    await render(<IssueHistory issues={[]} />)
    expect(screen.queryByText(/문제 이력/)).toBeNull()
  })

  test('알 수 없는 단계는 키 그대로, 해설이 없으면 원문', async () => {
    await render(<IssueHistory issues={[{ d_i_id: 1, step: 'weird', created_at: '2026-11-01T00:00:00Z', error_msg: '원문 메시지', explain: null }]} />)
    await fireEvent.press(screen.getByText(/문제 이력/))
    expect(screen.getByText('weird')).toBeTruthy()
    expect(screen.getByText('원문 메시지')).toBeTruthy()
  })
})
