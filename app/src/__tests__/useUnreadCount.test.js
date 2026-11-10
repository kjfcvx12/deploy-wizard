import { AppState } from 'react-native'
import { renderHook, act } from '@testing-library/react-native'
import { notificationApi } from '../api'
import { useUnreadCount } from '../hooks/useUnreadCount'

let listeners = []
let appState = 'active'

beforeEach(() => {
  jest.useFakeTimers()
  listeners = []
  appState = 'active'
  Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => appState })
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, cb) => {
    listeners.push(cb)
    return { remove: jest.fn(() => { listeners = listeners.filter((l) => l !== cb) }) }
  })
  jest.spyOn(console, 'error')
  jest.spyOn(console, 'warn')
})

afterEach(() => {
  const noisy = [...console.error.mock.calls, ...console.warn.mock.calls]
  jest.useRealTimers()
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

const setAppState = async (next) => {
  appState = next
  await act(async () => { listeners.forEach((l) => l(next)) })
}

const tick = async (ms) => {
  await act(async () => { jest.advanceTimersByTime(ms) })
}

describe('useUnreadCount', () => {
  test('마운트하자마자 읽지 않은 수를 가져온다', async () => {
    const spy = jest.spyOn(notificationApi, 'getUnreadCount').mockResolvedValue({ count: 3 })
    const { result } = await renderHook(() => useUnreadCount())
    expect(spy).toHaveBeenCalledTimes(1)
    expect(result.current.count).toBe(3)
  })

  test('가져오기 전에는 0', async () => {
    jest.spyOn(notificationApi, 'getUnreadCount').mockReturnValue(new Promise(() => {}))
    const { result } = await renderHook(() => useUnreadCount())
    expect(result.current.count).toBe(0)
  })

  test('30초마다 다시 가져온다', async () => {
    const spy = jest.spyOn(notificationApi, 'getUnreadCount')
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 4 })
    const { result } = await renderHook(() => useUnreadCount())
    await tick(29999)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(result.current.count).toBe(1)
    await tick(1)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(result.current.count).toBe(4)
    await tick(30000)
    expect(spy).toHaveBeenCalledTimes(3)
  })

  test('백그라운드에서는 멈추고 돌아오면 바로 한 번 가져온다', async () => {
    const spy = jest.spyOn(notificationApi, 'getUnreadCount').mockResolvedValue({ count: 2 })
    await renderHook(() => useUnreadCount())
    await setAppState('background')
    await tick(120000)
    expect(spy).toHaveBeenCalledTimes(1)
    await setAppState('active')
    expect(spy).toHaveBeenCalledTimes(2)
    await tick(30000)
    expect(spy).toHaveBeenCalledTimes(3)
  })

  test('에러가 나면 0 이고 던지지 않고 계속 시도한다', async () => {
    const spy = jest.spyOn(notificationApi, 'getUnreadCount')
      .mockResolvedValueOnce({ count: 5 })
      .mockRejectedValueOnce(new Error('서버에 연결할 수 없습니다'))
      .mockResolvedValue({ count: 6 })
    const { result } = await renderHook(() => useUnreadCount())
    expect(result.current.count).toBe(5)
    await tick(30000)
    expect(result.current.count).toBe(0)
    await tick(30000)
    expect(spy).toHaveBeenCalledTimes(3)
    expect(result.current.count).toBe(6)
  })

  test('이상한 응답은 0', async () => {
    jest.spyOn(notificationApi, 'getUnreadCount').mockResolvedValue({ count: 'many' })
    const { result } = await renderHook(() => useUnreadCount())
    expect(result.current.count).toBe(0)
  })

  test('refresh 는 기다리지 않고 바로 다시 가져온다', async () => {
    const spy = jest.spyOn(notificationApi, 'getUnreadCount')
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValue({ count: 0 })
    const { result } = await renderHook(() => useUnreadCount())
    expect(result.current.count).toBe(2)
    await act(async () => { await result.current.refresh() })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(result.current.count).toBe(0)
  })

  test('언마운트하면 타이머와 리스너가 남지 않는다', async () => {
    const spy = jest.spyOn(notificationApi, 'getUnreadCount').mockResolvedValue({ count: 1 })
    const { unmount } = await renderHook(() => useUnreadCount())
    expect(listeners).toHaveLength(1)
    await unmount()
    expect(listeners).toHaveLength(0)
    await tick(120000)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
