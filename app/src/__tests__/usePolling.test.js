import { AppState } from 'react-native'
import { renderHook, act } from '@testing-library/react-native'
import { usePolling, STOP_POLLING } from '../hooks/usePolling'

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
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

// 앱 상태를 바꾸고 리스너에게 알린다
const setAppState = async (next) => {
  appState = next
  await act(async () => { listeners.forEach((l) => l(next)) })
}

// 지정한 시간만큼 가짜 시계를 흘려 보낸다
const tick = async (ms) => {
  await act(async () => { jest.advanceTimersByTime(ms) })
}

describe('usePolling', () => {
  test('마운트하자마자 한 번 부르고 결과를 돌려준다', async () => {
    const fn = jest.fn().mockResolvedValue([1, 2])
    const { result } = await renderHook(() => usePolling(fn, () => 3000, []))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(result.current.data).toEqual([1, 2])
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  test('콜백이 정한 간격으로 다시 부른다', async () => {
    const fn = jest.fn().mockResolvedValue(['a'])
    const getDelayMs = jest.fn(() => 3000)
    await renderHook(() => usePolling(fn, getDelayMs, []))
    expect(getDelayMs).toHaveBeenCalledWith(['a'], null)
    await tick(2999)
    expect(fn).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(fn).toHaveBeenCalledTimes(2)
    await tick(3000)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test('결과에 따라 간격이 바뀐다', async () => {
    const fn = jest.fn().mockResolvedValueOnce('busy').mockResolvedValue('idle')
    await renderHook(() => usePolling(fn, (r) => (r === 'busy' ? 3000 : 15000), []))
    await tick(3000)
    expect(fn).toHaveBeenCalledTimes(2)
    await tick(14999)
    expect(fn).toHaveBeenCalledTimes(2)
    await tick(1)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test('실패하면 에러를 담고 에러용 간격으로 다시 부른다', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('끊김')).mockResolvedValue('ok')
    const { result } = await renderHook(() => usePolling(fn, (_, e) => (e ? 10000 : 3000), []))
    expect(result.current.error.message).toBe('끊김')
    expect(result.current.loading).toBe(false)
    await tick(9999)
    expect(fn).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBeNull()
    expect(result.current.data).toBe('ok')
  })

  test('실패해도 이전 데이터는 남긴다', async () => {
    const fn = jest.fn().mockResolvedValueOnce('old').mockRejectedValue(new Error('x'))
    const { result } = await renderHook(() => usePolling(fn, () => 1000, []))
    await tick(1000)
    expect(result.current.data).toBe('old')
    expect(result.current.error.message).toBe('x')
  })

  test('언마운트하면 더 부르지 않고 타이머도 남지 않는다', async () => {
    const fn = jest.fn().mockResolvedValue('a')
    const { unmount } = await renderHook(() => usePolling(fn, () => 3000, []))
    await unmount()
    await tick(10000)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(listeners).toHaveLength(0)
  })

  test('응답이 언마운트 뒤에 와도 타이머를 새로 만들지 않는다', async () => {
    let resolve
    const fn = jest.fn(() => new Promise((r) => { resolve = r }))
    const { unmount } = await renderHook(() => usePolling(fn, () => 3000, []))
    await unmount()
    await act(async () => { resolve('late') })
    await tick(10000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('앱이 활성이 아니면 멈추고, 돌아오면 한 번 바로 부른다', async () => {
    const fn = jest.fn().mockResolvedValue('a')
    await renderHook(() => usePolling(fn, () => 3000, []))
    expect(fn).toHaveBeenCalledTimes(1)

    await setAppState('background')
    await tick(30000)
    expect(fn).toHaveBeenCalledTimes(1)

    await setAppState('active')
    expect(fn).toHaveBeenCalledTimes(2)
    await tick(3000)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test('응답을 기다리던 중 백그라운드가 되면 다음 호출을 예약하지 않는다', async () => {
    let resolve
    const fn = jest.fn(() => new Promise((r) => { resolve = r }))
    await renderHook(() => usePolling(fn, () => 3000, []))
    await setAppState('inactive')
    await act(async () => { resolve('a') })
    await tick(10000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('이미 활성인데 active 이벤트가 또 와도 중복 호출하지 않는다', async () => {
    const fn = jest.fn().mockResolvedValue('a')
    await renderHook(() => usePolling(fn, () => 3000, []))
    await setAppState('active')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('refresh()는 기다리지 않고 바로 부르고 간격을 다시 센다', async () => {
    const fn = jest.fn().mockResolvedValueOnce('a').mockResolvedValue('b')
    const { result } = await renderHook(() => usePolling(fn, () => 3000, []))
    await tick(2000)
    await act(async () => { await result.current.refresh() })
    expect(fn).toHaveBeenCalledTimes(2)
    expect(result.current.data).toBe('b')
    await tick(2999)
    expect(fn).toHaveBeenCalledTimes(2)
    await tick(1)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test('deps가 바뀌면 처음부터 다시 시작한다', async () => {
    const fn = jest.fn().mockResolvedValue('a')
    const { rerender } = await renderHook(({ id }) => usePolling(fn, () => 3000, [id]), { initialProps: { id: 1 } })
    expect(fn).toHaveBeenCalledTimes(1)
    await rerender({ id: 2 })
    expect(fn).toHaveBeenCalledTimes(2)
    await tick(3000)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test('간격 계산이 던져도 조회 실패로 보지 않고 직전 간격(없으면 15초)으로 이어 간다', async () => {
    const fn = jest.fn().mockResolvedValue('a')
    const getDelayMs = jest.fn().mockReturnValueOnce(2000).mockImplementationOnce(() => { throw new Error('계산 실패') }).mockReturnValue(2000)
    const { result } = await renderHook(() => usePolling(fn, getDelayMs, []))
    await tick(2000)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBeNull()
    expect(result.current.data).toBe('a')
    await tick(1999)
    expect(fn).toHaveBeenCalledTimes(2)
    await tick(1)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test('처음부터 간격 계산이 던지면 15초 뒤에 다시 부른다', async () => {
    const fn = jest.fn().mockResolvedValue('a')
    const { result } = await renderHook(() => usePolling(fn, () => { throw new Error('x') }, []))
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
    await tick(14999)
    expect(fn).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test.each([[0], [-5], [NaN], [Infinity], [undefined], ['3000']])('간격이 %p 이면 바로 다시 부르지 않고 직전 간격으로 이어 간다', async (bad) => {
    const fn = jest.fn().mockResolvedValue('a')
    const getDelayMs = jest.fn().mockReturnValueOnce(4000).mockReturnValue(bad)
    await renderHook(() => usePolling(fn, getDelayMs, []))
    await tick(4000)
    expect(fn).toHaveBeenCalledTimes(2)
    await tick(3999)
    expect(fn).toHaveBeenCalledTimes(2)
    await tick(1)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test('실패 쪽 간격 계산이 던져도 에러는 조회 에러 그대로다', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('끊김'))
    const { result } = await renderHook(() => usePolling(fn, () => { throw new Error('계산 실패') }, []))
    expect(result.current.error.message).toBe('끊김')
    await tick(15000)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('STOP_POLLING 을 돌려주면 더 부르지 않고, refresh() 로는 다시 부른다', async () => {
    const fn = jest.fn().mockResolvedValue('a')
    const { result } = await renderHook(() => usePolling(fn, () => STOP_POLLING, []))
    await tick(60000)
    expect(fn).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.refresh() })
    expect(fn).toHaveBeenCalledTimes(2)
    await tick(60000)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('STOP_POLLING 이어도 백그라운드에서 돌아오면 한 번 확인한다', async () => {
    const fn = jest.fn().mockResolvedValue('a')
    await renderHook(() => usePolling(fn, () => STOP_POLLING, []))
    await setAppState('background')
    await setAppState('active')
    expect(fn).toHaveBeenCalledTimes(2)
    await tick(60000)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('deps 가 바뀌면 이전 데이터를 비우고 로딩으로 돌아간다', async () => {
    let resolveSecond
    const fn = jest.fn()
      .mockResolvedValueOnce('deploy-1')
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r }))
    const { result, rerender } = await renderHook(({ id }) => usePolling(fn, () => 3000, [id]), { initialProps: { id: 1 } })
    expect(result.current.data).toBe('deploy-1')
    await rerender({ id: 2 })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(true)
    await act(async () => { resolveSecond('deploy-2') })
    expect(result.current.data).toBe('deploy-2')
    expect(result.current.loading).toBe(false)
  })

  test('deps 가 바뀌면 이전 에러도 지운다', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('x')).mockReturnValue(new Promise(() => {}))
    const { result, rerender } = await renderHook(({ id }) => usePolling(fn, () => 3000, [id]), { initialProps: { id: 1 } })
    expect(result.current.error.message).toBe('x')
    await rerender({ id: 2 })
    expect(result.current.error).toBeNull()
  })
})
