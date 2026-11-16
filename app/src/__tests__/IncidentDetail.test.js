import { Alert, AppState, StyleSheet } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { render, screen, fireEvent, act, within } from '@testing-library/react-native'
import { deployApi, healthApi, incidentApi } from '../api'
import IncidentDetail from '../../app/incidents/[i_id]'
import { formatClock, formatDate, formatTime } from '../ops/format'
import { monoFont, spacing } from '../theme'

const mockPush = jest.fn()
const mockBack = jest.fn()
const mockReplace = jest.fn()
let mockCanGoBack = true
// 화면 포커스 흉내 - 처음 연 것과 다시 포커스를 받은 것을 구분한다
const mockFocus = { effect: null, regain: () => mockFocus.effect() }
jest.mock('expo-router', () => {
  const React = require('react')
  return {
    useRouter: () => ({ push: mockPush, back: mockBack, replace: mockReplace, canGoBack: () => mockCanGoBack }),
    useLocalSearchParams: () => ({ i_id: '7' }),
    Stack: { Screen: () => null },
    useFocusEffect: (effect) => {
      mockFocus.effect = effect
      React.useEffect(() => effect(), [effect])
    },
  }
})
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }))
jest.mock('../api', () => ({
  incidentApi: { getOne: jest.fn() },
  healthApi: { getHistory: jest.fn() },
  deployApi: { redeploy: jest.fn(), stop: jest.fn() },
}))

const FIX = 'AWS 콘솔 ECS 서비스의 로그 탭(CloudWatch Logs)에서 오류 메시지를 확인하고, 해당 코드가 있는 레포 파일을 고칩니다.'
const base = {
  i_id: 7, d_id: 3, kind: 'unhealthy', status: 'recovering',
  summary: '앱이 오류로 응답하고 있습니다.',
  explain: {
    summary: '앱이 오류로 응답하고 있습니다.', cause: '앱이 떠 있지만 헬스체크에 5xx 로 답하고 있습니다.',
    fix_where: FIX, actions: ['로그에서 마지막 오류 줄을 확인합니다.', '환경변수를 점검합니다.'], source: 'rule',
  },
  detected_at: '2026-11-09T03:12:30', resolved_at: null, created_at: '2026-11-09T03:12:30', updated_at: '2026-11-09T03:13:00',
  actions: [{ r_a_id: 11, i_id: 7, action: 'restart', result: 'running', detail: null, started_at: '2026-11-09T03:13:00', finished_at: null }],
}
const needsAction = {
  ...base, status: 'needs_action',
  actions: [{ ...base.actions[0], result: 'failed', detail: '재시작했지만 응답이 없습니다', finished_at: '2026-11-09T03:15:00' }],
}
const notFound = Object.assign(new Error('해당 id의 인시던트가 없습니다'), { status: 404 })
const NOT_FOUND_TEXT = '문제를 찾을 수 없습니다. 이미 삭제된 배포이거나 지워진 기록일 수 있습니다.'
const resolved = { ...base, status: 'resolved', resolved_at: '2026-11-09T03:20:00', updated_at: '2026-11-09T03:20:00' }

let current
beforeEach(() => {
  jest.useFakeTimers()
  for (const fn of [mockPush, mockBack, mockReplace]) fn.mockReset()
  mockCanGoBack = true
  mockFocus.effect = null
  current = base
  incidentApi.getOne.mockReset().mockImplementation(async () => ({ ...current }))
  healthApi.getHistory.mockReset().mockResolvedValue([])
  deployApi.redeploy.mockReset().mockResolvedValue({})
  deployApi.stop.mockReset().mockResolvedValue({})
  Clipboard.setStringAsync.mockReset().mockResolvedValue(true)
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() }))
  jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  jest.spyOn(console, 'error')
  jest.spyOn(console, 'warn')
})

afterEach(() => {
  const noisy = [...console.error.mock.calls, ...console.warn.mock.calls]
  jest.useRealTimers()
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

const RECOVERING_TEXT = '마법사가 복구를 시도하고 있습니다. 이 화면은 5초마다 새로 고쳐집니다.'

// 처음 탭은 "문제" 라서 요약 글 대신 사실 줄(incident-fact)이 그려지기를 기다린다
const open = async (incident = base) => {
  current = incident
  const view = await render(<IncidentDetail />)
  await screen.findAllByTestId('incident-fact')
  return view
}
const tick = async (ms) => { await act(async () => { jest.advanceTimersByTime(ms) }) }
// 탭을 누른다 ('문제' 또는 '원인')
const pickTab = async (name) => { await fireEvent.press(screen.getByRole('tab', { name })) }
const body = () => within(screen.getByTestId('incident-body'))
const labeledButtons = () => screen.getAllByRole('button').filter((b) => /^배포 #3 /.test(b.props.accessibilityLabel)).map((b) => b.props.accessibilityLabel)
const alertButton = (name) => Alert.alert.mock.calls[0][2].find((b) => b.text === name)

describe('인시던트 상세 - 내용', () => {
  test('복구 중: 배지, 요약, 원인, 고칠 곳, 번호 조치, 타임라인, 헬스 막대, 배포 보기', async () => {
    healthApi.getHistory.mockResolvedValue([{ h_c_id: 1, ok: true, checked_at: new Date(Date.now() - 60000).toISOString().replace('Z', '') }])
    await open()
    expect(screen.getByText('복구 중')).toBeTruthy()
    expect(screen.getByText('마법사가 한 일')).toBeTruthy()
    expect(screen.getAllByTestId('timeline-title').map((t) => t.props.children)).toEqual(['문제를 감지했습니다', '재시작 시도'])
    expect(await screen.findByLabelText('최근 24시간 정상 100%')).toBeTruthy()
    await pickTab('원인')
    expect(screen.getByRole('header', { name: '앱이 오류로 응답하고 있습니다.' })).toBeTruthy()
    expect(screen.getByRole('header', { name: '원인' })).toBeTruthy()
    expect(screen.getByText('앱이 떠 있지만 헬스체크에 5xx 로 답하고 있습니다.')).toBeTruthy()
    expect(screen.getByText('고칠 곳')).toBeTruthy()
    expect(screen.getByText(FIX)).toBeTruthy()
    expect(screen.getByText('로그에서 마지막 오류 줄을 확인합니다.')).toBeTruthy()
    expect(screen.getByText('2.')).toBeTruthy()
    expect(screen.getByLabelText('최근 24시간 정상 100%')).toBeTruthy()
    expect(healthApi.getHistory).toHaveBeenCalledWith(3, 24)
    expect(incidentApi.getOne).toHaveBeenCalledWith('7')
    expect(screen.getByRole('button', { name: '배포 #3 보기' })).toBeTruthy()
    expect(screen.queryByText('다시 배포')).toBeNull()
  })

  test('감지 시각은 날짜·시간 줄로, 해결 시각은 해결 줄로 보여 주고 타임라인은 formatTime (서버 시각은 Z 없는 UTC)', async () => {
    await open(resolved)
    const rows = screen.getAllByTestId('incident-fact')
    expect(within(rows[2]).getByText(formatDate('2026-11-09T03:12:30'))).toBeTruthy()
    expect(within(rows[3]).getByText(formatClock('2026-11-09T03:12:30'))).toBeTruthy()
    expect(within(rows[5]).getByText('해결')).toBeTruthy()
    expect(within(rows[5]).getByText(`${formatDate('2026-11-09T03:20:00')} ${formatClock('2026-11-09T03:20:00')} (7분 30초)`)).toBeTruthy()
    expect(screen.getAllByText(formatTime('2026-11-09T03:12:30'), { exact: false }).length).toBeGreaterThan(0)
    expect(screen.getAllByText(formatTime('2026-11-09T03:20:00'), { exact: false }).length).toBeGreaterThan(0)
    expect(screen.getByText('해결됨')).toBeTruthy()
    expect(screen.getByText('정상으로 돌아왔습니다')).toBeTruthy()
    // 해결되면 복구 안내 글은 없다
    expect(screen.queryByText(RECOVERING_TEXT)).toBeNull()
  })

  test('explain 이 null 이어도 원인 탭이 아직 원인을 확인하지 못했습니다 문구로 그려진다 (고칠 곳과 조치 구역은 없다)', async () => {
    await open({ ...base, explain: null })
    expect(screen.getByText('마법사가 한 일')).toBeTruthy()
    await pickTab('원인')
    expect(screen.getByRole('header', { name: '앱이 오류로 응답하고 있습니다.' })).toBeTruthy()
    expect(screen.getByText('아직 원인을 확인하지 못했습니다')).toBeTruthy()
    expect(screen.queryByText('고칠 곳')).toBeNull()
    expect(screen.queryByText('해야 할 일')).toBeNull()
  })

  test('explain 이 일부만 있어도(원인만, 조치 빈 배열, 고칠 곳 null) 그린다', async () => {
    await open({ ...base, explain: { cause: '원인만 있습니다', fix_where: null, actions: [] } })
    await pickTab('원인')
    expect(screen.getByText('원인만 있습니다')).toBeTruthy()
    expect(screen.queryByText('고칠 곳')).toBeNull()
    expect(screen.queryByText('해야 할 일')).toBeNull()
  })

  test('explain 이 비어 있고 요약도 없으면 기본 요약 글', async () => {
    await open({ ...base, summary: '', explain: {} })
    await pickTab('원인')
    expect(screen.getByRole('header', { name: '문제가 감지되었습니다' })).toBeTruthy()
    expect(screen.getByText('아직 원인을 확인하지 못했습니다')).toBeTruthy()
  })

  test('actions 가 없어도(undefined) 죽지 않는다', async () => {
    const { actions, ...rest } = base
    await open(rest)
    expect(screen.getAllByTestId('timeline-item')).toHaveLength(1)
  })

  test('헬스 이력을 못 받아도 인시던트는 보이고 막대 자리에는 못 불러왔다는 글이 나온다 (기록 없음이 아니다)', async () => {
    healthApi.getHistory.mockRejectedValue(new Error('x'))
    await open()
    await act(async () => {})
    expect(healthApi.getHistory).toHaveBeenCalledTimes(1)
    expect(screen.getByText('헬스 이력을 불러오지 못했습니다')).toBeTruthy()
    expect(screen.queryByLabelText('최근 24시간 확인 기록 없음')).toBeNull()
    expect(screen.queryByText('x')).toBeNull()
    expect(screen.getAllByTestId('incident-fact')).toHaveLength(5)
  })

  test('헬스 이력을 받는 동안에는 막대도 실패 글도 그리지 않는다', async () => {
    healthApi.getHistory.mockReturnValue(new Promise(() => {}))
    await open()
    expect(screen.queryByText('헬스체크 이력')).toBeNull()
    expect(screen.queryByText('헬스 이력을 불러오지 못했습니다')).toBeNull()
    expect(screen.queryByLabelText('최근 24시간 확인 기록 없음')).toBeNull()
  })

  test('이력이 비어 있으면(받았지만 기록 없음) 확인 기록 없음', async () => {
    healthApi.getHistory.mockResolvedValue([])
    await open()
    await act(async () => {})
    expect(screen.getByLabelText('최근 24시간 확인 기록 없음')).toBeTruthy()
    expect(screen.queryByText('헬스 이력을 불러오지 못했습니다')).toBeNull()
  })
})

describe('인시던트 상세 - 한 화면 배치 (위 고정 · 가운데 상자 · 아래 고정)', () => {
  test('가운데 상자(incident-body) 안에 문제 탭은 줄·타임라인, 원인 탭은 원인·고칠 곳·해야 할 일이 있고 탭 줄·헬스 막대·버튼은 상자 밖에 있다', async () => {
    await open()
    await act(async () => {})
    for (const tab of ['문제', '원인']) {
      await pickTab(tab)
      const scroll = screen.getByTestId('incident-body')
      expect(scroll.props.nestedScrollEnabled).toBe(true)
      expect(body().queryByRole('tab')).toBeNull()
      expect(body().queryByLabelText(/최근 24시간/)).toBeNull()
      expect(body().queryByRole('button', { name: '배포 #3 보기' })).toBeNull()
      expect(within(screen.getByTestId('incident-top')).getAllByRole('tab')).toHaveLength(2)
      expect(screen.getByLabelText(/최근 24시간/)).toBeTruthy()
      expect(screen.getByRole('button', { name: '배포 #3 보기' })).toBeTruthy()
    }
    ;['원인', '고칠 곳', '해야 할 일'].forEach((title) => expect(body().getByRole('header', { name: title })).toBeTruthy())
    expect(body().getByText(FIX)).toBeTruthy()
    await pickTab('문제')
    expect(body().getAllByTestId('incident-fact')).toHaveLength(5)
    expect(body().getByText('마법사가 한 일')).toBeTruthy()
    expect(body().getAllByTestId('timeline-item')).toHaveLength(2)
  })

  test('가운데 상자의 maxHeight 는 측정이 모두 끝나면 사용 가능 높이 - 위 묶음 - 아래 묶음 - 간격 둘, 하나라도 없으면 제한하지 않는다', async () => {
    await open()
    await act(async () => {})
    const maxOf = () => StyleSheet.flatten(screen.getByTestId('incident-middle').props.style)
    const layout = (id, height) => fireEvent(screen.getByTestId(id), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } })
    expect(maxOf().maxHeight).toBeUndefined()
    expect(maxOf().minHeight).toBe(160)
    expect(maxOf().flexGrow).toBe(1)
    await layout('incident-scroll', 780)
    await layout('incident-top', 100)
    expect(maxOf().maxHeight).toBeUndefined()
    await layout('incident-bottom', 166)
    const content = StyleSheet.flatten(screen.getByTestId('incident-scroll').props.contentContainerStyle)
    const available = 780 - content.padding - content.paddingBottom
    expect(maxOf().maxHeight).toBe(available - 100 - 166 - spacing.md * 2)
    // 아래 묶음이 커지면 (안내가 뜨면) 상자가 줄고, 위·아래가 너무 크면 최소 160 으로 멈춘다
    await layout('incident-bottom', 238)
    expect(maxOf().maxHeight).toBe(available - 100 - 238 - spacing.md * 2)
    await layout('incident-top', 900)
    expect(maxOf().maxHeight).toBe(160)
  })

  test('needs_action 이면 버튼 3개가 있고 동작 뒤에는 배포 보기 한 개만 남는다', async () => {
    await open(needsAction)
    expect(screen.getAllByRole('button').filter((b) => /^배포 #3 /.test(b.props.accessibilityLabel))).toHaveLength(3)
    expect(screen.getByText(/아무것도 누르지 않으면/)).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: '배포 #3 다시 배포' }))
    expect(await screen.findByText(/다시 배포를 시작했습니다/)).toBeTruthy()
    const labeled = screen.getAllByRole('button').filter((b) => /^배포 #3 /.test(b.props.accessibilityLabel))
    expect(labeled.map((b) => b.props.accessibilityLabel)).toEqual(['배포 #3 보기'])
    expect(screen.queryByText(/아무것도 누르지 않으면/)).toBeNull()
    expect(screen.getByTestId('incident-body')).toBeTruthy()
    expect(body().getAllByTestId('incident-fact')).toHaveLength(5)
  })

  test('동작 실패 오류가 버튼 위에 alert 로 전체 문장 보인다', async () => {
    const long = '이미 진행 중인 배포가 있어 지금은 다시 배포할 수 없습니다. 잠시 뒤 [배포 보기]에서 진행 상황을 확인한 다음 다시 시도하세요.'
    deployApi.redeploy.mockRejectedValueOnce(new Error(long))
    await open(needsAction)
    await fireEvent.press(screen.getByRole('button', { name: '배포 #3 다시 배포' }))
    expect(await screen.findByText(long)).toBeTruthy()
    // Notice 는 접근성 역할 alert 인 View 가 글을 감싼다 (View 라 getByRole 에는 잡히지 않아 부모를 본다)
    expect(screen.getByText(long).parent.props.accessibilityRole).toBe('alert')
    expect(within(screen.getByTestId('incident-body')).queryByText(long)).toBeNull()
    expect(screen.queryByTestId('incident-body')).toBeTruthy()
    expect(screen.getByRole('button', { name: '배포 #3 다시 배포' })).toBeTruthy()
  })

  test('긴 fix_where 가 원인 탭 글에 그대로 들어 있다 (공백 없는 ARN)', async () => {
    const arn = `arn:aws:ecs:ap-northeast-2:123456789012:service/${'very-long-cluster-name'.repeat(4)}/${'svc'.repeat(10)}`
    await open({ ...base, explain: { ...base.explain, fix_where: arn } })
    expect(screen.queryByText(arn)).toBeNull()
    await pickTab('원인')
    expect(body().getByText(arn)).toBeTruthy()
    expect(screen.getByRole('button', { name: '배포 #3 보기' })).toBeTruthy()
  })
})

describe('인시던트 상세 - 문제·원인 탭', () => {
  test('처음에는 문제 탭이 선택되고 배포·문제·날짜·시간·원인 줄과 타임라인이 가운데 상자 안에 있다', async () => {
    await open()
    expect(screen.getByRole('tab', { name: '문제' }).props.accessibilityState.selected).toBe(true)
    expect(screen.getByRole('tab', { name: '원인' }).props.accessibilityState.selected).toBe(false)
    const rows = body().getAllByTestId('incident-fact')
    expect(rows).toHaveLength(5)
    const expected = [['배포', '#3'], ['문제', '복구 중'], ['날짜', formatDate(base.detected_at)], ['시간', formatClock(base.detected_at)], ['원인', '응답 이상']]
    expected.forEach(([name, value], i) => {
      expect(within(rows[i]).getByText(name)).toBeTruthy()
      expect(within(rows[i]).getByText(value)).toBeTruthy()
    })
    // 복구 중에는 줄 아래에 안내 글, 그 아래에 타임라인
    expect(body().getByText(RECOVERING_TEXT)).toBeTruthy()
    expect(body().getByText('마법사가 한 일')).toBeTruthy()
    expect(body().getAllByTestId('timeline-item')).toHaveLength(2)
    // 원인 탭 글은 아직 없다
    expect(screen.queryByText(FIX)).toBeNull()
    expect(screen.queryByRole('header', { name: '앱이 오류로 응답하고 있습니다.' })).toBeNull()
  })

  test('모르는 종류와 읽을 수 없는 감지 시각에도 줄은 그대로 그려진다', async () => {
    await open({ ...base, kind: 'brand_new_kind', detected_at: 'not-a-date' })
    const rows = body().getAllByTestId('incident-fact')
    expect(within(rows[2]).getByText('확인 불가')).toBeTruthy()
    expect(within(rows[3]).getByText('확인 불가')).toBeTruthy()
    expect(within(rows[4]).getByText('brand_new_kind')).toBeTruthy()
  })

  test('원인 탭을 누르면 요약·원인·고칠 곳·해야 할 일이 보이고 문제 줄은 사라진다', async () => {
    await open()
    await pickTab('원인')
    expect(screen.getByRole('tab', { name: '원인' }).props.accessibilityState.selected).toBe(true)
    expect(screen.getByRole('tab', { name: '문제' }).props.accessibilityState.selected).toBe(false)
    expect(body().getByRole('header', { name: '앱이 오류로 응답하고 있습니다.' })).toBeTruthy()
    expect(body().getByText('앱이 떠 있지만 헬스체크에 5xx 로 답하고 있습니다.')).toBeTruthy()
    expect(body().getByText(FIX)).toBeTruthy()
    expect(body().getByText('환경변수를 점검합니다.')).toBeTruthy()
    expect(screen.queryAllByTestId('incident-fact')).toHaveLength(0)
    expect(screen.queryByText('마법사가 한 일')).toBeNull()
    expect(screen.queryByText(RECOVERING_TEXT)).toBeNull()
  })

  test('다시 문제 탭을 누르면 돌아온다 (상자는 탭마다 새로 만든다)', async () => {
    await open()
    const first = screen.getByTestId('incident-body')
    await pickTab('원인')
    expect(screen.getByTestId('incident-body')).not.toBe(first)
    await pickTab('문제')
    expect(screen.getByRole('tab', { name: '문제' }).props.accessibilityState.selected).toBe(true)
    expect(body().getAllByTestId('incident-fact')).toHaveLength(5)
    expect(body().getByText('마법사가 한 일')).toBeTruthy()
    expect(screen.queryByText(FIX)).toBeNull()
  })

  test('탭을 바꿔도 폴링 요청이 늘거나 다시 시작하지 않는다 (헬스 이력·안내·아래 묶음도 그대로)', async () => {
    await open()
    await act(async () => {})
    expect(incidentApi.getOne).toHaveBeenCalledTimes(1)
    expect(healthApi.getHistory).toHaveBeenCalledTimes(1)
    const bottom = screen.getByTestId('incident-bottom')
    await tick(3000)
    await pickTab('원인')
    await pickTab('문제')
    await pickTab('원인')
    expect(incidentApi.getOne).toHaveBeenCalledTimes(1)
    // 원래 박자(5초) 그대로 - 탭을 누른 때부터 다시 세지 않는다
    await tick(2000)
    expect(incidentApi.getOne).toHaveBeenCalledTimes(2)
    await tick(4999)
    expect(incidentApi.getOne).toHaveBeenCalledTimes(2)
    await tick(1)
    expect(incidentApi.getOne).toHaveBeenCalledTimes(3)
    expect(healthApi.getHistory).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText(/최근 24시간/)).toBeTruthy()
    expect(screen.getByTestId('incident-bottom')).toBe(bottom)
    await pickTab('문제')
    expect(body().getByText(RECOVERING_TEXT)).toBeTruthy()
    expect(incidentApi.getOne).toHaveBeenCalledTimes(3)
  })

  test('헬스 막대와 버튼은 탭에 상관없이 상자 밖에 있고 needs_action 이면 버튼 3개, 동작 뒤에는 배포 보기 하나다', async () => {
    await open(needsAction)
    await act(async () => {})
    for (const tab of ['문제', '원인']) {
      await pickTab(tab)
      expect(labeledButtons()).toEqual(['배포 #3 다시 배포', '배포 #3 멈춤', '배포 #3 그대로 두기'])
      expect(body().queryAllByRole('button').filter((b) => /^배포 #3 /.test(b.props.accessibilityLabel))).toHaveLength(0)
      expect(within(screen.getByTestId('incident-bottom')).getByLabelText(/최근 24시간/)).toBeTruthy()
      expect(body().queryByLabelText(/최근 24시간/)).toBeNull()
    }
    await fireEvent.press(screen.getByRole('button', { name: '배포 #3 다시 배포' }))
    expect(await screen.findByText(/다시 배포를 시작했습니다/)).toBeTruthy()
    for (const tab of ['문제', '원인']) {
      await pickTab(tab)
      expect(labeledButtons()).toEqual(['배포 #3 보기'])
      expect(within(screen.getByTestId('incident-bottom')).getByText(/다시 배포를 시작했습니다/)).toBeTruthy()
    }
  })

  test('불러오는 중·오류·404 에서는 탭이 없다', async () => {
    incidentApi.getOne.mockReset().mockReturnValue(new Promise(() => {}))
    const loadingView = await render(<IncidentDetail />)
    expect(screen.getByLabelText('불러오는 중')).toBeTruthy()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryByTestId('incident-top')).toBeNull()
    await loadingView.unmount()

    incidentApi.getOne.mockReset().mockRejectedValue(new Error('서버에 연결할 수 없습니다'))
    const errorView = await render(<IncidentDetail />)
    expect(await screen.findByText('서버에 연결할 수 없습니다')).toBeTruthy()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryByTestId('incident-top')).toBeNull()
    await errorView.unmount()

    incidentApi.getOne.mockReset().mockRejectedValue(notFound)
    await render(<IncidentDetail />)
    expect(await screen.findByText(NOT_FOUND_TEXT)).toBeTruthy()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryByTestId('incident-top')).toBeNull()
  })
})

describe('인시던트 상세 - 고칠 곳', () => {
  test('고칠 곳은 고정폭 글꼴의 선택 가능한 글자이고 길어도 그려진다', async () => {
    const long = `/app/${'very-long-directory-name/'.repeat(24)}config.py`
    await open({ ...base, explain: { ...base.explain, fix_where: long } })
    await pickTab('원인')
    const text = screen.getByText(long)
    expect(text.props.selectable).toBe(true)
    expect(StyleSheet.flatten(text.props.style).fontFamily).toBe(monoFont)
  })

  test('복사 버튼은 고칠 곳 전체를 복사하고 잠깐 복사됨으로 바뀐다', async () => {
    await open()
    await pickTab('원인')
    await fireEvent.press(screen.getByRole('button', { name: '고칠 곳 복사' }))
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(FIX)
    expect(await screen.findByText('복사됨')).toBeTruthy()
    await tick(2000)
    expect(screen.getByText('복사')).toBeTruthy()
  })

  test('복사가 false 로 끝나거나 던지면 실패 알림 (복사됨으로 바꾸지 않는다)', async () => {
    Clipboard.setStringAsync.mockResolvedValueOnce(false)
    await open()
    await pickTab('원인')
    await fireEvent.press(screen.getByRole('button', { name: '고칠 곳 복사' }))
    expect(await screen.findByText('고칠 곳을 복사하지 못했습니다')).toBeTruthy()
    expect(screen.queryByText('복사됨')).toBeNull()
    Clipboard.setStringAsync.mockRejectedValueOnce(new Error('x'))
    await fireEvent.press(screen.getByRole('button', { name: '고칠 곳 복사' }))
    expect(await screen.findByText('고칠 곳을 복사하지 못했습니다')).toBeTruthy()
  })
})

describe('인시던트 상세 - 갱신', () => {
  test('복구 중에는 5초마다 새로 받고, 해결되면 멈춘다', async () => {
    await open()
    expect(incidentApi.getOne).toHaveBeenCalledTimes(1)
    await tick(5000)
    expect(incidentApi.getOne).toHaveBeenCalledTimes(2)
    current = resolved
    await tick(5000)
    expect(await screen.findByText('해결됨')).toBeTruthy()
    expect(screen.getByRole('button', { name: '배포 #3 보기' })).toBeTruthy()
    const calls = incidentApi.getOne.mock.calls.length
    await tick(60000)
    expect(incidentApi.getOne.mock.calls.length).toBe(calls)
  })

  test('열림(open)도 계속 새로 받는다', async () => {
    await open({ ...base, status: 'open', actions: [] })
    await tick(5000)
    await tick(5000)
    expect(incidentApi.getOne).toHaveBeenCalledTimes(3)
  })

  test('확인 필요(needs_action)와 해결됨은 처음부터 폴링하지 않는다', async () => {
    await open(needsAction)
    await tick(60000)
    expect(incidentApi.getOne).toHaveBeenCalledTimes(1)
  })

  test('언마운트하면 타이머가 남지 않는다', async () => {
    const { unmount } = await open()
    await tick(5000)
    const calls = incidentApi.getOne.mock.calls.length
    await unmount()
    await tick(60000)
    expect(incidentApi.getOne.mock.calls.length).toBe(calls)
  })

  test('백그라운드에서는 멈추고 돌아오면 한 번 바로 받는다', async () => {
    const listeners = []
    AppState.addEventListener.mockImplementation((type, cb) => { listeners.push(cb); return { remove: jest.fn() } })
    await open()
    await act(async () => { listeners.forEach((l) => l('background')) })
    await tick(30000)
    expect(incidentApi.getOne).toHaveBeenCalledTimes(1)
    await act(async () => { listeners.forEach((l) => l('active')) })
    expect(incidentApi.getOne).toHaveBeenCalledTimes(2)
  })

  test('화면에 다시 포커스가 오면 한 번 새로 받는다 (처음 열 때는 따로 부르지 않는다)', async () => {
    await open(needsAction)
    expect(incidentApi.getOne).toHaveBeenCalledTimes(1)
    await act(async () => { mockFocus.regain() })
    expect(incidentApi.getOne).toHaveBeenCalledTimes(2)
  })

  test('갱신 중 한 번 실패해도 보이던 내용은 남고 알림이 뜬 뒤 다시 시도한다', async () => {
    await open()
    incidentApi.getOne.mockRejectedValueOnce(new Error('서버에 연결할 수 없습니다'))
    await tick(5000)
    expect(await screen.findByText('서버에 연결할 수 없습니다')).toBeTruthy()
    expect(screen.getAllByTestId('incident-fact')).toHaveLength(5)
    await tick(5000)
    expect(incidentApi.getOne).toHaveBeenCalledTimes(3)
    expect(screen.queryByText('서버에 연결할 수 없습니다')).toBeNull()
  })
})

describe('인시던트 상세 - 헬스 이력 호출', () => {
  test('처음 한 번, 이후 5초 틱에서는 부르지 않고 60초가 지나야 다시 부른다', async () => {
    await open()
    await act(async () => {})
    expect(healthApi.getHistory).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 11; i += 1) await tick(5000)
    expect(incidentApi.getOne).toHaveBeenCalledTimes(12)
    expect(healthApi.getHistory).toHaveBeenCalledTimes(1)
    await tick(5000)
    expect(healthApi.getHistory).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 11; i += 1) await tick(5000)
    expect(healthApi.getHistory).toHaveBeenCalledTimes(2)
    await tick(5000)
    expect(healthApi.getHistory).toHaveBeenCalledTimes(3)
  })

  test('상태가 바뀌면 60초 전이라도 바로 다시 받는다', async () => {
    await open({ ...base, status: 'open', actions: [] })
    await act(async () => {})
    expect(healthApi.getHistory).toHaveBeenCalledTimes(1)
    current = base
    await tick(5000)
    expect(healthApi.getHistory).toHaveBeenCalledTimes(2)
    current = resolved
    await tick(5000)
    expect(healthApi.getHistory).toHaveBeenCalledTimes(3)
  })

  test('포커스 복귀와 끌어당김(수동 새로고침)에서는 60초 전이라도 다시 받는다', async () => {
    await open(needsAction)
    await act(async () => {})
    expect(healthApi.getHistory).toHaveBeenCalledTimes(1)
    await act(async () => { mockFocus.regain() })
    expect(healthApi.getHistory).toHaveBeenCalledTimes(2)
    await act(async () => { screen.getByTestId('incident-scroll').props.refreshControl.props.onRefresh() })
    expect(healthApi.getHistory).toHaveBeenCalledTimes(3)
  })

  test('이력 호출이 끝나지 않아도 인시던트 갱신은 기다리지 않는다', async () => {
    healthApi.getHistory.mockReturnValue(new Promise(() => {}))
    await open()
    current = resolved
    await tick(5000)
    expect(await screen.findByText('해결됨')).toBeTruthy()
    expect(screen.queryByText('헬스체크 이력')).toBeNull()
  })

  test('이력 호출이 실패해도 지난 이력은 지우지 않고, 60초 뒤에 다시 시도한다', async () => {
    healthApi.getHistory.mockResolvedValueOnce([{ h_c_id: 1, ok: true, checked_at: new Date(Date.now() - 60000).toISOString().replace('Z', '') }])
    await open()
    expect(await screen.findByLabelText('최근 24시간 정상 100%')).toBeTruthy()
    healthApi.getHistory.mockRejectedValue(new Error('x'))
    for (let i = 0; i < 12; i += 1) await tick(5000)
    expect(healthApi.getHistory).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText(/최근 24시간 정상 \d+%/)).toBeTruthy()
  })

  test('늦게 온 이력 응답은 더 새로운 응답을 덮지 않고, 언마운트 뒤에는 무시한다', async () => {
    const resolvers = []
    healthApi.getHistory.mockImplementation(() => new Promise((r) => { resolvers.push(r) }))
    const { unmount } = await open(needsAction)
    await act(async () => { mockFocus.regain() })
    const mk = (ok) => [{ h_c_id: 1, ok, checked_at: new Date(Date.now() - 60000).toISOString().replace('Z', '') }]
    await act(async () => { resolvers[1](mk(true)) })
    expect(await screen.findByLabelText('최근 24시간 정상 100%')).toBeTruthy()
    await act(async () => { resolvers[0](mk(false)) })
    expect(screen.getByLabelText('최근 24시간 정상 100%')).toBeTruthy()
    await unmount()
    await act(async () => { resolvers[1](mk(false)) })
  })
})

describe('인시던트 상세 - 오류', () => {
  test('404: 한국어 안내와 돌아가기, 자동으로 계속 부르지 않는다', async () => {
    incidentApi.getOne.mockReset().mockRejectedValue(notFound)
    await render(<IncidentDetail />)
    expect(await screen.findByText(NOT_FOUND_TEXT)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull()
    await tick(120000)
    expect(incidentApi.getOne).toHaveBeenCalledTimes(1)
    await fireEvent.press(screen.getByRole('button', { name: '돌아가기' }))
    expect(mockBack).toHaveBeenCalledTimes(1)
  })

  test('폴링 도중 404(배포·인시던트가 지워짐): 폴링이 멈추고 안내와 돌아가기가 나온다', async () => {
    await open()
    incidentApi.getOne.mockRejectedValue(notFound)
    await tick(5000)
    expect(await screen.findByText(NOT_FOUND_TEXT)).toBeTruthy()
    expect(screen.getByRole('button', { name: '돌아가기' })).toBeTruthy()
    expect(screen.queryByText('원인')).toBeNull()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    const calls = incidentApi.getOne.mock.calls.length
    await tick(120000)
    expect(incidentApi.getOne.mock.calls.length).toBe(calls)
  })

  test('404 다음에 포커스가 돌아와 성공하면 내용이 다시 보인다', async () => {
    await open(needsAction)
    incidentApi.getOne.mockRejectedValueOnce(notFound)
    await act(async () => { mockFocus.regain() })
    expect(await screen.findByText(NOT_FOUND_TEXT)).toBeTruthy()
    await act(async () => { mockFocus.regain() })
    expect(await screen.findAllByTestId('incident-fact')).toHaveLength(5)
    expect(screen.queryByText(NOT_FOUND_TEXT)).toBeNull()
  })

  test('연결 실패가 이어지면 5초, 10초, 20초, 30초, 30초로 간격을 늘리고 성공하면 5초로 돌아온다', async () => {
    await open()
    incidentApi.getOne.mockRejectedValue(new Error('서버에 연결할 수 없습니다'))
    const calls = () => incidentApi.getOne.mock.calls.length
    expect(calls()).toBe(1)
    await tick(5000); expect(calls()).toBe(2)
    await tick(4999); expect(calls()).toBe(2)
    await tick(1); expect(calls()).toBe(3)
    await tick(9999); expect(calls()).toBe(3)
    await tick(1); expect(calls()).toBe(4)
    await tick(19999); expect(calls()).toBe(4)
    await tick(1); expect(calls()).toBe(5)
    await tick(29999); expect(calls()).toBe(5)
    await tick(1); expect(calls()).toBe(6)
    await tick(29999); expect(calls()).toBe(6)
    incidentApi.getOne.mockImplementation(async () => base)
    await tick(1); expect(calls()).toBe(7)
    expect(await screen.findAllByTestId('incident-fact')).toHaveLength(5)
    await tick(4999); expect(calls()).toBe(7)
    await tick(1); expect(calls()).toBe(8)
    expect(screen.queryByText('서버에 연결할 수 없습니다')).toBeNull()
  })

  test('연결 실패 뒤 성공하면 다음 실패는 다시 5초부터 시작한다', async () => {
    await open()
    incidentApi.getOne.mockRejectedValue(new Error('서버에 연결할 수 없습니다'))
    await tick(5000)
    await tick(5000)
    await tick(10000)
    incidentApi.getOne.mockImplementation(async () => base)
    await tick(20000)
    incidentApi.getOne.mockRejectedValue(new Error('서버에 연결할 수 없습니다'))
    const calls = incidentApi.getOne.mock.calls.length
    await tick(5000)
    expect(incidentApi.getOne.mock.calls.length).toBe(calls + 1)
    await tick(4999)
    expect(incidentApi.getOne.mock.calls.length).toBe(calls + 1)
    await tick(1)
    expect(incidentApi.getOne.mock.calls.length).toBe(calls + 2)
    await tick(9999)
    expect(incidentApi.getOne.mock.calls.length).toBe(calls + 2)
    await tick(1)
    expect(incidentApi.getOne.mock.calls.length).toBe(calls + 3)
  })

  test('먼저 보낸 느린 응답이 나중에 와도 더 새로운 응답을 덮어쓰지 않는다', async () => {
    let slow
    incidentApi.getOne.mockReset()
      .mockImplementationOnce(async () => needsAction)
      .mockImplementationOnce(() => new Promise((r) => { slow = r }))
      .mockImplementation(async () => resolved)
    await render(<IncidentDetail />)
    expect(await screen.findByText('확인 필요')).toBeTruthy()
    await act(async () => { mockFocus.regain() })
    await act(async () => { mockFocus.regain() })
    expect(await screen.findByText('해결됨')).toBeTruthy()
    // 요약은 원인 탭에 있으므로 원인 탭에서 늦은 응답을 받는다
    await pickTab('원인')
    await act(async () => { slow({ ...needsAction, summary: '오래된 응답' }) })
    expect(screen.queryByText('오래된 응답')).toBeNull()
    expect(screen.getByRole('header', { name: '앱이 오류로 응답하고 있습니다.' })).toBeTruthy()
    await pickTab('문제')
    expect(screen.getByText('해결됨')).toBeTruthy()
    expect(screen.queryByText('확인 필요')).toBeNull()
  })

  test('돌아갈 화면이 없으면(주소로 바로 들어옴) 목록으로 바꾼다', async () => {
    mockCanGoBack = false
    incidentApi.getOne.mockReset().mockRejectedValue(new Error('해당 id의 인시던트가 없습니다'))
    await render(<IncidentDetail />)
    await fireEvent.press(await screen.findByRole('button', { name: '돌아가기' }))
    expect(mockReplace).toHaveBeenCalledWith('/')
    expect(mockBack).not.toHaveBeenCalled()
  })

  test('네트워크 오류 -> 다시 시도하면 내용이 나온다', async () => {
    incidentApi.getOne.mockReset().mockRejectedValueOnce(new Error('서버에 연결할 수 없습니다')).mockImplementation(async () => base)
    await render(<IncidentDetail />)
    expect(await screen.findByText('서버에 연결할 수 없습니다')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findAllByTestId('incident-fact')).toHaveLength(5)
    expect(screen.queryByText('서버에 연결할 수 없습니다')).toBeNull()
  })

  test('처음 불러오는 동안 스피너', async () => {
    incidentApi.getOne.mockReset().mockReturnValue(new Promise(() => {}))
    await render(<IncidentDetail />)
    expect(screen.getByLabelText('불러오는 중')).toBeTruthy()
  })
})

describe('인시던트 상세 - 확인 필요일 때 사용자가 누르는 버튼', () => {
  test('다시 배포 / 멈춤 / 그대로 두기 세 개가 배포 번호를 넣은 라벨로 나온다', async () => {
    await open(needsAction)
    expect(screen.getByRole('button', { name: '배포 #3 다시 배포' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '배포 #3 멈춤' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '배포 #3 그대로 두기' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '배포 #3 보기' })).toBeNull()
    expect(screen.getByText('재시작했지만 응답이 없습니다')).toBeTruthy()
  })

  test('멈춤: 상세 화면과 같은 확인 창, 취소하면 요청이 나가지 않고 확인하면 멈춘 뒤 다시 불러온다', async () => {
    await open(needsAction)
    await fireEvent.press(screen.getByRole('button', { name: '배포 #3 멈춤' }))
    expect(deployApi.stop).not.toHaveBeenCalled()
    const [title, message, buttons] = Alert.alert.mock.calls[0]
    expect(title).toBe('이 배포를 멈출까요?')
    expect(message).toBe('ECS 서비스를 내려서 컨테이너 요금이 멈춥니다. 주소는 접속되지 않게 됩니다. 이미지와 설정은 남겨 두므로 [다시 켜기] 한 번으로 다시 띄울 수 있습니다.')
    expect(buttons.map((b) => b.text)).toEqual(['그대로 두기', '멈춤'])
    expect(buttons[0].style).toBe('cancel')

    await act(async () => { alertButton('그대로 두기').onPress?.() })
    expect(deployApi.stop).not.toHaveBeenCalled()
    expect(incidentApi.getOne).toHaveBeenCalledTimes(1)

    await act(async () => { alertButton('멈춤').onPress() })
    expect(deployApi.stop).toHaveBeenCalledWith(3)
    expect(incidentApi.getOne).toHaveBeenCalledTimes(2)
    expect(await screen.findByText(/멈추도록 요청했습니다/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '배포 #3 멈춤' })).toBeNull()
    expect(screen.getByRole('button', { name: '배포 #3 보기' })).toBeTruthy()
  })

  test('다시 배포: 요청을 보내고 다시 불러오고 안내를 띄운다', async () => {
    await open(needsAction)
    await fireEvent.press(screen.getByRole('button', { name: '배포 #3 다시 배포' }))
    expect(deployApi.redeploy).toHaveBeenCalledWith(3)
    expect(incidentApi.getOne).toHaveBeenCalledTimes(2)
    expect(await screen.findByText(/다시 배포를 시작했습니다/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '배포 #3 다시 배포' })).toBeNull()
  })

  test('그대로 두기: 요청 없이 이전 화면으로만 돌아간다', async () => {
    await open(needsAction)
    await fireEvent.press(screen.getByRole('button', { name: '배포 #3 그대로 두기' }))
    expect(mockBack).toHaveBeenCalledTimes(1)
    expect(deployApi.redeploy).not.toHaveBeenCalled()
    expect(deployApi.stop).not.toHaveBeenCalled()
    expect(Alert.alert).not.toHaveBeenCalled()
  })

  test('동작이 실패하면 빨간 알림을 띄우고 버튼은 그대로 다시 누를 수 있다', async () => {
    deployApi.redeploy.mockRejectedValueOnce(new Error('이미 진행 중입니다')).mockResolvedValue({})
    await open(needsAction)
    await fireEvent.press(screen.getByRole('button', { name: '배포 #3 다시 배포' }))
    expect(await screen.findByText('이미 진행 중입니다')).toBeTruthy()
    expect(screen.getByRole('button', { name: '배포 #3 다시 배포' })).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: '배포 #3 다시 배포' }))
    expect(deployApi.redeploy).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('이미 진행 중입니다')).toBeNull()
  })

  test('요청이 끝나기 전에는 버튼이 잠겨 같은 요청이 두 번 나가지 않는다', async () => {
    let finish
    deployApi.redeploy.mockImplementation(() => new Promise((r) => { finish = r }))
    await open(needsAction)
    await fireEvent.press(screen.getByRole('button', { name: '배포 #3 다시 배포' }))
    await fireEvent.press(screen.getByRole('button', { name: '배포 #3 다시 배포' }))
    expect(deployApi.redeploy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '배포 #3 멈춤' }).props.accessibilityState.disabled).toBe(true)
    await act(async () => { finish({}) })
  })

  test('해결됨·열림에는 사용자 동작 버튼이 없다 (자동 조치는 기록으로만 보인다)', async () => {
    await open(resolved)
    ;['다시 배포', '멈춤', '그대로 두기'].forEach((name) => {
      expect(screen.queryByRole('button', { name: `배포 #3 ${name}` })).toBeNull()
    })
    await fireEvent.press(screen.getByRole('button', { name: '배포 #3 보기' }))
    expect(mockPush).toHaveBeenCalledWith('/deploys/3')
  })

  test('모든 버튼은 눌림 높이 44 이상', async () => {
    await open(needsAction)
    screen.getAllByRole('button').forEach((button) => {
      const style = typeof button.props.style === 'function' ? button.props.style({ pressed: false }) : button.props.style
      expect(StyleSheet.flatten(style).minHeight).toBeGreaterThanOrEqual(44)
    })
  })
})
