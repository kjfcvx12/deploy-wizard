import { AppState, StyleSheet } from 'react-native'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native'
import { notificationApi } from '../api'
import Notifications from '../../app/notifications'
import { formatTime } from '../ops/format'

const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  Stack: { Screen: () => null },
}))
jest.mock('../api', () => ({
  notificationApi: { getAll: jest.fn(), read: jest.fn(), readAll: jest.fn() },
}))

// 알림 한 건을 만든다 (기본: 읽지 않은 인시던트 알림)
const make = (n_id, over = {}) => ({
  n_id, kind: 'incident_opened', title: `제목 ${n_id}`, body: `본문 ${n_id}`, d_id: 3, i_id: 5,
  read_at: null, created_at: '2026-11-09T03:12:30', ...over,
})
// 한 쪽(100건)을 만든다 - n_id 는 start 에서 내려간다
const page = (start, count = 100) => Array.from({ length: count }, (_, i) => make(start - i))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
// 대기 중인 비동기 작업이 모두 끝나도록 한 번 비운다
// (가짜 시간 - 목록이 줄을 나눠 그리는 예약 작업도 여기서 지나가게 한다)
const settle = () => act(async () => { jest.advanceTimersByTime(200) })
// 목록이 가진 n_id 들 (FlatList 는 화면 밖 줄을 그리지 않으므로 데이터로 확인한다)
const ids = () => screen.getByTestId('notification-list').props.data.map((item) => item.n_id)
const weight = (text) => StyleSheet.flatten(screen.getByText(text).props.style).fontWeight

beforeEach(() => {
  jest.useFakeTimers()
  mockPush.mockReset()
  notificationApi.getAll.mockReset()
  notificationApi.read.mockReset().mockImplementation(async (n_id) => ({ n_id, read_at: '2026-11-09T04:00:00' }))
  notificationApi.readAll.mockReset().mockResolvedValue({ updated: 1 })
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() }))
  jest.spyOn(console, 'error')
  jest.spyOn(console, 'warn')
})

afterEach(() => {
  const noisy = [...console.error.mock.calls, ...console.warn.mock.calls]
  jest.useRealTimers()
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

describe('알림 목록 - 보이는 모습', () => {
  test('아이콘, 제목, 한 줄 본문, 시각이 나오고 읽지 않은 줄만 굵고 점이 있다', async () => {
    notificationApi.getAll.mockResolvedValue([
      make(2, { kind: 'deploy_failed', d_id: 4, i_id: null }),
      make(1, { kind: 'incident_recovered', read_at: '2026-11-09T03:20:00' }),
    ])
    await render(<Notifications />)
    expect(await screen.findByText('제목 2')).toBeTruthy()
    expect(screen.getByText('본문 2').props.numberOfLines).toBe(1)
    expect(screen.getAllByText(formatTime('2026-11-09T03:12:30'))).toHaveLength(2)
    expect(weight('제목 2')).toBe('700')
    expect(weight('제목 1')).not.toBe('700')
    expect(screen.getAllByTestId('unread-dot')).toHaveLength(1)
    // 종류 아이콘 (텍스트 표시 선택자가 붙는다)
    expect(screen.getByText('✖︎')).toBeTruthy()
    expect(screen.getByText('↺︎')).toBeTruthy()
  })

  test('불러오는 동안 스피너', async () => {
    notificationApi.getAll.mockReturnValue(new Promise(() => {}))
    await render(<Notifications />)
    expect(screen.getByLabelText('불러오는 중')).toBeTruthy()
  })

  test('비어 있으면 새 알림이 없습니다', async () => {
    notificationApi.getAll.mockResolvedValue([])
    await render(<Notifications />)
    expect(await screen.findByText('새 알림이 없습니다')).toBeTruthy()
    expect(screen.queryByText('모두 읽음')).toBeNull()
    expect(screen.queryByText('더 보기')).toBeNull()
  })

  test('처음 불러오기에 실패하면 메시지와 다시 시도, 누르면 다시 부른다', async () => {
    notificationApi.getAll.mockRejectedValueOnce(new Error('연결 끊김')).mockResolvedValue([make(1)])
    await render(<Notifications />)
    expect(await screen.findByText(/연결 끊김/)).toBeTruthy()
    await fireEvent.press(screen.getByText('다시 시도'))
    expect(await screen.findByText('제목 1')).toBeTruthy()
    expect(screen.queryByText('다시 시도')).toBeNull()
  })

  test('목록이 있는 상태에서 끌어당겨 새로고침이 실패하면 목록은 두고 알린다', async () => {
    notificationApi.getAll.mockResolvedValueOnce([make(1)]).mockRejectedValueOnce(new Error('끊김'))
    await render(<Notifications />)
    await screen.findByText('제목 1')
    await act(async () => { screen.getByTestId('notification-list').props.refreshControl.props.onRefresh() })
    expect(await screen.findByText(/끊김/)).toBeTruthy()
    expect(screen.getByText('제목 1')).toBeTruthy()
  })

  test('끌어당겨 새로고침하면 목록을 처음 쪽으로 다시 받는다', async () => {
    notificationApi.getAll.mockResolvedValueOnce([make(1)]).mockResolvedValueOnce([make(9, { title: '새 알림' }), make(1)])
    await render(<Notifications />)
    await screen.findByText('제목 1')
    await act(async () => { screen.getByTestId('notification-list').props.refreshControl.props.onRefresh() })
    expect(await screen.findByText('새 알림')).toBeTruthy()
  })

  test('반복되는 버튼 라벨에 종류와 제목이 들어간다', async () => {
    notificationApi.getAll.mockResolvedValue([make(2), make(1, { kind: 'new_commit', read_at: '2026-11-09T03:20:00' })])
    await render(<Notifications />)
    await screen.findByText('제목 2')
    expect(screen.getByRole('button', { name: '읽지 않음 · 문제 감지: 제목 2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '새 커밋: 제목 1' })).toBeTruthy()
  })

  test('줄과 버튼은 눌림 높이가 44 이상이다', async () => {
    notificationApi.getAll.mockResolvedValue(page(100))
    await render(<Notifications />)
    await screen.findByText('제목 100')
    for (const name of [/제목 100/, '모두 읽음', '더 보기']) {
      const style = StyleSheet.flatten(screen.getAllByRole('button', { name })[0].props.style)
      expect(style.minHeight).toBeGreaterThanOrEqual(44)
    }
  })
})

describe('알림 목록 - 누르기', () => {
  test('읽지 않은 줄을 누르면 서버 응답 전에 읽음으로 바뀌고 인시던트로 간다', async () => {
    const gate = deferred()
    notificationApi.getAll.mockResolvedValue([make(2)])
    notificationApi.read.mockReturnValue(gate.promise)
    await render(<Notifications />)
    await fireEvent.press(await screen.findByText('제목 2'))
    expect(notificationApi.read).toHaveBeenCalledWith(2)
    expect(weight('제목 2')).not.toBe('700')
    expect(screen.queryByTestId('unread-dot')).toBeNull()
    expect(mockPush).toHaveBeenCalledWith('/incidents/5')
    await act(async () => { gate.resolve({ n_id: 2, read_at: '2026-11-09T04:00:00' }) })
    expect(weight('제목 2')).not.toBe('700')
  })

  test.each([
    ['incident_opened', '/incidents/5'],
    ['incident_recovered', '/incidents/5'],
    ['incident_needs_action', '/incidents/5'],
    ['deploy_succeeded', '/deploys/3'],
    ['deploy_failed', '/deploys/3'],
    ['new_commit', '/deploys/3'],
  ])('%s 는 %s 로 간다', async (kind, route) => {
    notificationApi.getAll.mockResolvedValue([make(2, { kind })])
    await render(<Notifications />)
    await fireEvent.press(await screen.findByText('제목 2'))
    expect(mockPush).toHaveBeenCalledWith(route)
    expect(mockPush).toHaveBeenCalledTimes(1)
  })

  test('필요한 번호가 없는 줄은 읽음으로만 표시하고 이동하지 않는다', async () => {
    notificationApi.getAll.mockResolvedValue([
      make(2, { kind: 'incident_opened', i_id: null }),
      make(3, { kind: 'deploy_failed', d_id: null }),
    ])
    await render(<Notifications />)
    await fireEvent.press(await screen.findByText('제목 2'))
    await fireEvent.press(screen.getByText('제목 3'))
    expect(notificationApi.read).toHaveBeenCalledWith(2)
    expect(notificationApi.read).toHaveBeenCalledWith(3)
    expect(mockPush).not.toHaveBeenCalled()
  })

  test('이미 읽은 줄은 읽음 요청 없이 이동만 한다', async () => {
    notificationApi.getAll.mockResolvedValue([make(2, { read_at: '2026-11-09T03:20:00', kind: 'deploy_succeeded' })])
    await render(<Notifications />)
    await fireEvent.press(await screen.findByText('제목 2'))
    expect(notificationApi.read).not.toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith('/deploys/3')
  })

  test('읽음 요청이 실패하면 굵은 글씨로 되돌리고 메시지를 보인다 (이동은 한다)', async () => {
    notificationApi.getAll.mockResolvedValue([make(2)])
    notificationApi.read.mockRejectedValue(new Error('서버 오류'))
    await render(<Notifications />)
    await fireEvent.press(await screen.findByText('제목 2'))
    expect(await screen.findByText(/읽음으로 표시하지 못했습니다.*서버 오류/)).toBeTruthy()
    expect(weight('제목 2')).toBe('700')
    expect(screen.getAllByTestId('unread-dot')).toHaveLength(1)
    expect(mockPush).toHaveBeenCalledWith('/incidents/5')
  })

  test('같은 줄을 연달아 두 번 눌러도 읽음 요청과 이동은 한 번', async () => {
    const gate = deferred()
    notificationApi.getAll.mockResolvedValue([make(2)])
    notificationApi.read.mockReturnValue(gate.promise)
    await render(<Notifications />)
    const row = await screen.findByText('제목 2')
    await fireEvent.press(row)
    await fireEvent.press(row)
    await act(async () => { gate.resolve({ n_id: 2, read_at: 'x' }) })
    await fireEvent.press(screen.getByText('제목 2'))
    expect(notificationApi.read).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledTimes(1)
  })

  test('언마운트한 뒤에 읽음 요청이 실패해도 경고가 없다', async () => {
    const gate = deferred()
    notificationApi.getAll.mockResolvedValue([make(2)])
    notificationApi.read.mockReturnValue(gate.promise)
    const { unmount } = await render(<Notifications />)
    await fireEvent.press(await screen.findByText('제목 2'))
    await unmount()
    await act(async () => { gate.reject(new Error('x')) })
  })
})

describe('알림 목록 - 모두 읽음', () => {
  test('누르면 모두 읽음으로 바뀌고 한 번만 부른다', async () => {
    const gate = deferred()
    notificationApi.getAll.mockResolvedValue([make(2), make(1)])
    notificationApi.readAll.mockReturnValue(gate.promise)
    await render(<Notifications />)
    await screen.findByText('제목 2')
    await fireEvent.press(screen.getByText('모두 읽음'))
    await fireEvent.press(screen.getByText('모두 읽음'))
    expect(screen.queryByTestId('unread-dot')).toBeNull()
    expect(weight('제목 1')).not.toBe('700')
    await act(async () => { gate.resolve({ updated: 2 }) })
    await settle()
    expect(notificationApi.readAll).toHaveBeenCalledTimes(1)
  })

  test('실패하면 읽지 않던 줄만 되돌리고 메시지를 보인다', async () => {
    notificationApi.getAll.mockResolvedValue([make(2), make(1, { read_at: '2026-11-09T03:20:00' })])
    notificationApi.readAll.mockRejectedValue(new Error('서버 오류'))
    await render(<Notifications />)
    await screen.findByText('제목 2')
    await fireEvent.press(screen.getByText('모두 읽음'))
    expect(await screen.findByText(/모두 읽음으로 표시하지 못했습니다.*서버 오류/)).toBeTruthy()
    expect(weight('제목 2')).toBe('700')
    expect(weight('제목 1')).not.toBe('700')
    expect(screen.getAllByTestId('unread-dot')).toHaveLength(1)
  })
})

describe('알림 목록 - 더 보기', () => {
  test('100건이면 더 보기가 보이고, 누르면 가장 작은 n_id 를 after 로 보낸다', async () => {
    notificationApi.getAll.mockResolvedValueOnce(page(250)).mockResolvedValueOnce(page(150, 40))
    await render(<Notifications />)
    await screen.findByText('제목 250')
    // 처음 부를 때는 after 키가 없다
    expect(notificationApi.getAll.mock.calls[0][0] || {}).not.toHaveProperty('after')
    await fireEvent.press(screen.getByText('더 보기'))
    expect(notificationApi.getAll).toHaveBeenLastCalledWith({ after: 151 })
    await waitFor(() => expect(ids()).toHaveLength(140))
    expect(ids()[0]).toBe(250)
    expect(ids()[139]).toBe(111)
    // 40건뿐이라 더 없다
    expect(screen.queryByText('더 보기')).toBeNull()
  })

  test('겹치는 n_id 는 한 번만 보인다', async () => {
    notificationApi.getAll.mockResolvedValueOnce(page(100)).mockResolvedValueOnce([make(1, { title: '겹침' }), make(0, { title: '새것' })])
    await render(<Notifications />)
    await screen.findByText('제목 100')
    await fireEvent.press(screen.getByText('더 보기'))
    await waitFor(() => expect(ids()).toHaveLength(101))
    expect(ids().filter((id) => id === 1)).toHaveLength(1)
    expect(ids()[100]).toBe(0)
    expect(screen.getByTestId('notification-list').props.data[99].title).toBe('제목 1')
  })

  test('100건 미만이면 더 보기가 없다', async () => {
    notificationApi.getAll.mockResolvedValue(page(99, 99))
    await render(<Notifications />)
    await screen.findByText('제목 99')
    expect(screen.queryByText('더 보기')).toBeNull()
  })

  test('연달아 두 번 눌러도 한 번만 부른다', async () => {
    const gate = deferred()
    notificationApi.getAll.mockResolvedValueOnce(page(100)).mockReturnValueOnce(gate.promise)
    await render(<Notifications />)
    await screen.findByText('제목 100')
    await fireEvent.press(screen.getByText('더 보기'))
    await fireEvent.press(screen.getByText('더 보기'))
    expect(notificationApi.getAll).toHaveBeenCalledTimes(2)
    await act(async () => { gate.resolve([]) })
    await settle()
  })

  test('더 보기가 실패하면 메시지를 보이고 목록과 버튼은 그대로', async () => {
    notificationApi.getAll.mockResolvedValueOnce(page(100)).mockRejectedValueOnce(new Error('끊김'))
    await render(<Notifications />)
    await screen.findByText('제목 100')
    await fireEvent.press(screen.getByText('더 보기'))
    expect(await screen.findByText(/끊김/)).toBeTruthy()
    expect(screen.getByText('제목 100')).toBeTruthy()
    expect(screen.getByText('더 보기')).toBeTruthy()
  })

  test('더 보기 응답이 오기 전에 새로고침하면 늦게 온 응답은 버린다', async () => {
    const gate = deferred()
    notificationApi.getAll
      .mockResolvedValueOnce(page(100))
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce([make(500, { title: '새로고침 결과' })])
    await render(<Notifications />)
    await screen.findByText('제목 100')
    await fireEvent.press(screen.getByText('더 보기'))
    await act(async () => { screen.getByTestId('notification-list').props.refreshControl.props.onRefresh() })
    await screen.findByText('새로고침 결과')
    await act(async () => { gate.resolve([make(7, { title: '늦은 응답' })]) })
    await settle()
    expect(ids()).toEqual([500])
    expect(screen.getByText('새로고침 결과')).toBeTruthy()
  })
})
