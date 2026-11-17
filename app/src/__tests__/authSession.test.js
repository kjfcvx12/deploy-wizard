import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { loginPlatform } from '../auth/platform'
import { readRefreshToken, writeRefreshToken, clearRefreshToken, REFRESH_KEY } from '../auth/tokenStore'
import * as webStore from '../auth/tokenStore.web'
import {
  getAccessToken, getSessionUser, getSessionStatus, setSession, clearSession, subscribeSession,
  setRefresher, refreshSession, markBooted, resetSessionForTest, getStorageWarning, getRefreshToken,
} from '../auth/session'

// 밖에서 풀 수 있는 약속 - 갱신·저장이 끝나기 전 상태를 보려고 쓴다
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// 서버가 거절한 오류 (request 가 던지는 모양)
const httpError = (status) => Object.assign(new Error(`요청 실패 (${status})`), { status })

// 보안 저장소에 지금 든 리프레시 원문
const stored = () => SecureStore.getItemAsync(REFRESH_KEY)

// AsyncStorage 의 모든 값을 이어 붙인다 - 원문이 새지 않았는지 본다
const asyncStorageDump = async () => {
  const keys = await AsyncStorage.getAllKeys()
  const pairs = await AsyncStorage.multiGet(keys)
  return JSON.stringify(pairs)
}

beforeEach(async () => {
  resetSessionForTest()
  SecureStore.__reset()
  jest.clearAllMocks()
  await AsyncStorage.clear()
})

afterEach(() => {
  // replaceProperty 로 바꾼 Platform.OS 를 되돌린다
  jest.restoreAllMocks()
})

describe('loginPlatform', () => {
  test.each([
    ['web', 'web'],
    ['android', 'android'],
    ['ios', null],
    ['windows', null],
  ])('%s -> %s', (os, expected) => {
    expect(loginPlatform(os)).toBe(expected)
  })

  test('인자가 없으면 지금 Platform.OS', () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    expect(loginPlatform()).toBe('android')
    jest.replaceProperty(Platform, 'OS', 'ios')
    expect(loginPlatform()).toBeNull()
  })
})

describe('tokenStore', () => {
  test('키 dw-refresh 로 쓰고 읽고 지운다', async () => {
    expect(REFRESH_KEY).toBe('dw-refresh')
    await expect(writeRefreshToken('dwr_1')).resolves.toBe(true)
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('dw-refresh', 'dwr_1')
    await expect(readRefreshToken()).resolves.toBe('dwr_1')
    await clearRefreshToken()
    await expect(readRefreshToken()).resolves.toBeNull()
  })

  test('저장소가 던지면 false·null 이고 던지지 않는다', async () => {
    SecureStore.setItemAsync.mockRejectedValueOnce(new Error('keystore'))
    await expect(writeRefreshToken('dwr_1')).resolves.toBe(false)
    SecureStore.getItemAsync.mockRejectedValueOnce(new Error('keystore'))
    await expect(readRefreshToken()).resolves.toBeNull()
    SecureStore.deleteItemAsync.mockRejectedValueOnce(new Error('keystore'))
    await expect(clearRefreshToken()).resolves.toBeUndefined()
  })

  test('빈 값은 쓰지 않는다', async () => {
    await expect(writeRefreshToken('')).resolves.toBe(false)
    await expect(writeRefreshToken(null)).resolves.toBe(false)
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
  })

  test('웹 판은 아무것도 저장하지 않는다 (웹은 쿠키)', async () => {
    await expect(webStore.writeRefreshToken('dwr_1')).resolves.toBe(false)
    await expect(webStore.readRefreshToken()).resolves.toBeNull()
    await expect(webStore.clearRefreshToken()).resolves.toBeUndefined()
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
  })
})

describe('setSession', () => {
  test('setSession writes refresh before memory', async () => {
    const write = deferred()
    SecureStore.setItemAsync.mockImplementationOnce(() => write.promise)
    const done = setSession({ access_token: 'A1', refresh_token: 'dwr_1', user: { u_id: 1 }, expires_in: 900 })
    await Promise.resolve()
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('dw-refresh', 'dwr_1')
    expect(getAccessToken()).toBeNull()
    write.resolve()
    await done
    expect(getAccessToken()).toBe('A1')
    expect(getSessionStatus()).toBe('signed_in')
    expect(getSessionUser()).toEqual({ u_id: 1 })
    expect(getStorageWarning()).toBe(false)
  })

  test('쓰기가 실패하면 메모리에만 두고 storageWarning, AsyncStorage 에 원문이 없다', async () => {
    await AsyncStorage.setItem('dw-picked-block', '3')
    SecureStore.setItemAsync.mockRejectedValueOnce(new Error('keystore'))
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1', user: { u_id: 1 } })
    expect(getAccessToken()).toBe('A1')
    expect(getStorageWarning()).toBe(true)
    await expect(getRefreshToken()).resolves.toBe('dwr_1')
    await expect(stored()).resolves.toBeNull()
    expect(await asyncStorageDump()).not.toContain('dwr_')
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1)
  })

  test('쓰기가 실패하면 저장소에 남은 옛 원문을 지운다 (다음 실행 때 다시 로그인)', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    SecureStore.setItemAsync.mockRejectedValueOnce(new Error('keystore'))
    await setSession({ access_token: 'A2', refresh_token: 'dwr_2' })
    await expect(stored()).resolves.toBeNull()
    await expect(getRefreshToken()).resolves.toBe('dwr_2')
  })

  test('refresh_token 이 없으면(웹 번들 - 쿠키) 저장소를 건드리지 않는다', async () => {
    await setSession({ access_token: 'A1', refresh_token: null })
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
    expect(getAccessToken()).toBe('A1')
    expect(getStorageWarning()).toBe(false)
  })

  test('구독자에게는 토큰을 주지 않는다', async () => {
    const seen = []
    subscribeSession((state) => seen.push(state))
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1', user: { u_id: 1 } })
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(seen)).not.toContain('A1')
    expect(JSON.stringify(seen)).not.toContain('dwr_')
    expect(seen[0]).toMatchObject({ status: 'signed_in', user: { u_id: 1 } })
  })

  test('저장 중에 로그아웃하면 되살리지 않는다', async () => {
    const write = deferred()
    SecureStore.setItemAsync.mockImplementationOnce(async (key, value) => {
      await write.promise
      SecureStore.__items().set(key, value)
    })
    const done = setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const cleared = clearSession('logout')
    write.resolve()
    await done
    await cleared
    expect(getAccessToken()).toBeNull()
    expect(getSessionStatus()).toBe('signed_out')
    await expect(stored()).resolves.toBeNull()
  })
})

describe('clearSession', () => {
  test('메모리와 보안 저장소를 비우고 이유를 알린다', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const seen = []
    subscribeSession((state) => seen.push(state))
    await clearSession('logout')
    expect(getAccessToken()).toBeNull()
    expect(getSessionStatus()).toBe('signed_out')
    await expect(stored()).resolves.toBeNull()
    await expect(getRefreshToken()).resolves.toBeNull()
    expect(seen).toEqual([expect.objectContaining({ status: 'signed_out', reason: 'logout' })])
  })
})

describe('refreshSession', () => {
  test('rotation persists new refresh', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const refresher = jest.fn(async () => ({ access_token: 'A2', refresh_token: 'dwr_2', user: { u_id: 1 }, expires_in: 900 }))
    setRefresher(refresher)
    await expect(refreshSession()).resolves.toBe(true)
    expect(getAccessToken()).toBe('A2')
    await expect(stored()).resolves.toBe('dwr_2')
    await expect(getRefreshToken()).resolves.toBe('dwr_2')
  })

  test('single flight: 동시 5번 -> 갱신기 1번', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const gate = deferred()
    const refresher = jest.fn(async () => { await gate.promise; return { access_token: 'A2', refresh_token: 'dwr_2' } })
    setRefresher(refresher)
    const runs = [1, 2, 3, 4, 5].map(() => refreshSession())
    gate.resolve()
    await expect(Promise.all(runs)).resolves.toEqual([true, true, true, true, true])
    expect(refresher).toHaveBeenCalledTimes(1)
  })

  test('401 clears store: 로그인 상태였으면 expired', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const seen = []
    subscribeSession((state) => seen.push(state))
    setRefresher(async () => { throw httpError(401) })
    await expect(refreshSession()).resolves.toBe(false)
    expect(getSessionStatus()).toBe('signed_out')
    expect(getAccessToken()).toBeNull()
    await Promise.resolve()
    await expect(stored()).resolves.toBeNull()
    expect(seen).toEqual([expect.objectContaining({ status: 'signed_out', reason: 'expired' })])
  })

  test('첫 확인 중(unknown) 403 은 조용히 signed_out, 저장소도 비운다', async () => {
    await SecureStore.setItemAsync(REFRESH_KEY, 'dwr_old')
    const seen = []
    subscribeSession((state) => seen.push(state))
    setRefresher(async () => { throw httpError(403) })
    await expect(refreshSession()).resolves.toBe(false)
    expect(getSessionStatus()).toBe('signed_out')
    expect(seen).toEqual([{ status: 'signed_out', user: null, storageWarning: false }])
    await Promise.resolve()
    await expect(stored()).resolves.toBeNull()
  })

  test('이미 signed_out 이면 거절돼도 알리지 않는다', async () => {
    markBooted('signed_out')
    const seen = []
    subscribeSession((state) => seen.push(state))
    setRefresher(async () => { throw httpError(401) })
    await expect(refreshSession()).resolves.toBe(false)
    expect(seen).toEqual([])
  })

  test('offline keeps store: 네트워크·5xx 는 그 오류를 던지고 세션을 둔다', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    setRefresher(async () => { throw new Error('서버에 연결할 수 없습니다') })
    await expect(refreshSession()).rejects.toThrow('서버에 연결할 수 없습니다')
    setRefresher(async () => { throw httpError(503) })
    await expect(refreshSession()).rejects.toMatchObject({ status: 503 })
    expect(getSessionStatus()).toBe('signed_in')
    expect(getAccessToken()).toBe('A1')
    await expect(stored()).resolves.toBe('dwr_1')
  })

  test('갱신 중에 다시 로그인하면 늦게 온 거절이 새 세션을 지우지 않는다', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const gate = deferred()
    setRefresher(() => gate.promise)
    const run = refreshSession()
    await setSession({ access_token: 'B1', refresh_token: 'dwr_b' })
    gate.reject(httpError(401))
    await expect(run).resolves.toBe(true)
    expect(getAccessToken()).toBe('B1')
    await expect(stored()).resolves.toBe('dwr_b')
  })

  test('갱신 중에 로그아웃하면 늦게 온 성공이 세션을 되살리지 않는다', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const gate = deferred()
    setRefresher(() => gate.promise)
    const run = refreshSession()
    await clearSession('logout')
    gate.resolve({ access_token: 'A2', refresh_token: 'dwr_2' })
    await expect(run).resolves.toBe(false)
    expect(getAccessToken()).toBeNull()
    await expect(stored()).resolves.toBeNull()
  })

  test('갱신 중에 로그아웃하면 늦게 온 새 리프레시는 서버에서 폐기한다 (기다리지 않고, 저장하지 않는다)', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const gate = deferred()
    const discard = jest.fn(() => new Promise(() => {}))
    setRefresher(() => gate.promise, discard)
    const run = refreshSession()
    await clearSession('logout')
    gate.resolve({ access_token: 'A2', refresh_token: 'dwr_2' })
    await expect(run).resolves.toBe(false)
    expect(discard).toHaveBeenCalledTimes(1)
    expect(discard).toHaveBeenCalledWith('dwr_2')
    await expect(stored()).resolves.toBeNull()
  })

  test('폐기 호출이 던지거나 거절돼도 갱신 결과에는 영향이 없다', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const gate = deferred()
    setRefresher(() => gate.promise, () => Promise.reject(new Error('서버에 연결할 수 없습니다')))
    const run = refreshSession()
    await clearSession('logout')
    gate.resolve({ access_token: 'A2', refresh_token: 'dwr_2' })
    await expect(run).resolves.toBe(false)
    setRefresher(() => gate.promise, () => { throw new Error('boom') })
    await setSession({ access_token: 'B1', refresh_token: 'dwr_b' })
    const run2 = refreshSession()
    await clearSession('logout')
    await expect(run2).resolves.toBe(false)
  })

  test('늦게 온 거절이나 정상 갱신에는 폐기를 부르지 않는다', async () => {
    const discard = jest.fn()
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    setRefresher(async () => ({ access_token: 'A2', refresh_token: 'dwr_2' }), discard)
    await expect(refreshSession()).resolves.toBe(true)
    setRefresher(async () => { throw httpError(401) }, discard)
    await expect(refreshSession()).resolves.toBe(false)
    expect(discard).not.toHaveBeenCalled()
  })

  test('원문이 없는 웹 응답은 다시 로그인한 세션이 있으면 폐기하지 않는다 (쿠키를 건드리지 않게)', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const gate = deferred()
    const discard = jest.fn()
    setRefresher(() => gate.promise, discard)
    const run = refreshSession()
    await setSession({ access_token: 'B1', refresh_token: 'dwr_b' })
    gate.resolve({ access_token: 'A2' })
    await expect(run).resolves.toBe(true)
    expect(discard).not.toHaveBeenCalled()
    expect(getAccessToken()).toBe('B1')
  })

  test('액세스 토큰이 없는 갱신 응답은 거절과 같다: 로그인 상태였으면 expired', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const seen = []
    subscribeSession((state) => seen.push(state))
    setRefresher(async () => ({ refresh_token: 'dwr_2' }))
    await expect(refreshSession()).resolves.toBe(false)
    expect(getSessionStatus()).toBe('signed_out')
    expect(seen).toEqual([expect.objectContaining({ status: 'signed_out', reason: 'expired' })])
    await expect(stored()).resolves.toBeNull()
  })

  test('액세스 토큰이 없는 갱신 응답: 첫 확인 중이면 조용히 signed_out, 받은 리프레시는 저장하지 않는다', async () => {
    await SecureStore.setItemAsync(REFRESH_KEY, 'dwr_old')
    const seen = []
    subscribeSession((state) => seen.push(state))
    setRefresher(async () => ({ access_token: '', refresh_token: 'dwr_new' }))
    await expect(refreshSession()).resolves.toBe(false)
    expect(getSessionStatus()).toBe('signed_out')
    expect(seen).toEqual([{ status: 'signed_out', user: null, storageWarning: false }])
    await Promise.resolve()
    await expect(stored()).resolves.toBeNull()
  })

  test('갱신기가 없으면 false, 상태는 그대로', async () => {
    await expect(refreshSession()).resolves.toBe(false)
    expect(getSessionStatus()).toBe('unknown')
  })
})

describe('markBooted', () => {
  test('unknown 일 때만 정한다 - 토큰이 없으면 signed_in 이 되지 않는다', () => {
    markBooted('signed_in')
    expect(getSessionStatus()).toBe('signed_out')
    markBooted('signed_in')
    expect(getSessionStatus()).toBe('signed_out')
  })
})
