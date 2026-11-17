import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import * as Notifications from 'expo-notifications'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native'
import { authApi } from '../api'
import { googleSignIn, googleSignOut, Google_Sign_In_Error } from '../auth/google'
import { reRegisterIfGranted, unregister } from '../ops/push'
import { getAccessToken, getSessionStatus, resetSessionForTest } from '../auth/session'
import { AuthProvider, installRefresher, useAuth } from '../auth/AuthProvider'
import RootLayout from '../../app/_layout'

// 지금 경로의 세그먼트 - 레이아웃의 useSegments 가 돌려준다. ['login'] 이면 Stack 자리에 로그인 화면을 그린다
let mockSegments = ['login']
const mockReplace = jest.fn()
const mockPush = jest.fn()
// 테스트가 useAuth 값을 들여다보는 자리
let mockAuthProbe = null
jest.mock('expo-router', () => {
  const { View } = require('react-native')
  // 지금 세그먼트에 맞는 화면 - 로그인이면 실제 로그인 화면, 아니면 목록 자리
  const Stack = () => {
    const Login = require('../../app/login').default
    return mockSegments[0] === 'login' ? <Login /> : <View testID="home" />
  }
  Stack.Screen = () => null
  return {
    DarkTheme: { colors: {} },
    DefaultTheme: { colors: {} },
    ThemeProvider: ({ children }) => children,
    Stack,
    useRouter: () => ({ push: mockPush, replace: mockReplace }),
    useSegments: () => mockSegments,
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
// 웹 번들의 GIS 버튼 대신 - 누르면 credential 을 넘긴다
jest.mock('../auth/GoogleWebButton', () => {
  const { Pressable, Text } = require('react-native')
  return ({ clientId, onCredential }) => (
    <Pressable testID="gis-button" accessibilityLabel={`gis ${clientId}`} onPress={() => onCredential('idt-web')}><Text>GIS</Text></Pressable>
  )
})
jest.mock('../ops/push', () => ({
  ...jest.requireActual('../ops/push'),
  reRegisterIfGranted: jest.fn(),
  unregister: jest.fn(),
}))

const ON = { auth_required: true, login_available: true, platforms: ['web', 'android'], google_client_id_web: 'web-client-id', pat_default_days: 30, pat_max_days: 90 }
const OFF = { ...ON, auth_required: false }
const TOKEN = { access_token: 'acc_SECRET_1', refresh_token: 'dwr_SECRET_1', token_type: 'bearer', expires_in: 900, user: { u_id: 1, email: 'me@example.com', name: '나' } }
const BUTTON = 'Google 계정으로 로그인'
const httpError = (status, message) => Object.assign(new Error(message), { status })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let consoleSpies
beforeEach(async () => {
  resetSessionForTest()
  installRefresher()
  SecureStore.__reset()
  await AsyncStorage.clear()
  jest.replaceProperty(Platform, 'OS', 'android')
  mockSegments = ['login']
  mockReplace.mockReset()
  mockPush.mockReset()
  mockAuthProbe = null
  authApi.getConfig.mockReset().mockResolvedValue(ON)
  authApi.loginGoogle.mockReset().mockResolvedValue(TOKEN)
  authApi.refresh.mockReset().mockRejectedValue(httpError(401, '다시 로그인해 주세요'))
  authApi.logout.mockReset().mockResolvedValue({ message: 'ok' })
  googleSignIn.mockReset().mockResolvedValue({ idToken: 'idt' })
  googleSignOut.mockReset().mockResolvedValue(undefined)
  reRegisterIfGranted.mockReset().mockResolvedValue('skipped')
  unregister.mockReset().mockResolvedValue(undefined)
  Notifications.addNotificationResponseReceivedListener.mockReset().mockImplementation(() => ({ remove: jest.fn() }))
  Notifications.getLastNotificationResponse.mockReset().mockReturnValue(null)
  consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((k) => jest.spyOn(console, k))
})

afterEach(() => {
  const noisy = consoleSpies.flatMap((spy) => spy.mock.calls)
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

// 화면 어디에도 토큰·id_token 원문이 없다 (글·접근성 라벨)
const expectNoSecrets = () => {
  const json = JSON.stringify(screen.toJSON())
  // "idt" 는 borderWidth 같은 스타일 이름에도 들어 있어 글 조각("idt")으로 찾는다
  for (const secret of ['"idt"', 'SECRET', 'dwr_']) expect(json).not.toContain(secret)
}

describe('로그인 화면 (네이티브)', () => {
  test('버튼 -> Google 창 -> loginGoogle(idt, android) 한 번, 성공하면 목록으로 replace("/"), 푸시 다시 등록 한 번', async () => {
    await render(<RootLayout />)
    expect(await screen.findByText('Google 계정으로 로그인합니다. 허용된 계정만 들어올 수 있습니다.')).toBeTruthy()
    expect(screen.getByText('AWS 자동 배포 마법사')).toBeTruthy()
    const button = screen.getByRole('button', { name: BUTTON })
    await fireEvent.press(button)
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'))
    expect(googleSignIn).toHaveBeenCalledWith({ webClientId: 'web-client-id' })
    expect(authApi.loginGoogle).toHaveBeenCalledTimes(1)
    expect(authApi.loginGoogle).toHaveBeenCalledWith('idt', 'android')
    expect(reRegisterIfGranted).toHaveBeenCalledTimes(1)
    expect(getSessionStatus()).toBe('signed_in')
    expect(SecureStore.__items().get('dw-refresh')).toBe('dwr_SECRET_1')
    expect(mockReplace.mock.calls.every(([to]) => to === '/')).toBe(true)
    expectNoSecrets()
  })

  test('연타해도 Google 창과 로그인은 한 번, 진행 중에는 버튼이 비활성 + 로그인하는 중…', async () => {
    const pending = deferred()
    googleSignIn.mockReturnValue(pending.promise)
    await render(<RootLayout />)
    const button = await screen.findByRole('button', { name: BUTTON })
    await fireEvent.press(button)
    await fireEvent.press(button)
    const busy = screen.getByRole('button', { name: '로그인하는 중…' })
    expect(busy.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }))
    await fireEvent.press(busy)
    await act(async () => { pending.resolve({ idToken: 'idt' }) })
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'))
    expect(googleSignIn).toHaveBeenCalledTimes(1)
    expect(authApi.loginGoogle).toHaveBeenCalledTimes(1)
  })

  test('취소하면 아무 안내 없이 끝나고 다시 누를 수 있다', async () => {
    googleSignIn.mockResolvedValueOnce({ cancelled: true })
    await render(<RootLayout />)
    await fireEvent.press(await screen.findByRole('button', { name: BUTTON }))
    await waitFor(() => expect(screen.getByRole('button', { name: BUTTON }).props.accessibilityState).toEqual(expect.objectContaining({ disabled: false })))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(authApi.loginGoogle).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByRole('button', { name: BUTTON }))
    await waitFor(() => expect(authApi.loginGoogle).toHaveBeenCalledTimes(1))
  })

  test('403 이면 서버 문구를 맨 아래 자리에 보이고 로그인하지 않는다', async () => {
    authApi.loginGoogle.mockRejectedValue(httpError(403, '로그인이 허용된 계정이 아닙니다'))
    await render(<RootLayout />)
    await fireEvent.press(await screen.findByRole('button', { name: BUTTON }))
    expect(await screen.findByText('로그인이 허용된 계정이 아닙니다')).toBeTruthy()
    expect(getSessionStatus()).toBe('signed_out')
    expect(mockReplace).not.toHaveBeenCalled()
    expect(reRegisterIfGranted).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: BUTTON }).props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }))
  })

  test('Google 어댑터 오류는 정해진 한국어 문장만 보인다', async () => {
    googleSignIn.mockRejectedValue(new Google_Sign_In_Error('개발 빌드에서만 Google 로그인을 할 수 있습니다 (Expo Go 는 지원하지 않습니다)'))
    await render(<RootLayout />)
    await fireEvent.press(await screen.findByRole('button', { name: BUTTON }))
    expect(await screen.findByText('개발 빌드에서만 Google 로그인을 할 수 있습니다 (Expo Go 는 지원하지 않습니다)')).toBeTruthy()
  })

  test('푸시 다시 등록이 던져도 로그인은 성공한다', async () => {
    reRegisterIfGranted.mockRejectedValue(new Error('서버에 이 기기를 등록하지 못했습니다'))
    await render(<RootLayout />)
    await fireEvent.press(await screen.findByRole('button', { name: BUTTON }))
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'))
    expect(reRegisterIfGranted).toHaveBeenCalledTimes(1)
    expect(getSessionStatus()).toBe('signed_in')
    expect(screen.queryByText('서버에 이 기기를 등록하지 못했습니다')).toBeNull()
  })

  test('login_available:false 면 버튼 없이 설정 안내', async () => {
    authApi.getConfig.mockResolvedValue({ ...ON, login_available: false })
    await render(<RootLayout />)
    expect(await screen.findByText('이 서버는 아직 로그인이 설정되지 않았습니다 (GOOGLE_CLIENT_ID_WEB·AUTH_JWT_KEY).')).toBeTruthy()
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull()
    expect(screen.queryByText('로그인하지 않고 계속')).toBeNull()
  })

  test('끔 모드면 안내와 [로그인하지 않고 계속] (-> 목록), 버튼도 있다', async () => {
    authApi.getConfig.mockResolvedValue(OFF)
    await render(<RootLayout />)
    expect(await screen.findByText('로그인하지 않아도 쓸 수 있습니다. 로그인하면 내 정보와 개인 토큰을 관리할 수 있습니다.')).toBeTruthy()
    expect(screen.getByRole('button', { name: BUTTON })).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: '로그인하지 않고 계속' }))
    expect(mockReplace).toHaveBeenCalledWith('/')
  })

  test('지원하지 않는 기기(iOS)는 Google 창 없이 안내', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios')
    await render(<RootLayout />)
    await fireEvent.press(await screen.findByRole('button', { name: BUTTON }))
    expect(await screen.findByText('이 기기에서는 아직 로그인을 지원하지 않습니다')).toBeTruthy()
    expect(googleSignIn).not.toHaveBeenCalled()
    expect(authApi.loginGoogle).not.toHaveBeenCalled()
  })

  test('설정을 못 읽으면 연결 안내 + [다시 시도] 로 다시 읽는다', async () => {
    authApi.getConfig.mockRejectedValueOnce(new Error('서버에 연결할 수 없습니다'))
    await render(<RootLayout />)
    await fireEvent.press(await screen.findByRole('button', { name: '다시 시도' }))
    expect(await screen.findByRole('button', { name: BUTTON })).toBeTruthy()
    expect(authApi.getConfig).toHaveBeenCalledTimes(2)
  })
})

describe('로그인 화면 (웹 번들)', () => {
  test('GIS 버튼의 credential 로 loginGoogle(idt-web, web), googleSignIn 은 부르지 않는다', async () => {
    jest.replaceProperty(Platform, 'OS', 'web')
    // 웹 번들은 쿠키라 본문에 리프레시가 없다
    authApi.loginGoogle.mockResolvedValue({ ...TOKEN, refresh_token: null })
    authApi.refresh.mockRejectedValue(httpError(401, '다시 로그인해 주세요'))
    await render(<RootLayout />)
    await fireEvent.press(await screen.findByTestId('gis-button'))
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'))
    expect(authApi.loginGoogle).toHaveBeenCalledWith('idt-web', 'web')
    expect(googleSignIn).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull()
  })
})

describe('경로 보호 (루트 레이아웃)', () => {
  test('로그인 필요 + 저장된 리프레시 없음 -> 갱신 없이 replace("/login"), 알림 탭은 이동하지 않는다', async () => {
    mockSegments = []
    await render(<RootLayout />)
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'))
    expect(authApi.refresh).not.toHaveBeenCalled()
    const listener = Notifications.addNotificationResponseReceivedListener.mock.calls[0][0]
    listener({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', notification: { request: { identifier: 'n1', content: { data: { link: 'deploywizard://deploys/3' } } } } })
    expect(mockPush).not.toHaveBeenCalled()
  })

  test('저장된 리프레시로 시작 갱신 -> 그 원문을 보내고 화면을 보인다 (로그인으로 보내지 않는다)', async () => {
    mockSegments = []
    await SecureStore.setItemAsync('dw-refresh', 'dwr_SECRET_0')
    authApi.refresh.mockResolvedValue(TOKEN)
    await render(<RootLayout />)
    await waitFor(() => expect(getSessionStatus()).toBe('signed_in'))
    expect(authApi.refresh).toHaveBeenCalledWith('dwr_SECRET_0')
    expect(screen.getByTestId('home')).toBeTruthy()
    expect(screen.queryByText('불러오는 중…')).toBeNull()
    expect(mockReplace).not.toHaveBeenCalled()
    expect(getAccessToken()).toBe('acc_SECRET_1')
  })

  test('로그인 필요 + 시작 갱신이 연결 실패 -> 연결 안내 + 다시 시도 (로그인으로 보내지 않는다)', async () => {
    mockSegments = []
    await SecureStore.setItemAsync('dw-refresh', 'dwr_SECRET_0')
    authApi.refresh.mockRejectedValueOnce(new Error('서버에 연결할 수 없습니다')).mockResolvedValue(TOKEN)
    await render(<RootLayout />)
    expect(await screen.findByText('서버에 연결할 수 없습니다')).toBeTruthy()
    expect(mockReplace).not.toHaveBeenCalled()
    expect(getSessionStatus()).toBe('unknown')
    await fireEvent.press(screen.getByRole('button', { name: '다시 시도' }))
    await waitFor(() => expect(getSessionStatus()).toBe('signed_in'))
    expect(screen.queryByText('서버에 연결할 수 없습니다')).toBeNull()
  })

  test('끔 모드 + 로그인 불가 + 저장된 세션 없음 -> 지금처럼: 갱신·이동 없이 화면을 보인다', async () => {
    mockSegments = []
    authApi.getConfig.mockResolvedValue({ ...OFF, login_available: false })
    await render(<RootLayout />)
    await waitFor(() => expect(getSessionStatus()).toBe('signed_out'))
    expect(screen.getByTestId('home')).toBeTruthy()
    expect(screen.queryByText('불러오는 중…')).toBeNull()
    expect(authApi.refresh).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  test('로그인 확인 전에는 불러오는 중… 을 덮어 보이고, 정해지기 전 들어온 알림 탭은 허용된 뒤 이동한다', async () => {
    mockSegments = []
    const config = deferred()
    authApi.getConfig.mockReturnValue(config.promise)
    await render(<RootLayout />)
    expect(screen.getByText('불러오는 중…')).toBeTruthy()
    const listener = Notifications.addNotificationResponseReceivedListener.mock.calls[0][0]
    listener({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', notification: { request: { identifier: 'n1', content: { data: { link: 'deploywizard://deploys/3' } } } } })
    expect(mockPush).not.toHaveBeenCalled()
    await act(async () => { config.resolve(OFF) })
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/deploys/3'))
    expect(mockPush).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('불러오는 중…')).toBeNull()
  })

  test('로그인한 적 없는 상태에서 401 신호를 받으면 설정을 다시 읽고 로그인으로 간다', async () => {
    mockSegments = []
    authApi.getConfig.mockResolvedValueOnce(OFF).mockResolvedValue(ON)
    const api = jest.requireActual('../api')
    await render(<RootLayout />)
    await waitFor(() => expect(getSessionStatus()).toBe('signed_out'))
    expect(mockReplace).not.toHaveBeenCalled()
    // 실제 request 가 토큰 없이 401 을 받는 경우 - fetch 를 가짜로
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401, json: async () => ({ detail: '로그인이 필요합니다' }) })
    await act(async () => { await api.request('/api/deploys').catch(() => {}) })
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'))
    expect(authApi.getConfig).toHaveBeenCalledTimes(2)
    fetchSpy.mockRestore()
    api.resetUnauthorizedForTest()
  })
})

describe('로그아웃 (AuthProvider.signOut)', () => {
  // 화면 대신 useAuth 를 붙잡는 작은 자리
  const Probe = () => {
    mockAuthProbe = useAuth()
    return null
  }

  test('순서: 기기 해제 -> 서버 로그아웃(저장된 원문) -> 세션·보안 저장소 비움 -> 고른 블록 지움 -> Google 로그아웃 -> /login', async () => {
    mockSegments = []
    await SecureStore.setItemAsync('dw-refresh', 'dwr_SECRET_0')
    await AsyncStorage.setItem('dw-picked-block', '3')
    authApi.refresh.mockResolvedValue(TOKEN)
    const order = []
    unregister.mockImplementation(async () => { order.push(`unregister:${getAccessToken() ? 'token' : 'none'}`) })
    authApi.logout.mockImplementation(async (rt) => { order.push(`logout:${rt}`) })
    googleSignOut.mockImplementation(async () => { order.push(`google:${SecureStore.__items().has('dw-refresh') ? 'stored' : 'empty'}:${await AsyncStorage.getItem('dw-picked-block')}`) })
    await render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(getSessionStatus()).toBe('signed_in'))
    let result
    await act(async () => { result = await mockAuthProbe.signOut() })
    expect(result).toEqual({ serverLoggedOut: true })
    expect(order).toEqual(['unregister:token', 'logout:dwr_SECRET_1', 'google:empty:null'])
    expect(getSessionStatus()).toBe('signed_out')
    expect(mockReplace).toHaveBeenLastCalledWith('/login')
  })

  test('서버 로그아웃이 실패해도 이 기기에서는 끝내고 serverLoggedOut:false, 끔 모드는 "/" 로', async () => {
    // 내 정보 화면에서 로그아웃한 경우
    mockSegments = ['me']
    authApi.getConfig.mockResolvedValue(OFF)
    await SecureStore.setItemAsync('dw-refresh', 'dwr_SECRET_0')
    authApi.refresh.mockResolvedValue(TOKEN)
    authApi.logout.mockRejectedValue(new Error('서버에 연결할 수 없습니다'))
    await render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(getSessionStatus()).toBe('signed_in'))
    let result
    await act(async () => { result = await mockAuthProbe.signOut() })
    expect(result).toEqual({ serverLoggedOut: false })
    expect(getSessionStatus()).toBe('signed_out')
    expect(SecureStore.__items().has('dw-refresh')).toBe(false)
    expect(googleSignOut).toHaveBeenCalledTimes(1)
    expect(mockReplace).toHaveBeenLastCalledWith('/')
  })
})
