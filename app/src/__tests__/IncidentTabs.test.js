import { StyleSheet } from 'react-native'
import { fireEvent, render, screen } from '@testing-library/react-native'
import IncidentFacts from '../components/ops/IncidentFacts'
import IncidentTabs from '../components/ops/IncidentTabs'
import { formatClock, formatDate } from '../ops/format'

beforeEach(() => {
  jest.spyOn(console, 'error')
  jest.spyOn(console, 'warn')
})

afterEach(() => {
  const noisy = [...console.error.mock.calls, ...console.warn.mock.calls]
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

const TABS = [{ key: 'problem', label: '문제' }, { key: 'cause', label: '원인' }]

describe('IncidentTabs', () => {
  test('tab 역할 두 개와 tablist 가 그려지고 선택된 탭만 selected 다', async () => {
    await render(<IncidentTabs tabs={TABS} value="cause" onChange={() => {}} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0].parent.props.accessibilityRole).toBe('tablist')
    expect(tabs).toHaveLength(2)
    expect(tabs[0].props.accessibilityState.selected).toBe(false)
    expect(tabs[1].props.accessibilityState.selected).toBe(true)
    expect(screen.getByText('문제')).toBeTruthy()
    expect(screen.getByText('원인')).toBeTruthy()
  })

  test('탭을 누르면 onChange(key)', async () => {
    const onChange = jest.fn()
    await render(<IncidentTabs tabs={TABS} value="problem" onChange={onChange} />)
    await fireEvent.press(screen.getAllByRole('tab')[1])
    expect(onChange).toHaveBeenCalledWith('cause')
  })

  test('탭 높이가 44 이상이다', async () => {
    await render(<IncidentTabs tabs={TABS} value="problem" onChange={() => {}} />)
    screen.getAllByRole('tab').forEach((tab) => {
      const style = StyleSheet.flatten(typeof tab.props.style === 'function' ? tab.props.style({ pressed: false }) : tab.props.style)
      expect(style.minHeight).toBeGreaterThanOrEqual(44)
    })
  })
})

describe('IncidentFacts', () => {
  const incident = {
    i_id: 9, d_id: 5, kind: 'unhealthy', status: 'needs_action',
    detected_at: '2026-11-09T03:12:30', resolved_at: null,
  }
  const facts = () => screen.getAllByTestId('incident-fact')

  test('배포 #5 · 문제 확인 필요 · 날짜 · 시간 · 원인 응답 이상 순서의 줄이 한 줄씩 나온다', async () => {
    await render(<IncidentFacts incident={incident} />)
    const rows = facts()
    expect(rows).toHaveLength(5)
    const names = ['배포', '문제', '날짜', '시간', '원인']
    const values = ['#5', '확인 필요', formatDate(incident.detected_at), formatClock(incident.detected_at), '응답 이상']
    rows.forEach((row, index) => {
      expect(row).toHaveTextContent(`${names[index]}${values[index]}`)
    })
  })

  test('resolved 이고 resolved_at 이 있으면 해결 줄이 더해지고 아니면 없다', async () => {
    const resolved = { ...incident, status: 'resolved', resolved_at: '2026-11-09T03:15:50' }
    const { unmount } = await render(<IncidentFacts incident={resolved} />)
    const rows = facts()
    expect(rows).toHaveLength(6)
    expect(rows[5]).toHaveTextContent(`해결${formatDate(resolved.resolved_at)} ${formatClock(resolved.resolved_at)} (3분 20초)`)
    await unmount()

    await render(<IncidentFacts incident={{ ...resolved, resolved_at: null }} />)
    expect(facts()).toHaveLength(5)
    await screen.unmount()

    await render(<IncidentFacts incident={{ ...incident, resolved_at: '2026-11-09T03:15:50' }} />)
    expect(facts()).toHaveLength(5)
  })

  test('모르는 kind 는 서버 값 그대로', async () => {
    await render(<IncidentFacts incident={{ ...incident, kind: 'brand_new_kind' }} />)
    expect(facts()[4]).toHaveTextContent('원인brand_new_kind')
  })

  test.each(['constructor', '__proto__'])('kind %s 는 상속 속성이 아니라 받은 글 그대로', async (kind) => {
    await render(<IncidentFacts incident={{ ...incident, kind }} />)
    expect(facts()[4]).toHaveTextContent(`원인${kind}`)
  })

  test('detected_at 이 읽을 수 없으면 날짜·시간 값이 확인 불가', async () => {
    await render(<IncidentFacts incident={{ ...incident, detected_at: 'garbage' }} />)
    const rows = facts()
    expect(rows[2]).toHaveTextContent('날짜확인 불가')
    expect(rows[3]).toHaveTextContent('시간확인 불가')
  })

  test('긴 값도 글이 그대로 들어 있다 (잘라내지 않는다)', async () => {
    const kind = 'k'.repeat(120)
    await render(<IncidentFacts incident={{ ...incident, kind }} />)
    expect(screen.getByText(kind)).toBeTruthy()
    const props = screen.getByText(kind).props
    expect(props.numberOfLines).toBeUndefined()
    expect(props.ellipsizeMode).toBeUndefined()
  })
})
