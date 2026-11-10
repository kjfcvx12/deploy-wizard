import { AppState, StyleSheet, Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Notifications from 'expo-notifications'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native'
import { deviceApi, notificationApi } from '../api'
import NotificationSettings from '../../app/notification-settings'
import { NOTIFICATION_KINDS } from '../ops/constants'

const mockBack = jest.fn()
const mockReplace = jest.fn()
let mockCanGoBack = true
const mockConstants = { expoConfig: { extra: { eas: { projectId: 'proj-1' } } } }
jest.mock('expo-constants', () => ({ __esModule: true, get default() { return mockConstants } }))
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, replace: mockReplace, canGoBack: () => mockCanGoBack }),
  Stack: { Screen: () => null },
}))
jest.mock('../api', () => ({
  notificationApi: { getSettings: jest.fn(), patchSettings: jest.fn() },
  deviceApi: { register: jest.fn(), remove: jest.fn() },
}))

const TOKEN = 'ExponentPushToken[abc-SECRET-xyz789]'
const UNDETERMINED = { status: 'undetermined', granted: false, canAskAgain: true }
const GRANTED = { status: 'granted', granted: true, canAskAgain: true }
const DENIED = { status: 'denied', granted: false, canAskAgain: false }
const ALL = [...NOTIFICATION_KINDS]
const settings = (over = {}) => ({ notify_email: true, notify_push: false, kinds: ALL, ...over })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let consoleSpies
let foreground
beforeEach(async () => {
  jest.useFakeTimers()
  await AsyncStorage.clear()
  mockBack.mockReset()
  mockReplace.mockReset()
  mockCanGoBack = true
  mockConstants.expoConfig = { extra: { eas: { projectId: 'proj-1' } } }
  notificationApi.getSettings.mockReset().mockResolvedValue(settings())
  notificationApi.patchSettings.mockReset().mockImplementation(async (body) => ({ ...settings(), ...body }))
  deviceApi.register.mockReset().mockResolvedValue({ p_d_id: 4 })
  deviceApi.remove.mockReset().mockResolvedValue({})
  Notifications.getPermissionsAsync.mockReset().mockResolvedValue(UNDETERMINED)
  Notifications.requestPermissionsAsync.mockReset().mockResolvedValue(GRANTED)
  Notifications.getExpoPushTokenAsync.mockReset().mockResolvedValue({ data: TOKEN })
  foreground = null
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    foreground = handler
    return { remove: jest.fn() }
  })
  consoleSpies = ['log', 'info', 'warn', 'error'].map((k) => jest.spyOn(console, k))
})

afterEach(() => {
  const noisy = consoleSpies.flatMap((spy) => spy.mock.calls)
  jest.useRealTimers()
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

const open = async (loaded = settings()) => {
  notificationApi.getSettings.mockResolvedValue(loaded)
  const view = await render(<NotificationSettings />)
  await screen.findByRole('switch', { name: '메일 받기' })
  return view
}
const row = (name) => screen.getByRole('switch', { name })
const checked = (name) => row(name).props.accessibilityState.checked
const flush = async () => { await act(async () => {}) }

describe('알림 설정 - 처음 값', () => {
  test('서버 값을 그대로 보여 주고 설정은 한 번만 받는다 (메일 설명 문구 포함)', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(GRANTED)
    await AsyncStorage.setItem('dw-push-device', '4')
    await open(settings({ notify_email: false, notify_push: true, kinds: ['deploy_failed', 'new_commit'] }))
    expect(checked('메일 받기')).toBe(false)
    expect(checked('푸시 받기')).toBe(true)
    expect(checked('배포 실패 알림')).toBe(true)
    expect(checked('새 커밋 알림')).toBe(true)
    expect(checked('문제 감지 알림')).toBe(false)
    expect(screen.getByText('서버에 메일 설정이 있을 때만 보내집니다')).toBeTruthy()
    expect(notificationApi.getSettings).toHaveBeenCalledTimes(1)
  })

  test('종류 스위치는 여섯 개이고 이름은 앱 상수와 같다', async () => {
    await open()
    for (const label of ['문제 감지', '복구 완료', '확인 필요', '배포 성공', '배포 실패', '새 커밋']) {
      expect(row(`${label} 알림`)).toBeTruthy()
    }
    expect(screen.getAllByRole('switch')).toHaveLength(8)
  })

  test('모르는 종류는 버린다', async () => {
    await open(settings({ kinds: ['deploy_failed', 'mystery'] }))
    expect(checked('배포 실패 알림')).toBe(true)
    expect(screen.getAllByRole('switch').filter((s) => s.props.accessibilityState.checked)).toHaveLength(2 /* 메일 + 배포 실패 */)
  })

  test('화면을 여는 것만으로는 권한·토큰·등록을 하지 않는다', async () => {
    await open()
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled()
    expect(deviceApi.register).not.toHaveBeenCalled()
    expect(notificationApi.patchSettings).not.toHaveBeenCalled()
  })

  test('불러오기 실패: 서버 메시지와 [다시 시도] [돌아가기], 다시 시도하면 화면이 나온다', async () => {
    notificationApi.getSettings.mockRejectedValueOnce(new Error('서버에 연결할 수 없습니다'))
    await render(<NotificationSettings />)
    expect(await screen.findByText('서버에 연결할 수 없습니다')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: '돌아가기' }))
    expect(mockBack).toHaveBeenCalledTimes(1)
    await fireEvent.press(screen.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findByRole('switch', { name: '메일 받기' })).toBeTruthy()
  })

  test('돌아갈 화면이 없으면 목록으로', async () => {
    mockCanGoBack = false
    notificationApi.getSettings.mockRejectedValueOnce(new Error('x'))
    await render(<NotificationSettings />)
    await fireEvent.press(await screen.findByRole('button', { name: '돌아가기' }))
    expect(mockReplace).toHaveBeenCalledWith('/')
  })

  test('가려진 사이에 닫히면 늦게 온 응답을 버린다', async () => {
    const d = deferred()
    notificationApi.getSettings.mockReturnValue(d.promise)
    const view = await render(<NotificationSettings />)
    await view.unmount()
    await act(async () => { d.resolve(settings()) })
  })
})

describe('알림 설정 - 메일·종류 스위치', () => {
  test('메일: 누르면 바로 바뀌고 {notify_email} 만 보내며 저장 안내가 잠시 보인다', async () => {
    await open()
    const pending = deferred()
    notificationApi.patchSettings.mockReturnValue(pending.promise)
    await fireEvent.press(row('메일 받기'))
    expect(checked('메일 받기')).toBe(false)
    expect(row('메일 받기').props.accessibilityState.busy).toBe(true)
    expect(notificationApi.patchSettings).toHaveBeenCalledWith({ notify_email: false })
    await act(async () => { pending.resolve({}) })
    expect(screen.getByText('저장했습니다')).toBeTruthy()
    expect(row('메일 받기').props.accessibilityState.busy).toBe(false)
    await act(async () => { jest.advanceTimersByTime(3500) })
    expect(screen.queryByText('저장했습니다')).toBeNull()
  })

  test('메일 실패: 이전 값으로 되돌리고 서버 메시지를 보인다', async () => {
    await open()
    notificationApi.patchSettings.mockRejectedValue(new Error('알림 설정을 저장하지 못했습니다'))
    await fireEvent.press(row('메일 받기'))
    expect(await screen.findByText('알림 설정을 저장하지 못했습니다')).toBeTruthy()
    expect(checked('메일 받기')).toBe(true)
    expect(screen.queryByText('저장했습니다')).toBeNull()
  })

  test('같은 스위치를 응답 전에 다시 눌러도 요청은 한 번', async () => {
    await open()
    const pending = deferred()
    notificationApi.patchSettings.mockReturnValue(pending.promise)
    await fireEvent.press(row('메일 받기'))
    await fireEvent.press(row('메일 받기'))
    expect(notificationApi.patchSettings).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve({}) })
  })

  test('종류 끄기: 남은 종류 전체를 서버 순서로 보낸다 (교체 방식)', async () => {
    await open()
    await fireEvent.press(row('복구 완료 알림'))
    expect(notificationApi.patchSettings).toHaveBeenCalledWith({ kinds: ALL.filter((k) => k !== 'incident_recovered') })
    expect(checked('복구 완료 알림')).toBe(false)
    await flush()
    // 다시 켜면 원래 자리에 들어간다
    await fireEvent.press(row('복구 완료 알림'))
    expect(notificationApi.patchSettings).toHaveBeenLastCalledWith({ kinds: ALL })
  })

  test('종류를 모두 꺼도 빈 목록을 보낸다', async () => {
    await open(settings({ kinds: ['new_commit'] }))
    await fireEvent.press(row('새 커밋 알림'))
    expect(notificationApi.patchSettings).toHaveBeenCalledWith({ kinds: [] })
  })

  test('종류 실패: 그 스위치만 되돌린다 (다른 값은 그대로)', async () => {
    await open()
    notificationApi.patchSettings.mockRejectedValue(new Error('모르는 종류입니다'))
    await fireEvent.press(row('배포 성공 알림'))
    expect(await screen.findByText('모르는 종류입니다')).toBeTruthy()
    expect(checked('배포 성공 알림')).toBe(true)
    expect(checked('메일 받기')).toBe(true)
  })

  test('종류 스위치는 한 묶음으로 잠긴다 - 응답 전에 다른 종류를 눌러도 보내지 않고, 끝나면 다시 눌린다', async () => {
    await open()
    const pending = deferred()
    notificationApi.patchSettings.mockReturnValue(pending.promise)
    await fireEvent.press(row('문제 감지 알림'))
    await fireEvent.press(row('배포 실패 알림'))
    expect(notificationApi.patchSettings).toHaveBeenCalledTimes(1)
    expect(checked('배포 실패 알림')).toBe(true)
    await act(async () => { pending.resolve({}) })
    notificationApi.patchSettings.mockResolvedValue({})
    await fireEvent.press(row('배포 실패 알림'))
    expect(notificationApi.patchSettings).toHaveBeenCalledTimes(2)
    expect(notificationApi.patchSettings).toHaveBeenLastCalledWith({ kinds: ALL.filter((k) => k !== 'incident_opened' && k !== 'deploy_failed') })
  })

  test('메일과 종류는 서로 잠그지 않는다', async () => {
    await open()
    const pending = deferred()
    notificationApi.patchSettings.mockReturnValueOnce(pending.promise)
    await fireEvent.press(row('메일 받기'))
    await fireEvent.press(row('배포 성공 알림'))
    expect(notificationApi.patchSettings).toHaveBeenCalledTimes(2)
    await act(async () => { pending.resolve({}) })
  })

  test('한 스위치의 저장 안내 타이머가 다른 스위치의 오류를 지우지 않는다 (B 가 느리게 실패)', async () => {
    await open()
    const slow = deferred()
    notificationApi.patchSettings.mockReturnValueOnce(slow.promise)
    await fireEvent.press(row('배포 성공 알림'))
    await fireEvent.press(row('메일 받기'))
    await flush()
    expect(screen.getByText('저장했습니다')).toBeTruthy()
    await act(async () => { jest.advanceTimersByTime(1000) })
    await act(async () => { slow.reject(new Error('모르는 종류입니다')) })
    expect(screen.getByText('모르는 종류입니다')).toBeTruthy()
    await act(async () => { jest.advanceTimersByTime(5000) })
    expect(screen.getByText('모르는 종류입니다')).toBeTruthy()
  })

  test('종류 섹션에 끈 종류는 앱 안 알림 목록에도 남지 않는다는 안내가 있다', async () => {
    await open()
    expect(screen.getByText('끈 종류는 앱 안 알림 목록에도 남지 않습니다')).toBeTruthy()
  })

  test('스위치는 이름·상태·설명이 접근성 요소에 있고 눌림 높이 44 이상', async () => {
    await open()
    const mail = row('메일 받기')
    expect(mail.props.accessibilityHint).toBe('서버에 메일 설정이 있을 때만 보내집니다')
    expect(StyleSheet.flatten(mail.props.style).minHeight).toBeGreaterThanOrEqual(44)
  })
})

describe('알림 설정 - 푸시', () => {
  test('끔→켬 (아직 안 물음): 눌러도 권한을 묻지 않고 안내만 보인다 - [알림 켜기] 에서 묻고 등록하고 서버 설정을 켠다', async () => {
    await open()
    await fireEvent.press(row('푸시 받기'))
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(checked('푸시 받기')).toBe(false)
    expect(screen.getByText(/문제가 생겼을 때 바로 알려드리려고 알림 권한이 필요합니다/)).toBeTruthy()

    await fireEvent.press(screen.getByRole('button', { name: '알림 켜기' }))
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1)
    expect(deviceApi.register).toHaveBeenCalledWith({ expo_token: TOKEN, platform: 'ios' })
    expect(notificationApi.patchSettings).toHaveBeenCalledWith({ notify_push: true })
    await waitFor(() => expect(checked('푸시 받기')).toBe(true))
    expect(screen.queryByText(/알림 권한이 필요합니다/)).toBeNull()
    expect(await AsyncStorage.getItem('dw-push-device')).toBe('4')
    expect(JSON.stringify(screen.toJSON())).not.toContain('SECRET')
  })

  test('[나중에]: 안내만 닫힌다 (아무것도 보내지 않는다)', async () => {
    await open()
    await fireEvent.press(row('푸시 받기'))
    await fireEvent.press(screen.getByRole('button', { name: '나중에' }))
    expect(screen.queryByText(/알림 권한이 필요합니다/)).toBeNull()
    expect(notificationApi.patchSettings).not.toHaveBeenCalled()
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
  })

  test('이미 허용된 기기: 스위치를 누르면 안내 없이 바로 등록하고 켠다 (OS 창 없음)', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(GRANTED)
    await open()
    await fireEvent.press(row('푸시 받기'))
    await waitFor(() => expect(checked('푸시 받기')).toBe(true))
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(deviceApi.register).toHaveBeenCalledTimes(1)
    expect(notificationApi.patchSettings).toHaveBeenCalledWith({ notify_push: true })
  })

  test('OS 창에서 거부: 켜지지 않고 서버 설정도 안 바뀌며 기기 설정 안내가 보인다', async () => {
    Notifications.requestPermissionsAsync.mockResolvedValue(DENIED)
    await open()
    await fireEvent.press(row('푸시 받기'))
    await fireEvent.press(screen.getByRole('button', { name: '알림 켜기' }))
    expect(await screen.findByText(/기기 설정/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '설정 열기' })).toBeTruthy()
    expect(checked('푸시 받기')).toBe(false)
    expect(deviceApi.register).not.toHaveBeenCalled()
    expect(notificationApi.patchSettings).not.toHaveBeenCalled()
  })

  test('이미 거부돼 있던 기기: 스위치를 누르면 거부 안내 (OS 창은 안 띄움)', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(DENIED)
    await open()
    await fireEvent.press(row('푸시 받기'))
    expect(screen.getByRole('button', { name: '설정 열기' })).toBeTruthy()
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
  })

  test('OS 설정에서 켜고 돌아오면 상태를 다시 읽는다', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(DENIED)
    await open()
    await fireEvent.press(row('푸시 받기'))
    expect(screen.getByRole('button', { name: '설정 열기' })).toBeTruthy()
    Notifications.getPermissionsAsync.mockResolvedValue(GRANTED)
    await act(async () => { foreground('background'); foreground('active') })
    expect(screen.queryByRole('button', { name: '설정 열기' })).toBeNull()
  })

  test('기기 등록 실패: 오류를 보이고 꺼진 채로 둔다 (서버 설정 안 바뀜, 토큰은 없음)', async () => {
    deviceApi.register.mockRejectedValue(Object.assign(new Error(`형식이 틀립니다 ${TOKEN}`), { status: 422 }))
    await open()
    await fireEvent.press(row('푸시 받기'))
    await fireEvent.press(screen.getByRole('button', { name: '알림 켜기' }))
    expect(await screen.findByText(/형식이 틀립니다/)).toBeTruthy()
    expect(JSON.stringify(screen.toJSON())).not.toContain('SECRET')
    expect(checked('푸시 받기')).toBe(false)
    expect(notificationApi.patchSettings).not.toHaveBeenCalled()
  })

  test('서버 설정 저장이 실패: 켜지지 않고 방금 한 기기 등록을 지운다', async () => {
    notificationApi.patchSettings.mockRejectedValue(new Error('저장하지 못했습니다'))
    await open()
    await fireEvent.press(row('푸시 받기'))
    await fireEvent.press(screen.getByRole('button', { name: '알림 켜기' }))
    expect(await screen.findByText('저장하지 못했습니다')).toBeTruthy()
    expect(checked('푸시 받기')).toBe(false)
    expect(deviceApi.remove).toHaveBeenCalledWith(4)
    expect(await AsyncStorage.getItem('dw-push-device')).toBeNull()
  })

  test('켬→끔: {notify_push:false} 를 보내고 성공하면 기기 등록을 지운다', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(GRANTED)
    await AsyncStorage.setItem('dw-push-device', '4')
    await open(settings({ notify_push: true }))
    await fireEvent.press(row('푸시 받기'))
    expect(notificationApi.patchSettings).toHaveBeenCalledWith({ notify_push: false })
    await waitFor(() => expect(deviceApi.remove).toHaveBeenCalledWith(4))
    expect(checked('푸시 받기')).toBe(false)
    expect(await AsyncStorage.getItem('dw-push-device')).toBeNull()
  })

  test('켬→끔 저장 실패: 켠 채로 되돌리고 기기 등록은 그대로', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(GRANTED)
    await AsyncStorage.setItem('dw-push-device', '4')
    await open(settings({ notify_push: true }))
    notificationApi.patchSettings.mockRejectedValue(new Error('저장하지 못했습니다'))
    await fireEvent.press(row('푸시 받기'))
    expect(await screen.findByText('저장하지 못했습니다')).toBeTruthy()
    expect(checked('푸시 받기')).toBe(true)
    expect(deviceApi.remove).not.toHaveBeenCalled()
    expect(await AsyncStorage.getItem('dw-push-device')).toBe('4')
  })

  test('끄기는 서버에 기기가 이미 없어도(404) 끝난다', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(GRANTED)
    await AsyncStorage.setItem('dw-push-device', '4')
    deviceApi.remove.mockRejectedValue(Object.assign(new Error('해당 id의 기기가 없습니다'), { status: 404 }))
    await open(settings({ notify_push: true }))
    await fireEvent.press(row('푸시 받기'))
    await waitFor(() => expect(deviceApi.remove).toHaveBeenCalled())
    expect(checked('푸시 받기')).toBe(false)
    expect(screen.queryByText('해당 id의 기기가 없습니다')).toBeNull()
  })

  test('켜는 중에 다시 눌러도 등록은 한 번', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(GRANTED)
    const pending = deferred()
    deviceApi.register.mockReturnValue(pending.promise)
    await open()
    await fireEvent.press(row('푸시 받기'))
    await fireEvent.press(row('푸시 받기'))
    expect(deviceApi.register).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve({ p_d_id: 4 }) })
    await waitFor(() => expect(checked('푸시 받기')).toBe(true))
  })
})

describe('알림 설정 - 이 환경에서 푸시를 못 쓸 때', () => {
  test('웹: 안내 한 줄이 처음부터 보이고, 켜려 해도 아무것도 하지 않는다 (메일·종류는 그대로 동작)', async () => {
    jest.replaceProperty(Platform, 'OS', 'web')
    await open()
    expect(screen.getByText(/푸시 알림을 쓸 수 없습니다/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '알림 켜기' })).toBeNull()
    await fireEvent.press(row('푸시 받기'))
    expect(checked('푸시 받기')).toBe(false)
    expect(notificationApi.patchSettings).not.toHaveBeenCalled()
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled()
    await fireEvent.press(row('메일 받기'))
    expect(notificationApi.patchSettings).toHaveBeenCalledWith({ notify_email: false })
  })

  test('프로젝트 연결 전(no_project): 스토어 빌드 준비 안내가 보이고 나머지는 동작', async () => {
    mockConstants.expoConfig = {}
    await open()
    expect(screen.getByText(/EAS 프로젝트/)).toBeTruthy()
    await fireEvent.press(row('푸시 받기'))
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(notificationApi.patchSettings).not.toHaveBeenCalled()
    await fireEvent.press(row('배포 실패 알림'))
    expect(notificationApi.patchSettings).toHaveBeenCalledWith({ kinds: ALL.filter((k) => k !== 'deploy_failed') })
  })

  test('서버 설정이 푸시 켬이어도 지원 안 하는 환경에서는 꺼진 것으로 보이고 아무것도 보내지 않는다', async () => {
    jest.replaceProperty(Platform, 'OS', 'web')
    await open(settings({ notify_push: true }))
    expect(checked('푸시 받기')).toBe(false)
    await fireEvent.press(row('푸시 받기'))
    expect(notificationApi.patchSettings).not.toHaveBeenCalled()
    expect(deviceApi.remove).not.toHaveBeenCalled()
  })
})

describe('알림 설정 - 푸시 스위치는 이 기기가 준비됐을 때만 켜져 보인다 (서버 값은 모든 기기 공통)', () => {
  test('처음 설치(서버 켬, 아직 안 물음, 등록 없음): 꺼져 보이고 아무것도 요청하지 않는다', async () => {
    await open(settings({ notify_push: true }))
    expect(checked('푸시 받기')).toBe(false)
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(notificationApi.patchSettings).not.toHaveBeenCalled()
  })

  test('처음 설치에서 눌러 켜기: 안내 -> 권한 -> 등록 뒤 켜져 보이고, 서버 값이 이미 켬이면 PATCH 를 보내지 않는다', async () => {
    await open(settings({ notify_push: true }))
    await fireEvent.press(row('푸시 받기'))
    expect(screen.getByText(/알림 권한이 필요합니다/)).toBeTruthy()
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByRole('button', { name: '알림 켜기' }))
    await waitFor(() => expect(checked('푸시 받기')).toBe(true))
    expect(deviceApi.register).toHaveBeenCalledTimes(1)
    expect(notificationApi.patchSettings).not.toHaveBeenCalled()
    expect(await AsyncStorage.getItem('dw-push-device')).toBe('4')
    expect(screen.queryByText(/알림 권한이 필요합니다/)).toBeNull()
  })

  test('서버 값이 꺼짐이면 등록 뒤 {notify_push:true} 를 보낸다 (기존 동작)', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(GRANTED)
    await open(settings({ notify_push: false }))
    await fireEvent.press(row('푸시 받기'))
    await waitFor(() => expect(checked('푸시 받기')).toBe(true))
    expect(notificationApi.patchSettings).toHaveBeenCalledWith({ notify_push: true })
  })

  test('거부됨(서버 켬): 꺼져 보이고 누르면 기기 설정 안내, 요청 없음', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(DENIED)
    await AsyncStorage.setItem('dw-push-device', '4')
    await open(settings({ notify_push: true }))
    expect(checked('푸시 받기')).toBe(false)
    await fireEvent.press(row('푸시 받기'))
    expect(screen.getByRole('button', { name: '설정 열기' })).toBeTruthy()
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(notificationApi.patchSettings).not.toHaveBeenCalled()
  })

  test('허용 + 등록 있음 + 서버 켬: 켜져 보인다', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(GRANTED)
    await AsyncStorage.setItem('dw-push-device', '4')
    await open(settings({ notify_push: true }))
    expect(checked('푸시 받기')).toBe(true)
  })

  test('허용인데 이 기기 등록이 없고 서버 켬: 꺼져 보이고, 누르면 안내 없이 등록만 하고 PATCH 는 없다', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(GRANTED)
    await open(settings({ notify_push: true }))
    expect(checked('푸시 받기')).toBe(false)
    await fireEvent.press(row('푸시 받기'))
    await waitFor(() => expect(checked('푸시 받기')).toBe(true))
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(deviceApi.register).toHaveBeenCalledTimes(1)
    expect(notificationApi.patchSettings).not.toHaveBeenCalled()
  })

  test('켜는 데 실패하면(서버 켬 상태) 그대로 꺼져 보이고 오류를 보인다', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(GRANTED)
    deviceApi.register.mockRejectedValue(new Error('서버에 연결할 수 없습니다'))
    await open(settings({ notify_push: true }))
    await fireEvent.press(row('푸시 받기'))
    expect(await screen.findByText('서버에 연결할 수 없습니다')).toBeTruthy()
    expect(checked('푸시 받기')).toBe(false)
    expect(notificationApi.patchSettings).not.toHaveBeenCalled()
  })

  test('켜져 보일 때 끄면 서버를 먼저 끄고 기기 등록을 지운 뒤 꺼져 보인다', async () => {
    Notifications.getPermissionsAsync.mockResolvedValue(GRANTED)
    await AsyncStorage.setItem('dw-push-device', '4')
    await open(settings({ notify_push: true }))
    await fireEvent.press(row('푸시 받기'))
    await waitFor(() => expect(deviceApi.remove).toHaveBeenCalledWith(4))
    expect(notificationApi.patchSettings).toHaveBeenCalledWith({ notify_push: false })
    expect(checked('푸시 받기')).toBe(false)
  })

  test('푸시 줄 아래에 "모든 기기에 적용" 안내가 있다', async () => {
    await open()
    expect(screen.getByText('이 설정은 모든 기기에 적용됩니다')).toBeTruthy()
  })
})
