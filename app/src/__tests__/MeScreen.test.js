import { Alert, Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import * as Notifications from 'expo-notifications'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native'
import { authApi, deviceApi } from '../api'
import { googleSignOut } from '../auth/google'
import { getSessionStatus, resetSessionForTest, setSession } from '../auth/session'
import { installRefresher } from '../auth/AuthProvider'
import RootLayout from '../../app/_layout'

// 지금 경로의 세그먼트 - Stack 자리에 내 정보 화면을 그린다
let mockSegments = ['me']
const mockReplace = jest.fn()
const mockPush = jest.fn()
const mockSegmentListeners = new Set()
jest.mock('expo-router', () => {
  const { View } = require('react-native')
  const Stack = () => {
    const Me = require('../../app/me').default
    return mockSegments[0] === 'me' ? <Me /> : <View testID="elsewhere" />
  }
  Stack.Screen = () => null
  return {
    DarkTheme: { colors: {} },
    DefaultTheme: { colors: {} },
    ThemeProvider: ({ children }) => children,
    Stack,
    useRouter: () => ({ push: mockPush, replace: mockReplace }),
    useSegments: () => require('react').useSyncExternalStore(
      (fn) => { mockSegmentListeners.add(fn); return () => mockSegmentListeners.delete(fn) },
      () => mockSegments,
    ),
  }
})
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }))
jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  authApi: { getConfig: jest.fn(), loginGoogle: jest.fn(), refresh: jest.fn(), logout: jest.fn(), getMe: jest.fn(), deleteMe: jest.fn() },
  deviceApi: { register: jest.fn(), remove: jest.fn() },
}))
jest.mock('../auth/google', () => ({
  ...jest.requireActual('../auth/googleError'),
  googleSignIn: jest.fn(),
  googleSignOut: jest.fn(),
}))

const ON = { auth_required: true, login_available: true, platforms: ['web', 'android'], google_client_id_web: 'web-client-id', pat_default_days: 30, pat_max_days: 90 }
const OFF = { ...ON, auth_required: false }
const USER = { u_id: 1, email: 'me@example.com', name: '김마법', picture_url: 'https://lh3.example.com/photo.png' }
const TOKEN = { access_token: 'acc_SECRET_1', refresh_token: 'dwr_SECRET_1', token_type: 'bearer', expires_in: 900, user: USER }
const LOGOUT_TEXT = '로그아웃할까요? 이 기기의 푸시 알림 등록도 해제됩니다.'
const LOGOUT_FAILED = '서버에서 로그아웃하지 못했습니다. 연결되면 다시 로그아웃해 주세요.'
const httpError = (status, message) => Object.assign(new Error(message), { status })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// 호출 순서를 적는다 (목의 호출 순서 기록)
let order
// Google 로그아웃을 부른 순간의 저장소 상태
let atGoogle
let consoleSpies
beforeEach(async () => {
  resetSessionForTest()
  installRefresher()
  SecureStore.__reset()
  await AsyncStorage.clear()
  jest.replaceProperty(Platform, 'OS', 'android')
  mockSegments = ['me']
  mockReplace.mockReset()
  mockPush.mockReset()
  order = []
  authApi.getConfig.mockReset().mockResolvedValue(ON)
  authApi.refresh.mockReset().mockRejectedValue(httpError(401, '다시 로그인해 주세요'))
  authApi.logout.mockReset().mockImplementation(async () => { order.push('logout'); return { message: 'ok' } })
  deviceApi.remove.mockReset().mockImplementation(async () => { order.push('unregister'); return null })
  atGoogle = null
  googleSignOut.mockReset().mockImplementation(async () => {
    // 이 시점의 저장소 상태를 적어 둔다 (여기서 던지면 로그아웃이 삼키므로 테스트가 나중에 확인한다)
    order.push('google')
    atGoogle = {
      secure: SecureStore.__items().has('dw-refresh'),
      picked: await AsyncStorage.getItem('dw-picked-block'),
      device: await AsyncStorage.getItem('dw-push-device'),
    }
  })
  SecureStore.deleteItemAsync.mockImplementation(async (key) => { order.push('secure-clear'); SecureStore.__items().delete(key) })
  Notifications.addNotificationResponseReceivedListener.mockReset().mockImplementation(() => ({ remove: jest.fn() }))
  Notifications.getLastNotificationResponse.mockReset().mockReturnValue(null)
  consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((k) => jest.spyOn(console, k))
})

afterEach(() => {
  const noisy = consoleSpies.flatMap((spy) => spy.mock.calls)
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

// 로그인한 상태로 시작한다 - 보안 저장소에 리프레시, 기기 번호·고른 블록을 저장해 둔다
async function signedInStart(config = ON, user = USER) {
  authApi.getConfig.mockResolvedValue(config)
  await setSession({ ...TOKEN, user })
  await AsyncStorage.setItem('dw-push-device', '5')
  await AsyncStorage.setItem('dw-picked-block', '3')
  await AsyncStorage.setItem('dw-push-card-dismissed', '1')
  await render(<RootLayout />)
}

// 화면 트리에서 조건에 맞는 첫 노드
function findHost(node, test) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findHost(child, test)
      if (found) return found
    }
    return null
  }
  if (test(node)) return node
  return findHost(node.children, test)
}

// 확인 창의 버튼을 누른다
const alertButtons = () => Alert.alert.mock.calls[0][2]
const pressAlert = async (text) => act(async () => { alertButtons().find((b) => b.text === text).onPress?.() })

describe('내 정보 화면', () => {
  test('이름·이메일과 https 사진(장식)을 보인다, 알림 설정·MCP 안내·로그아웃·계정 삭제가 있다', async () => {
    await signedInStart()
    expect(await screen.findByText('김마법')).toBeTruthy()
    expect(screen.getByText('me@example.com')).toBeTruthy()
    expect(screen.getByText('MCP 개인 토큰은 웹의 내 정보에서 만듭니다.')).toBeTruthy()
    const json = JSON.stringify(screen.toJSON())
    expect(json).toContain('https://lh3.example.com/photo.png')
    // 사진은 장식 - 접근성 라벨이 없다
    const photo = findHost(screen.toJSON(), (node) => node.props?.source?.uri === 'https://lh3.example.com/photo.png')
    expect(photo).toBeTruthy()
    expect(photo.props.accessibilityLabel).toBeUndefined()
    expect(photo.props.alt).toBeUndefined()
    expect(photo.props.accessible).toBe(false)
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '계정 삭제' })).toBeTruthy()
    for (const secret of ['SECRET', 'dwr_']) expect(json).not.toContain(secret)
  })

  test('이름이 없으면 이메일만, https 가 아닌 사진 주소는 그리지 않는다', async () => {
    await signedInStart(ON, { u_id: 1, email: 'me@example.com', name: null, picture_url: 'http://insecure.example.com/p.png' })
    expect(await screen.findByText('me@example.com')).toBeTruthy()
    expect(screen.queryByText('김마법')).toBeNull()
    expect(JSON.stringify(screen.toJSON())).not.toContain('insecure.example.com')
  })

  test('알림 설정 → /notification-settings, 계정 삭제 → /delete-account', async () => {
    await signedInStart()
    await fireEvent.press(await screen.findByRole('button', { name: '알림 설정' }))
    expect(mockPush).toHaveBeenLastCalledWith('/notification-settings')
    await fireEvent.press(screen.getByRole('button', { name: '계정 삭제' }))
    expect(mockPush).toHaveBeenLastCalledWith('/delete-account')
  })

  test('로그아웃: 확인 창은 취소가 먼저이고 취소하면 아무것도 하지 않는다', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    await signedInStart()
    await fireEvent.press(await screen.findByRole('button', { name: '로그아웃' }))
    const [title, message, buttons] = Alert.alert.mock.calls[0]
    expect(`${title} ${message}`).toContain(LOGOUT_TEXT)
    expect(buttons[0].text).toBe('취소')
    expect(buttons[0].style).toBe('cancel')
    await pressAlert('취소')
    expect(deviceApi.remove).not.toHaveBeenCalled()
    expect(authApi.logout).not.toHaveBeenCalled()
    expect(getSessionStatus()).toBe('signed_in')
    expect(mockReplace).not.toHaveBeenCalled()
  })

  test('로그아웃 확인 뒤 순서: 기기 해제 → 서버 로그아웃 → 보안 저장소 비움 → 저장값 지움 → Google, 그리고 로그인 화면으로 한 번', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    await signedInStart()
    await fireEvent.press(await screen.findByRole('button', { name: '로그아웃' }))
    await pressAlert('로그아웃')
    await waitFor(() => expect(order).toContain('google'))
    expect(order).toEqual(['unregister', 'logout', 'secure-clear', 'google'])
    // Google 을 부를 때는 보안 저장소의 리프레시·고른 블록·기기 번호가 이미 없다
    expect(atGoogle).toEqual({ secure: false, picked: null, device: null })
    expect(getSessionStatus()).toBe('signed_out')
    // 기기 단위인 알림 안내 카드 닫음은 남는다
    expect(await AsyncStorage.getItem('dw-push-card-dismissed')).toBe('1')
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'))
    expect(mockReplace).toHaveBeenCalledTimes(1)
  })

  test('서버 로그아웃이 실패해도 나머지는 하고, 이 기기는 로그아웃되며 안내를 보인다', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    authApi.logout.mockImplementation(async () => { order.push('logout'); throw httpError(503, '일시적으로 사용할 수 없습니다') })
    await signedInStart()
    await fireEvent.press(await screen.findByRole('button', { name: '로그아웃' }))
    await pressAlert('로그아웃')
    expect(await screen.findByText(LOGOUT_FAILED)).toBeTruthy()
    expect(order).toEqual(['unregister', 'logout', 'secure-clear', 'google'])
    expect(getSessionStatus()).toBe('signed_out')
    // 안내가 보이는 동안 로그인 화면으로 튕겨 나가지 않는다
    expect(mockReplace).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByRole('button', { name: '로그인 화면으로' }))
    expect(mockReplace).toHaveBeenCalledTimes(1)
    expect(mockReplace).toHaveBeenCalledWith('/login')
  })

  test('로그아웃하는 동안 버튼이 비활성이고 두 번 눌러도 한 번만 한다', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    const pending = deferred()
    deviceApi.remove.mockImplementation(() => pending.promise)
    await signedInStart()
    await fireEvent.press(await screen.findByRole('button', { name: '로그아웃' }))
    await pressAlert('로그아웃')
    const busy = await screen.findByRole('button', { name: '로그아웃하는 중…' })
    expect(busy.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }))
    // 이미 열려 있던 확인 창의 버튼을 한 번 더 눌러도 새 로그아웃은 없다
    await act(async () => { alertButtons().find((b) => b.text === '로그아웃').onPress() })
    await act(async () => { pending.resolve(null) })
    await waitFor(() => expect(order).toContain('google'))
    expect(authApi.logout).toHaveBeenCalledTimes(1)
    expect(deviceApi.remove).toHaveBeenCalledTimes(1)
  })

  test('끔 모드의 로그아웃은 처음 화면(/)으로 간다', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    await signedInStart(OFF)
    await fireEvent.press(await screen.findByRole('button', { name: '로그아웃' }))
    await pressAlert('로그아웃')
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'))
    expect(mockReplace).toHaveBeenCalledTimes(1)
  })

  test('로그인하지 않은 끔 모드에서 열면 내용을 그리지 않고 처음 화면으로 보낸다', async () => {
    authApi.getConfig.mockResolvedValue(OFF)
    await render(<RootLayout />)
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'))
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull()
  })
})
