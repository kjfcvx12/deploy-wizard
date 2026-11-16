import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Notifications from 'expo-notifications'
import { deviceApi } from '../api'
import {
  getPushState, requestAndRegister, unregister, routeFromNotificationResponse,
  readPushDevice, readCardDismissed, writeCardDismissed,
} from '../ops/push'

const mockConstants = { expoConfig: { extra: { eas: { projectId: 'proj-1' } } } }
jest.mock('expo-constants', () => ({ __esModule: true, get default() { return mockConstants } }))
jest.mock('../api', () => ({ deviceApi: { register: jest.fn(), remove: jest.fn() } }))

const TOKEN = 'ExponentPushToken[abc-SECRET-xyz789]'
const GRANTED = { status: 'granted', granted: true, canAskAgain: true }
const UNDETERMINED = { status: 'undetermined', granted: false, canAskAgain: true }
const DENIED = { status: 'denied', granted: false, canAskAgain: false }

// 콘솔 소리를 모아 토큰이 새는지 본다
let consoleSpies
beforeEach(async () => {
  await AsyncStorage.clear()
  mockConstants.expoConfig = { extra: { eas: { projectId: 'proj-1' } } }
  mockConstants.easConfig = undefined
  jest.replaceProperty(Platform, 'OS', 'android')
  deviceApi.register.mockReset().mockResolvedValue({ p_d_id: 5, platform: 'android', token_tail: 'yz789]' })
  deviceApi.remove.mockReset().mockResolvedValue({ message: 'ok' })
  Notifications.getPermissionsAsync.mockReset().mockResolvedValue(GRANTED)
  Notifications.requestPermissionsAsync.mockReset().mockResolvedValue(GRANTED)
  Notifications.getExpoPushTokenAsync.mockReset().mockResolvedValue({ type: 'expo', data: TOKEN })
  Notifications.setNotificationChannelAsync.mockReset().mockResolvedValue(null)
  consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((k) => jest.spyOn(console, k))
})

afterEach(() => {
  const noisy = consoleSpies.flatMap((spy) => spy.mock.calls)
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

describe('getPushState', () => {
  test.each([
    ['허용됨', GRANTED, 'granted'],
    ['아직 묻지 않음', UNDETERMINED, 'undetermined'],
    ['거부(다시 물을 수 없음)', DENIED, 'denied'],
    ['한 번 거부했지만 다시 물을 수 있음', { status: 'denied', granted: false, canAskAgain: true }, 'undetermined'],
  ])('%s', async (_name, permission, expected) => {
    Notifications.getPermissionsAsync.mockResolvedValue(permission)
    expect(await getPushState()).toBe(expected)
  })

  test('웹은 권한을 묻지도 않고 unsupported', async () => {
    jest.replaceProperty(Platform, 'OS', 'web')
    expect(await getPushState()).toBe('unsupported')
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled()
  })

  test('EAS 프로젝트 id 가 없으면 no_project (권한도 묻지 않는다)', async () => {
    mockConstants.expoConfig = { extra: {} }
    expect(await getPushState()).toBe('no_project')
    mockConstants.expoConfig = null
    expect(await getPushState()).toBe('no_project')
    mockConstants.expoConfig = { extra: { eas: { projectId: '' } } }
    expect(await getPushState()).toBe('no_project')
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled()
  })

  test('권한 조회가 던지면 unsupported 로 본다 (던지지 않는다)', async () => {
    Notifications.getPermissionsAsync.mockRejectedValue(new Error('native module missing'))
    expect(await getPushState()).toBe('unsupported')
  })

  test('상태만 읽는다 - 권한 요청·토큰·등록을 부르지 않는다', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(UNDETERMINED)
    await getPushState()
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled()
    expect(deviceApi.register).not.toHaveBeenCalled()
  })
})

describe('requestAndRegister', () => {
  test('아직 묻지 않았으면 권한을 묻고, 토큰을 프로젝트 id 로 받아 {expo_token, platform} 만 보낸다', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(UNDETERMINED)
    expect(await requestAndRegister()).toBe('granted')
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1)
    expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj-1' })
    expect(deviceApi.register).toHaveBeenCalledTimes(1)
    expect(deviceApi.register).toHaveBeenCalledWith({ expo_token: TOKEN, platform: 'android' })
    expect(await AsyncStorage.getItem('dw-push-device')).toBe('5')
    expect(await readPushDevice()).toBe(5)
  })

  test('이미 허용돼 있으면 다시 묻지 않는다', async () => {
    await requestAndRegister()
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
  })

  test('안드로이드는 알림 채널을 먼저 만들고 platform 은 android', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    const order = []
    Notifications.setNotificationChannelAsync.mockImplementation(async () => { order.push('channel'); return null })
    Notifications.getExpoPushTokenAsync.mockImplementation(async () => { order.push('token'); return { data: TOKEN } })
    await requestAndRegister()
    expect(order).toEqual(['channel', 'token'])
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('default', expect.objectContaining({ importance: 6 }))
    expect(deviceApi.register).toHaveBeenCalledWith({ expo_token: TOKEN, platform: 'android' })
  })

  test('채널 만들기가 실패해도 등록은 계속한다', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    Notifications.setNotificationChannelAsync.mockRejectedValue(new Error('x'))
    expect(await requestAndRegister()).toBe('granted')
    expect(deviceApi.register).toHaveBeenCalledTimes(1)
  })

  test('사용자가 거부하면 denied - 토큰도 등록도 하지 않는다', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(UNDETERMINED)
    Notifications.requestPermissionsAsync.mockResolvedValue({ status: 'denied', granted: false, canAskAgain: false })
    expect(await requestAndRegister()).toBe('denied')
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled()
    expect(deviceApi.register).not.toHaveBeenCalled()
    expect(await AsyncStorage.getItem('dw-push-device')).toBeNull()
  })

  test('이미 거부된 상태(다시 물을 수 없음)에서는 OS 창을 띄우지 않고 denied', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(DENIED)
    expect(await requestAndRegister()).toBe('denied')
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(deviceApi.register).not.toHaveBeenCalled()
  })

  test.each([['unsupported', 'web'], ['no_project', 'android']])('%s 는 권한도 토큰도 건드리지 않고 그 상태를 돌려준다', async (state, os) => {
    jest.replaceProperty(Platform, 'OS', os)
    if (state === 'no_project') mockConstants.expoConfig = {}
    Notifications.getPermissionsAsync.mockResolvedValue(UNDETERMINED)
    expect(await requestAndRegister()).toBe(state)
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled()
    expect(deviceApi.register).not.toHaveBeenCalled()
  })

  test('두 번째 호출은 같은 기기로 남는다 (같은 p_d_id, 저장소는 숫자 하나뿐, 옛 기기 지우기 없음)', async () => {
    await requestAndRegister()
    await requestAndRegister()
    expect(await readPushDevice()).toBe(5)
    expect(deviceApi.remove).not.toHaveBeenCalled()
    const keys = await AsyncStorage.getAllKeys()
    expect(keys).toEqual(['dw-push-device'])
  })

  test('동시에 두 번 눌러도 서버에는 한 번만 보낸다', async () => {
    let release
    deviceApi.register.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ p_d_id: 5 }) }))
    const a = requestAndRegister()
    const b = requestAndRegister()
    await new Promise((r) => setTimeout(r, 0))
    release()
    expect(await a).toBe('granted')
    expect(await b).toBe('granted')
    expect(deviceApi.register).toHaveBeenCalledTimes(1)
  })

  test('서버가 다른 p_d_id 를 돌려주면 새 번호를 저장하고 옛 기기를 지운다 (실패해도 무시)', async () => {
    await AsyncStorage.setItem('dw-push-device', '2')
    deviceApi.remove.mockRejectedValue(new Error('x'))
    await requestAndRegister()
    expect(await readPushDevice()).toBe(5)
    expect(deviceApi.remove).toHaveBeenCalledWith(2)
  })

  test('토큰을 받지 못하면 토큰 없는 한국어 오류, 등록 안 함', async () => {
    Notifications.getExpoPushTokenAsync.mockRejectedValue(new Error(`boom ${TOKEN}`))
    const error = await requestAndRegister().catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/[가-힣]/)
    expect(error.message).not.toContain('SECRET')
    expect(deviceApi.register).not.toHaveBeenCalled()
  })

  test('서버 오류 문장에 토큰이 섞여 와도 지워서 던진다 (상태코드는 유지)', async () => {
    deviceApi.register.mockRejectedValue(Object.assign(new Error(`형식 오류: ${TOKEN}`), { status: 422 }))
    const error = await requestAndRegister().catch((e) => e)
    expect(error.message).not.toContain('SECRET')
    expect(error.message).not.toContain('abc')
    expect(error.status).toBe(422)
    expect(await AsyncStorage.getItem('dw-push-device')).toBeNull()
  })

  test('서버 응답에 p_d_id 가 이상하면 저장하지 않고 오류', async () => {
    deviceApi.register.mockResolvedValue({ p_d_id: 'abc' })
    await expect(requestAndRegister()).rejects.toThrow()
    expect(await AsyncStorage.getItem('dw-push-device')).toBeNull()
  })

  test('토큰은 저장소 값·콘솔 어디에도 없다', async () => {
    await requestAndRegister()
    for (const key of await AsyncStorage.getAllKeys()) {
      expect(String(await AsyncStorage.getItem(key))).not.toContain('SECRET')
    }
    // 콘솔 검사는 afterEach 에서 한다
  })

  test('저장소가 막혀도 던지지 않는다 (등록은 성공)', async () => {
    AsyncStorage.setItem.mockRejectedValueOnce(new Error('blocked'))
    await expect(requestAndRegister()).resolves.toBe('granted')
  })
})

describe('unregister', () => {
  test('저장된 p_d_id 로 지우고 저장소를 비운다', async () => {
    await AsyncStorage.setItem('dw-push-device', '5')
    await unregister()
    expect(deviceApi.remove).toHaveBeenCalledWith(5)
    expect(await AsyncStorage.getItem('dw-push-device')).toBeNull()
  })

  test('저장된 기기가 없으면 서버를 부르지 않는다', async () => {
    await unregister()
    expect(deviceApi.remove).not.toHaveBeenCalled()
  })

  test('404 (서버에 이미 없음)와 오프라인이어도 던지지 않고 저장소를 비운다', async () => {
    for (const error of [Object.assign(new Error('해당 id의 기기가 없습니다'), { status: 404 }), new Error('서버에 연결할 수 없습니다')]) {
      await AsyncStorage.setItem('dw-push-device', '5')
      deviceApi.remove.mockRejectedValueOnce(error)
      await expect(unregister()).resolves.toBeUndefined()
      expect(await AsyncStorage.getItem('dw-push-device')).toBeNull()
    }
  })

  test('저장된 값이 이상하면 서버를 부르지 않고 비운다', async () => {
    await AsyncStorage.setItem('dw-push-device', '../x')
    await unregister()
    expect(deviceApi.remove).not.toHaveBeenCalled()
    expect(await AsyncStorage.getItem('dw-push-device')).toBeNull()
  })
})

describe('한 번 안내 카드 기억', () => {
  test('없으면 false, 저장하면 true, 저장소 오류는 삼킨다', async () => {
    expect(await readCardDismissed()).toBe(false)
    await writeCardDismissed()
    expect(await readCardDismissed()).toBe(true)
    expect(await AsyncStorage.getItem('dw-push-card-dismissed')).toBe('1')
    AsyncStorage.getItem.mockRejectedValueOnce(new Error('x'))
    expect(await readCardDismissed()).toBe(false)
    AsyncStorage.setItem.mockRejectedValueOnce(new Error('x'))
    await expect(writeCardDismissed()).resolves.toBeUndefined()
  })
})

describe('routeFromNotificationResponse', () => {
  const response = (data) => ({ notification: { request: { content: { data } } } })

  test.each([
    ['인시던트 링크', { link: 'deploywizard://incidents/7' }, { route: '/incidents/7', params: { i_id: '7' } }],
    ['배포 링크', { link: 'deploywizard://deploys/12' }, { route: '/deploys/12', params: { d_id: '12' } }],
    ['다른 스킴', { link: 'https://evil.example/deploys/1' }, null],
    ['허용 밖 경로', { link: 'deploywizard://accounts' }, null],
    ['쿼리가 붙음', { link: 'deploywizard://deploys/1?x=1' }, null],
    ['상위 경로 시도', { link: 'deploywizard://deploys/../accounts' }, null],
    ['link 가 숫자', { link: 7 }, null],
    ['link 가 객체', { link: { a: 1 } }, null],
    ['link 가 null', { link: null }, null],
    ['link 없음', {}, null],
    ['data 가 null', null, null],
    ['data 가 문자열', 'deploywizard://deploys/1', null],
  ])('%s', (_name, data, expected) => {
    expect(routeFromNotificationResponse(response(data))).toEqual(expected)
  })

  test.each([[null], [undefined], [{}], [{ notification: null }], [{ notification: { request: null } }], ['x'], [7]])('응답 모양이 이상하면 null (%p)', (value) => {
    expect(routeFromNotificationResponse(value)).toBeNull()
  })
})
