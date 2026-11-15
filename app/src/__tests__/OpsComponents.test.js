import { StyleSheet } from 'react-native'
import { act, render, screen, fireEvent } from '@testing-library/react-native'
import { incidentApi } from '../api'
import HealthBar, { healthBuckets } from '../components/ops/HealthBar'
import HealthDot from '../components/ops/HealthDot'
import IncidentCard, { IncidentExplain } from '../components/ops/IncidentCard'
import IncidentTimeline from '../components/ops/IncidentTimeline'
import ProblemBanner, { problemLabel } from '../components/ops/ProblemBanner'
import { formatTime } from '../ops/format'
import { darkColors, lightColors, toneColors } from '../theme'

jest.mock('../api', () => ({ incidentApi: { getOne: jest.fn() } }))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }))

beforeEach(() => {
  incidentApi.getOne.mockReset()
  jest.spyOn(console, 'error')
  jest.spyOn(console, 'warn')
})

afterEach(() => {
  const noisy = [...console.error.mock.calls, ...console.warn.mock.calls]
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

// 기준 시각 (UTC) - 서버 시각은 Z 없는 UTC 로 온다
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)
const MIN = 60 * 1000
// NOW 보다 minutesAgo 분 전의 서버 형식 시각
const at = (minutesAgo) => new Date(NOW - minutesAgo * MIN).toISOString().replace('Z', '').replace(/\.\d+$/, '')
const check = (minutesAgo, ok) => ({ h_c_id: minutesAgo, d_id: 3, ok, checked_at: at(minutesAgo) })

describe('healthBuckets - 24시간을 15분 칸 96개로 나눈다', () => {
  test('기록이 없으면 칸 96개가 모두 none 이고 퍼센트는 null', () => {
    const result = healthBuckets([], NOW)
    expect(result.cells).toHaveLength(96)
    expect(new Set(result.cells)).toEqual(new Set(['none']))
    expect(result.percent).toBeNull()
  })

  test('모두 정상이면 100%', () => {
    const checks = [1, 2, 3, 30, 600, 1000].map((m) => check(m, true))
    const result = healthBuckets(checks, NOW)
    expect(result.percent).toBe(100)
    expect(result.cells.filter((c) => c === 'ok')).toHaveLength(4)
    expect(result.cells.filter((c) => c === 'failed')).toHaveLength(0)
  })

  test('가장 최근 칸은 마지막, 24시간 전 가까운 칸은 처음에 놓인다', () => {
    const result = healthBuckets([check(1, true), check(1435, false)], NOW)
    expect(result.cells[95]).toBe('ok')
    expect(result.cells[0]).toBe('failed')
  })

  test('섞이면 실패가 있는 칸은 failed, 퍼센트는 점검 횟수 기준', () => {
    // 같은 15분 칸 안의 정상 2번 + 실패 1번 -> 칸은 failed, 전체 4번 중 3번 정상 = 75%
    const checks = [check(5, true), check(6, true), check(7, false), check(100, true)]
    const result = healthBuckets(checks, NOW)
    expect(result.cells.filter((c) => c === 'failed')).toHaveLength(1)
    expect(result.cells.filter((c) => c === 'ok')).toHaveLength(1)
    expect(result.percent).toBe(75)
  })

  test('중간에 기록이 없는 칸(공백)은 none 으로 남는다', () => {
    const result = healthBuckets([check(1, true), check(300, true)], NOW)
    expect(result.cells.filter((c) => c === 'none')).toHaveLength(94)
  })

  test('실패가 하나라도 있으면 100% 로 올림하지 않고, 정상이 하나라도 있으면 0% 로 내리지 않는다', () => {
    const many = Array.from({ length: 300 }, (_, i) => check(1 + (i % 100), true))
    expect(healthBuckets([...many, check(2, false)], NOW).percent).toBe(99)
    const fails = Array.from({ length: 300 }, (_, i) => check(1 + (i % 100), false))
    expect(healthBuckets([...fails, check(2, true)], NOW).percent).toBe(1)
    expect(healthBuckets(fails, NOW).percent).toBe(0)
  })

  test('24시간 밖과 읽을 수 없는 시각은 센다 하지 않는다', () => {
    const result = healthBuckets([check(1500, false), { ok: false, checked_at: 'x' }, { ok: true }, null, check(2, true)], NOW)
    expect(result.percent).toBe(100)
    expect(result.cells.filter((c) => c !== 'none')).toHaveLength(1)
  })

  test('기기 시계가 서버보다 늦어 지금보다 미래인 기록도 마지막 칸에 센다', () => {
    const result = healthBuckets([{ ok: true, checked_at: at(-3) }], NOW)
    expect(result.cells[95]).toBe('ok')
    expect(result.percent).toBe(100)
  })

  test('hours 로 기간을 바꾸면 칸 수가 15분 단위로 바뀐다 (최대 96)', () => {
    expect(healthBuckets([], NOW, 6).cells).toHaveLength(24)
    expect(healthBuckets([], NOW, 48).cells).toHaveLength(96)
  })
})

describe('HealthBar', () => {
  test('한 개의 요약 라벨을 달고, 칸 96개는 접근성 트리에서 숨긴다', async () => {
    const checks = [check(5, true), check(6, true), check(7, false), check(100, true)]
    await render(<HealthBar checks={checks} now={NOW} />)
    expect(screen.getByLabelText('최근 24시간 정상 75%')).toBeTruthy()
    const cells = screen.getAllByTestId('health-cell', { includeHiddenElements: true })
    expect(cells).toHaveLength(96)
    cells.forEach((cell) => {
      expect(cell.props['aria-hidden']).toBe(true)
      expect(cell.props.accessibilityElementsHidden).toBe(true)
      expect(cell.props.importantForAccessibility).toBe('no-hide-descendants')
    })
    expect(screen.queryAllByTestId('health-cell')).toHaveLength(0)
  })

  test('칸 색: 정상 ok, 실패 err, 기록 없음은 회색 border (색 토큰만)', async () => {
    await render(<HealthBar checks={[check(1, true), check(20, false)]} now={NOW} />)
    const cells = screen.getAllByTestId('health-cell', { includeHiddenElements: true })
    const color = (i) => StyleSheet.flatten(cells[i].props.style).backgroundColor
    expect(color(95)).toBe(lightColors.ok)
    expect(color(94)).toBe(lightColors.err)
    expect(color(0)).toBe(lightColors.border)
  })

  test('기록이 없으면 안내 글, 이력을 못 받았으면(null) 실패 안내', async () => {
    const { rerender } = await render(<HealthBar checks={[]} now={NOW} />)
    expect(screen.getByLabelText('최근 24시간 확인 기록 없음')).toBeTruthy()
    await rerender(<HealthBar checks={null} now={NOW} />)
    expect(screen.getByText('헬스 이력을 불러오지 못했습니다')).toBeTruthy()
    expect(screen.queryAllByTestId('health-cell', { includeHiddenElements: true })).toHaveLength(0)
  })
})

describe('IncidentTimeline', () => {
  const incident = {
    i_id: 7, d_id: 3, status: 'resolved', summary: '앱이 오류로 응답하고 있습니다.', explain: null,
    detected_at: '2026-11-09T03:12:30', resolved_at: '2026-11-09T03:20:00', updated_at: '2026-11-09T03:20:00',
    actions: [
      { r_a_id: 12, action: 'rollback', result: 'ok', detail: '이전 이미지로 되돌렸습니다', started_at: '2026-11-09T03:16:00', finished_at: '2026-11-09T03:19:00' },
      { r_a_id: 11, action: 'restart', result: 'failed', detail: '여전히 응답이 없습니다', started_at: '2026-11-09T03:13:00', finished_at: '2026-11-09T03:15:00' },
    ],
  }

  test('감지 -> 재시작 -> 결과 -> 되돌리기 -> 결과 -> 해결 순서, 시각은 formatTime', async () => {
    await render(<IncidentTimeline incident={incident} />)
    expect(screen.getByText('마법사가 한 일')).toBeTruthy()
    const items = screen.getAllByTestId('timeline-item')
    const texts = ['문제를 감지했습니다', '재시작 시도', '재시작 실패', '이전 버전으로 되돌리기 시도', '이전 버전으로 되돌리기 성공', '정상으로 돌아왔습니다']
    expect(items).toHaveLength(texts.length)
    texts.forEach((text, i) => {
      expect(screen.getAllByTestId('timeline-title')[i].props.children).toBe(text)
    })
    expect(screen.getByText('여전히 응답이 없습니다')).toBeTruthy()
    expect(screen.getByText(formatTime('2026-11-09T03:12:30'))).toBeTruthy()
    expect(screen.getByText(formatTime('2026-11-09T03:20:00'))).toBeTruthy()
  })

  test('조치가 없으면 감지 한 줄만, 읽기 전용이라 누를 수 있는 것이 없다', async () => {
    await render(<IncidentTimeline incident={{ ...incident, status: 'open', resolved_at: null, actions: [] }} />)
    expect(screen.getAllByTestId('timeline-item')).toHaveLength(1)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  test('조치 목록이 없어도(undefined) 죽지 않는다', async () => {
    const { actions, ...rest } = incident
    await render(<IncidentTimeline incident={{ ...rest, status: 'open', resolved_at: null }} />)
    expect(screen.getAllByTestId('timeline-item')).toHaveLength(1)
  })

  test('긴 사유도 그린다', async () => {
    const detail = 'x'.repeat(600)
    await render(<IncidentTimeline incident={{ ...incident, actions: [{ ...incident.actions[1], detail }] }} />)
    expect(screen.getByText(detail)).toBeTruthy()
  })
})

describe('ProblemBanner', () => {
  const deploy = { d_id: 7, repo_url: 'https://github.com/acme/api', open_incident_id: 12, auto_recover: true }

  test('자동 복구가 켜져 있으면 자동 복구 중, 꺼져 있으면 확인이 필요합니다', async () => {
    const { rerender } = await render(<ProblemBanner deploy={deploy} onPress={() => {}} />)
    expect(screen.getByText('acme/api에 문제가 있습니다 · 자동 복구 중')).toBeTruthy()
    await rerender(<ProblemBanner deploy={{ ...deploy, auto_recover: false }} onPress={() => {}} />)
    expect(screen.getByText('acme/api에 문제가 있습니다 · 확인이 필요합니다')).toBeTruthy()
  })

  test('확인 필요(needs_action) 인시던트는 자동 복구가 켜져 있어도 확인이 필요합니다', async () => {
    await render(<ProblemBanner deploy={{ ...deploy, open_incident_status: 'needs_action' }} onPress={() => {}} />)
    expect(screen.getByText('acme/api에 문제가 있습니다 · 확인이 필요합니다')).toBeTruthy()
  })

  test.each([
    [{ open_incident_status: 'open', auto_recover: true }, '자동 복구 중'],
    [{ open_incident_status: 'recovering', auto_recover: true }, '자동 복구 중'],
    [{ open_incident_status: 'open', auto_recover: false }, '확인이 필요합니다'],
    [{ open_incident_status: 'needs_action', auto_recover: false }, '확인이 필요합니다'],
    [{ open_incident_status: undefined, auto_recover: true }, '자동 복구 중'],
    [{ open_incident_status: null, auto_recover: false }, '확인이 필요합니다'],
    [{ open_incident_status: 'weird', auto_recover: true }, '자동 복구 중'],
    [{ auto_recover: undefined }, '자동 복구 중'],
  ])('problemLabel %j -> %s', (over, expected) => {
    expect(problemLabel({ ...deploy, ...over })).toBe(expected)
  })

  test('같은 레포의 배포 둘을 접근성 라벨과 힌트로 구분할 수 있다', async () => {
    await render(<>
      <ProblemBanner deploy={{ ...deploy, d_id: 7 }} onPress={() => {}} />
      <ProblemBanner deploy={{ ...deploy, d_id: 8, open_incident_id: 13 }} onPress={() => {}} />
    </>)
    const seven = screen.getByRole('button', { name: /배포 #7\)/ })
    const eight = screen.getByRole('button', { name: /배포 #8\)/ })
    expect(seven.props.accessibilityHint).toContain('#7')
    expect(eight.props.accessibilityHint).toContain('#8')
    expect(seven.props.accessibilityLabel).toBe('acme/api에 문제가 있습니다 · 자동 복구 중 (배포 #7)')
  })

  test('누르면 onPress, 버튼 역할과 배포 이름이 든 라벨, 높이 44 이상', async () => {
    const onPress = jest.fn()
    await render(<ProblemBanner deploy={deploy} onPress={onPress} />)
    const button = screen.getByRole('button', { name: /acme\/api에 문제가 있습니다/ })
    expect(StyleSheet.flatten(button.props.style).minHeight).toBeGreaterThanOrEqual(44)
    await fireEvent.press(button)
    expect(onPress).toHaveBeenCalledTimes(1)
  })
})

describe('HealthDot', () => {
  test('상태별 라벨과 색', async () => {
    const { rerender } = await render(<HealthDot state="healthy" />)
    expect(screen.getByLabelText('헬스체크: 응답 정상')).toBeTruthy()
    expect(StyleSheet.flatten(screen.getByTestId('health-dot').props.style).backgroundColor).toBe(lightColors.ok)
    await rerender(<HealthDot state="unhealthy" />)
    expect(screen.getByLabelText('헬스체크: 응답 없음')).toBeTruthy()
    expect(StyleSheet.flatten(screen.getByTestId('health-dot').props.style).backgroundColor).toBe(lightColors.err)
    await rerender(<HealthDot state="unknown" />)
    expect(screen.getByLabelText('헬스체크: 확인 전')).toBeTruthy()
    expect(StyleSheet.flatten(screen.getByTestId('health-dot').props.style).backgroundColor).toBe(lightColors.muted)
  })

  test('withLabel 이면 글자도 보이고, 모르는 값이나 값이 없으면 아무것도 그리지 않는다', async () => {
    const { rerender } = await render(<HealthDot state="healthy" withLabel />)
    expect(screen.getByText('응답 정상')).toBeTruthy()
    await rerender(<HealthDot state={undefined} />)
    expect(screen.queryByTestId('health-dot')).toBeNull()
    await rerender(<HealthDot state="weird" />)
    expect(screen.queryByTestId('health-dot')).toBeNull()
  })
})

describe('IncidentCard', () => {
  test('요약을 받아 보여 주고, 누르면 onPress', async () => {
    incidentApi.getOne.mockResolvedValue({ i_id: 12, status: 'recovering', summary: '앱이 오류로 응답하고 있습니다.' })
    const onPress = jest.fn()
    await render(<IncidentCard d_id={7} i_id={12} onPress={onPress} />)
    expect(await screen.findByText('앱이 오류로 응답하고 있습니다.')).toBeTruthy()
    expect(screen.getByText('복구 중')).toBeTruthy()
    expect(incidentApi.getOne).toHaveBeenCalledWith(12)
    await fireEvent.press(screen.getByRole('button', { name: /배포 #7/ }))
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  test('label 을 주면 제목에 상태 글이 붙는다', async () => {
    incidentApi.getOne.mockResolvedValue({ i_id: 12, status: 'needs_action', summary: '요약' })
    await render(<IncidentCard d_id={7} i_id={12} label="확인이 필요합니다" onPress={() => {}} />)
    expect(await screen.findByText('문제가 있습니다 · 확인이 필요합니다')).toBeTruthy()
  })

  test('요약을 못 받아도 카드는 그려지고 누를 수 있다', async () => {
    incidentApi.getOne.mockRejectedValue(new Error('서버에 연결할 수 없습니다'))
    const onPress = jest.fn()
    await render(<IncidentCard d_id={7} i_id={12} onPress={onPress} />)
    expect(await screen.findByText('처리 중인 문제가 있습니다')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: /배포 #7/ }))
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  test('요약이 비어 있어도 안내 글', async () => {
    incidentApi.getOne.mockResolvedValue({ i_id: 12, status: 'open', summary: null, explain: null })
    await render(<IncidentCard d_id={7} i_id={12} onPress={() => {}} />)
    expect(await screen.findByText('감지됨')).toBeTruthy()
    expect(screen.getByText('처리 중인 문제가 있습니다')).toBeTruthy()
  })

  test('언마운트 뒤에 늦게 온 응답으로 상태를 바꾸지 않는다', async () => {
    let finish
    incidentApi.getOne.mockImplementation(() => new Promise((r) => { finish = r }))
    const { unmount } = await render(<IncidentCard d_id={7} i_id={12} onPress={() => {}} />)
    await unmount()
    await act(async () => { finish({ i_id: 12, status: 'open', summary: 'x' }) })
    // 경고가 없어야 한다 (afterEach 가 console.error/warn 을 확인)
  })
})

describe('IncidentExplain', () => {
  const explain = { cause: '원인 글', fix_where: 'arn:aws:ecs:ap-northeast-2:123456789012:service/x', actions: ['첫째 할 일', '둘째 할 일'] }

  test('flat 은 Card 없이도 원인·고칠 곳·해야 할 일 글과 복사 버튼을 모두 그린다', async () => {
    const onError = jest.fn()
    await render(<IncidentExplain flat explain={explain} onError={onError} />)
    expect(screen.getAllByRole('header').map((h) => h.props.children)).toEqual(['원인', '고칠 곳', '해야 할 일'])
    expect(screen.getByText('원인 글')).toBeTruthy()
    expect(screen.getByText(explain.fix_where).props.selectable).toBe(true)
    expect(screen.getByText('첫째 할 일')).toBeTruthy()
    expect(screen.getByText('2.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: '고칠 곳 복사' }))
    expect(onError).not.toHaveBeenCalled()
    // Card 의 테두리(borderWidth)를 가진 View 가 없다 - 구역 사이 줄만 있다
    expect(screen.getByTestId('explain-flat')).toBeTruthy()
    expect(screen.getAllByTestId('explain-divider')).toHaveLength(2)
  })

  test('flat 이어도 고칠 곳과 해야 할 일이 없으면 그 구역과 줄은 없다', async () => {
    await render(<IncidentExplain flat explain={{ cause: '원인만' }} onError={() => {}} />)
    expect(screen.getAllByRole('header').map((h) => h.props.children)).toEqual(['원인'])
    expect(screen.queryAllByTestId('explain-divider')).toHaveLength(0)
  })

  test('flat 이 없으면 전과 같다 - 구역마다 카드 한 장, 줄 없음', async () => {
    await render(<IncidentExplain explain={explain} onError={() => {}} />)
    expect(screen.getAllByRole('header').map((h) => h.props.children)).toEqual(['원인', '고칠 곳', '해야 할 일'])
    expect(screen.queryByTestId('explain-flat')).toBeNull()
    expect(screen.queryAllByTestId('explain-divider')).toHaveLength(0)
  })
})

describe('toneColors', () => {
  test('톤마다 글자색과 배경색 토큰을 돌려준다 (밝은/어두운 모드 모두)', () => {
    ;[lightColors, darkColors].forEach((c) => {
      expect(toneColors(c, 'ok')).toEqual({ fg: c.ok, bg: c.okBg })
      expect(toneColors(c, 'warn')).toEqual({ fg: c.warn, bg: c.warnBg })
      expect(toneColors(c, 'err')).toEqual({ fg: c.err, bg: c.errBg })
      expect(toneColors(c, 'accent')).toEqual({ fg: c.accent, bg: c.infoBg })
      expect(toneColors(c, 'muted')).toEqual({ fg: c.muted, bg: c.surface2 })
      expect(toneColors(c, 'weird')).toEqual({ fg: c.muted, bg: c.surface2 })
    })
  })
})
