import { AppState } from 'react-native'
import { renderHook, act } from '@testing-library/react-native'
import { useOnForeground } from '../hooks/useOnForeground'

let listeners = []
let appState = 'active'
let removeSpy

beforeEach(() => {
  listeners = []
  appState = 'active'
  removeSpy = jest.fn()
  Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => appState })
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, cb) => {
    listeners.push(cb)
    return { remove: () => { removeSpy(); listeners = listeners.filter((l) => l !== cb) } }
  })
  jest.spyOn(console, 'error')
  jest.spyOn(console, 'warn')
})
afterEach(() => {
  const noisy = [...console.error.mock.calls, ...console.warn.mock.calls]
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

const emit = async (next) => {
  appState = next
  await act(async () => { listeners.forEach((l) => l(next)) })
}

describe('useOnForeground', () => {
  test('백그라운드에서 active 로 돌아올 때마다 한 번씩 부른다', async () => {
    const cb = jest.fn()
    await renderHook(() => useOnForeground(cb))
    expect(cb).not.toHaveBeenCalled()
    await emit('background')
    expect(cb).not.toHaveBeenCalled()
    await emit('active')
    expect(cb).toHaveBeenCalledTimes(1)
    await emit('active')
    expect(cb).toHaveBeenCalledTimes(1)
    await emit('background')
    await emit('active')
    expect(cb).toHaveBeenCalledTimes(2)
  })

  test('background -> inactive -> active 도 한 번만 센다', async () => {
    const cb = jest.fn()
    await renderHook(() => useOnForeground(cb))
    await emit('background')
    await emit('inactive')
    await emit('active')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  test('active -> inactive -> active 도 복귀 한 번', async () => {
    const cb = jest.fn()
    await renderHook(() => useOnForeground(cb))
    await emit('inactive')
    await emit('active')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  test('처음부터 활성이면 부르지 않고, 비활성으로 시작했으면 첫 active 에서 부른다', async () => {
    appState = 'background'
    const cb = jest.fn()
    await renderHook(() => useOnForeground(cb))
    await emit('active')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  test('항상 가장 최근 callback 을 부른다', async () => {
    const first = jest.fn()
    const second = jest.fn()
    const { rerender } = await renderHook((cb) => useOnForeground(cb), { initialProps: first })
    await rerender(second)
    await emit('background')
    await emit('active')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  test('callback 이 바뀌어도 리스너는 다시 달지 않는다', async () => {
    const { rerender } = await renderHook((cb) => useOnForeground(cb), { initialProps: jest.fn() })
    await rerender(jest.fn())
    expect(listeners).toHaveLength(1)
    expect(removeSpy).not.toHaveBeenCalled()
  })

  test('언마운트하면 리스너를 떼고 이후 이벤트에는 부르지 않는다', async () => {
    const cb = jest.fn()
    const { unmount } = await renderHook(() => useOnForeground(cb))
    await unmount()
    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(listeners).toHaveLength(0)
    await emit('background')
    await emit('active')
    expect(cb).not.toHaveBeenCalled()
  })

  test('StrictMode 에서도 리스너는 짝이 맞고 복귀 한 번에 한 번만 부른다', async () => {
    const { StrictMode } = require('react')
    const cb = jest.fn()
    await renderHook(() => useOnForeground(cb), { wrapper: StrictMode })
    expect(listeners).toHaveLength(1)
    await emit('background')
    await emit('active')
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
