import { Alert, Platform, StyleSheet } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import * as Notifications from 'expo-notifications'
import * as Clipboard from 'expo-clipboard'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native'
import { authApi, deviceApi } from '../api'
import { googleSignOut } from '../auth/google'
import { getSessionStatus, resetSessionForTest, setSession, subscribeSession } from '../auth/session'
import { installRefresher } from '../auth/AuthProvider'
import RootLayout from '../../app/_layout'

// 지금 경로의 세그먼트 - Stack 자리에 계정 삭제 화면(또는 로그인 화면)을 그린다
let mockSegments = ['delete-account']
const mockReplace = jest.fn()
const mockPush = jest.fn()
const mockSegmentListeners = new Set()
jest.mock('expo-router', () => {
  const { View } = require('react-native')
  const Stack = () => {
    if (mockSegments[0] === 'delete-account') {
      const Delete = require('../../app/delete-account').default
      return <Delete />
    }
    return <View testID="elsewhere" />
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
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }))
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
const USER = { u_id: 1, email: 'me@example.com', name: '김마법', picture_url: null }
const TOKEN = { access_token: 'acc_SECRET_1', refresh_token: 'dwr_SECRET_1', token_type: 'bearer', expires_in: 900, user: USER }
const DESCRIPTION = '계정과 이 마법사의 기록(배포 기록·연결·알림)을 지웁니다. AWS 의 서비스·CloudFormation 스택·ECR 이미지와 GitHub 앱 설치는 지우지 않습니다. 되돌릴 수 없습니다.'
const LIVE_TEXT = '먼저 멈추거나 삭제해야 하는 서비스가 있습니다: #3 my-app, #5 other'
const ECR_GUIDE = 'AWS 콘솔의 ECR 에서 직접 지워 주세요. 요금이 나갈 수 있습니다.'
const DONE = { message: '계정과 이 마법사의 기록을 지웠습니다. AWS 리소스는 건드리지 않았습니다.', leftover_ecr_repositories: ['deploy-wizard/app-a', 'deploy-wizard/app-b'] }
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
  mockSegments = ['delete-account']
  mockReplace.mockReset()
  mockPush.mockReset()
  authApi.getConfig.mockReset().mockResolvedValue(ON)
  authApi.refresh.mockReset().mockRejectedValue(httpError(401, '다시 로그인해 주세요'))
  authApi.logout.mockReset().mockResolvedValue({ message: 'ok' })
  authApi.deleteMe.mockReset().mockResolvedValue(DONE)
  deviceApi.remove.mockReset().mockResolvedValue(null)
  googleSignOut.mockReset().mockResolvedValue(undefined)
  Clipboard.setStringAsync.mockReset().mockResolvedValue(true)
  Notifications.addNotificationResponseReceivedListener.mockReset().mockImplementation(() => ({ remove: jest.fn() }))
  Notifications.getLastNotificationResponse.mockReset().mockReturnValue(null)
  jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((k) => jest.spyOn(console, k))
})

afterEach(() => {
  const noisy = consoleSpies.flatMap((spy) => spy.mock.calls)
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

// 로그인한 상태로 시작한다 - 보안 저장소에 리프레시, 기기 번호·고른 블록을 저장해 둔다
async function signedInStart(config = ON) {
  authApi.getConfig.mockResolvedValue(config)
  await setSession(TOKEN)
  await AsyncStorage.setItem('dw-push-device', '5')
  await AsyncStorage.setItem('dw-picked-block', '3')
  await render(<RootLayout />)
}

// 확인 창의 버튼을 누른다 (가장 최근에 뜬 창)
const lastButtons = () => Alert.alert.mock.calls[Alert.alert.mock.calls.length - 1][2]
const pressAlert = async (text) => act(async () => { lastButtons().find((b) => b.text === text).onPress?.() })
// 계정 삭제 버튼 → 확인 창의 삭제까지
async function confirmDelete() {
  await fireEvent.press(await screen.findByRole('button', { name: '계정 삭제' }))
  await pressAlert('삭제')
}

describe('계정 삭제 화면', () => {
  test('설명에 AWS 는 건드리지 않고 남는 것(스택·ECR·GitHub 앱)이 적혀 있다, 서비스를 멈추거나 지우는 버튼은 없다', async () => {
    await signedInStart()
    expect(await screen.findByText(DESCRIPTION)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /멈추|지우기|서비스 삭제/ })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  test('확인 창은 취소가 먼저이고, 취소하면 계정 삭제 요청을 보내지 않는다', async () => {
    await signedInStart()
    await fireEvent.press(await screen.findByRole('button', { name: '계정 삭제' }))
    const [title, message, buttons] = Alert.alert.mock.calls[0]
    expect(title).toBe('계정을 삭제할까요?')
    expect(message).toBe(DESCRIPTION)
    expect(buttons.map((b) => b.text)).toEqual(['취소', '삭제'])
    expect(buttons[0].style).toBe('cancel')
    await pressAlert('취소')
    expect(authApi.deleteMe).not.toHaveBeenCalled()
    expect(getSessionStatus()).toBe('signed_in')
  })

  test('버튼을 누르는 것만으로는 삭제 요청이 나가지 않는다 (확인 창 없이는 삭제 경로가 없다)', async () => {
    await signedInStart()
    await fireEvent.press(await screen.findByRole('button', { name: '계정 삭제' }))
    expect(authApi.deleteMe).not.toHaveBeenCalled()
  })

  test('409: 살아 있는 서비스 항목이 링크로 나오고, 누르면 그 상세로 간다. 세션·저장값은 그대로, 삭제는 하지 않는다', async () => {
    authApi.deleteMe.mockRejectedValue(httpError(409, LIVE_TEXT))
    await signedInStart()
    await confirmDelete()
    expect(await screen.findByText('먼저 멈추거나 삭제해야 하는 서비스가 있습니다')).toBeTruthy()
    const first = screen.getByRole('button', { name: '#3 my-app' })
    const second = screen.getByRole('button', { name: '#5 other' })
    expect(screen.getByText('먼저 이 서비스들을 멈추거나 삭제한 뒤 다시 시도하세요.')).toBeTruthy()
    // 눌림 높이 44pt 이상
    expect(StyleSheet.flatten(first.props.style).minHeight).toBeGreaterThanOrEqual(44)
    await fireEvent.press(first)
    expect(mockPush).toHaveBeenCalledWith('/deploys/3')
    await fireEvent.press(second)
    expect(mockPush).toHaveBeenLastCalledWith('/deploys/5')
    expect(getSessionStatus()).toBe('signed_in')
    expect(deviceApi.remove).not.toHaveBeenCalled()
    expect(await AsyncStorage.getItem('dw-push-device')).toBe('5')
    expect(await AsyncStorage.getItem('dw-picked-block')).toBe('3')
    expect(googleSignOut).not.toHaveBeenCalled()
    // 다시 시도할 수 있다
    expect(screen.getByRole('button', { name: '계정 삭제' }).props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }))
  })

  test('409 문구가 정해진 모양이 아니면 항목 없이 원문 그대로', async () => {
    authApi.deleteMe.mockRejectedValue(httpError(409, '다른 작업이 진행 중입니다'))
    await signedInStart()
    await confirmDelete()
    expect(await screen.findByText('다른 작업이 진행 중입니다')).toBeTruthy()
    expect(screen.queryByText('먼저 이 서비스들을 멈추거나 삭제한 뒤 다시 시도하세요.')).toBeNull()
    expect(mockPush).not.toHaveBeenCalled()
  })

  test.each([
    [403, '개인 토큰으로는 계정을 삭제할 수 없습니다'],
    [503, '지금은 계정을 삭제할 수 없습니다. 잠시 뒤 다시 시도해 주세요'],
    [500, '서버 내부 오류가 났습니다'],
  ])('%s 는 서버 문구 그대로, 세션은 그대로', async (status, text) => {
    authApi.deleteMe.mockRejectedValue(httpError(status, text))
    await signedInStart()
    await confirmDelete()
    expect(await screen.findByText(text)).toBeTruthy()
    expect(getSessionStatus()).toBe('signed_in')
    expect(deviceApi.remove).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  test('연결이 안 되면 그 문구를 보이고 다시 누를 수 있다', async () => {
    authApi.deleteMe.mockRejectedValueOnce(new Error('서버에 연결할 수 없습니다'))
    await signedInStart()
    await confirmDelete()
    expect(await screen.findByText('서버에 연결할 수 없습니다')).toBeTruthy()
    await confirmDelete()
    expect(await screen.findByText('계정을 삭제했습니다')).toBeTruthy()
    expect(authApi.deleteMe).toHaveBeenCalledTimes(2)
  })

  test('진행 중에는 버튼이 비활성(삭제하는 중…)이고 확인 창을 한 번 더 눌러도 요청은 한 번', async () => {
    const pending = deferred()
    authApi.deleteMe.mockReturnValue(pending.promise)
    await signedInStart()
    await confirmDelete()
    const busy = await screen.findByRole('button', { name: '삭제하는 중…' })
    expect(busy.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }))
    await act(async () => { lastButtons().find((b) => b.text === '삭제').onPress() })
    await fireEvent.press(busy)
    expect(authApi.deleteMe).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve(DONE) })
    expect(await screen.findByText('계정을 삭제했습니다')).toBeTruthy()
    expect(authApi.deleteMe).toHaveBeenCalledTimes(1)
  })

  test('200: 결과(서버 문구·ECR 저장소 이름·안내)가 세션이 지워진 뒤에도 남고, 기기 번호·저장값·Google 은 정리된다', async () => {
    await signedInStart()
    // 세션이 지워지는 순간 결과가 이미 화면에 있는지 적어 둔다
    const seenWhenCleared = []
    const stop = subscribeSession((state) => {
      if (state.status === 'signed_out') seenWhenCleared.push(screen.queryByText('계정을 삭제했습니다') !== null)
    })
    await confirmDelete()
    expect(await screen.findByText('계정을 삭제했습니다')).toBeTruthy()
    expect(screen.getByText(DONE.message)).toBeTruthy()
    for (const name of DONE.leftover_ecr_repositories) expect(screen.getByText(name)).toBeTruthy()
    expect(screen.getByText(ECR_GUIDE)).toBeTruthy()
    expect(screen.getByRole('button', { name: '처음으로' })).toBeTruthy()
    // 이름은 선택·복사할 수 있는 고정폭 글
    const name = screen.getByText('deploy-wizard/app-a')
    expect(name.props.selectable).toBe(true)
    expect(StyleSheet.flatten(name.props.style).fontFamily).toBe('monospace')

    await waitFor(() => expect(googleSignOut).toHaveBeenCalledTimes(1))
    stop()
    expect(getSessionStatus()).toBe('signed_out')
    expect(seenWhenCleared).toEqual([true])
    // 서버가 이미 기기 행을 지웠으니 서버를 다시 부르지 않는다
    expect(deviceApi.remove).not.toHaveBeenCalled()
    expect(authApi.logout).not.toHaveBeenCalled()
    expect(await AsyncStorage.getItem('dw-push-device')).toBeNull()
    expect(await AsyncStorage.getItem('dw-picked-block')).toBeNull()
    expect(SecureStore.__items().has('dw-refresh')).toBe(false)
    // 결과 화면은 로그인 화면으로 튕겨 나가지 않는다
    expect(mockReplace).not.toHaveBeenCalled()
    expect(screen.getByText('계정을 삭제했습니다')).toBeTruthy()
  })

  test('복사 버튼은 저장소 이름들을 한 번에 복사하고, 실패하면 안내한다', async () => {
    await signedInStart()
    await confirmDelete()
    await fireEvent.press(await screen.findByRole('button', { name: '저장소 이름 복사' }))
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('deploy-wizard/app-a\ndeploy-wizard/app-b')
    expect(await screen.findByText('복사됨')).toBeTruthy()
    Clipboard.setStringAsync.mockResolvedValueOnce(false)
    await fireEvent.press(screen.getByRole('button', { name: '저장소 이름 복사' }))
    expect(await screen.findByText('저장소 이름을 복사하지 못했습니다')).toBeTruthy()
  })

  test('남은 저장소가 없으면 목록·ECR 안내 없이 서버 문구만', async () => {
    authApi.deleteMe.mockResolvedValue({ message: '다 지웠습니다', leftover_ecr_repositories: [] })
    await signedInStart()
    await confirmDelete()
    expect(await screen.findByText('다 지웠습니다')).toBeTruthy()
    expect(screen.queryByText(ECR_GUIDE)).toBeNull()
    expect(screen.queryByRole('button', { name: '저장소 이름 복사' })).toBeNull()
  })

  test('처음으로: 로그인이 필요한 서버는 로그인 화면, 끔 모드는 처음 화면', async () => {
    await signedInStart()
    await confirmDelete()
    await fireEvent.press(await screen.findByRole('button', { name: '처음으로' }))
    expect(mockReplace).toHaveBeenCalledTimes(1)
    expect(mockReplace).toHaveBeenCalledWith('/login')
  })

  test('끔 모드의 처음으로는 /', async () => {
    await signedInStart(OFF)
    await confirmDelete()
    await fireEvent.press(await screen.findByRole('button', { name: '처음으로' }))
    expect(mockReplace).toHaveBeenCalledTimes(1)
    expect(mockReplace).toHaveBeenCalledWith('/')
  })

  // 삭제 요청 중에 다른 화면으로 간다 (뒤로 가기 흉내) - 계정 삭제 화면이 사라진다
  async function leaveScreen() {
    await act(async () => {
      mockSegments = []
      for (const fn of [...mockSegmentListeners]) fn()
    })
    expect(screen.queryByTestId('delete-account-screen')).toBeNull()
  }

  test('삭제 요청 중에 화면을 떠나도 200 이 오면 기기 정리는 끝까지 한다 (세션·저장값·Google, 서버 기기 해제는 안 부름)', async () => {
    const pending = deferred()
    authApi.deleteMe.mockReturnValue(pending.promise)
    await signedInStart()
    await confirmDelete()
    await screen.findByRole('button', { name: '삭제하는 중…' })
    await leaveScreen()
    expect(getSessionStatus()).toBe('signed_in')
    await act(async () => { pending.resolve(DONE) })
    await waitFor(() => expect(googleSignOut).toHaveBeenCalledTimes(1))
    expect(getSessionStatus()).toBe('signed_out')
    expect(SecureStore.__items().has('dw-refresh')).toBe(false)
    expect(await AsyncStorage.getItem('dw-push-device')).toBeNull()
    expect(await AsyncStorage.getItem('dw-picked-block')).toBeNull()
    expect(deviceApi.remove).not.toHaveBeenCalled()
    expect(authApi.logout).not.toHaveBeenCalled()
    expect(authApi.deleteMe).toHaveBeenCalledTimes(1)
  })

  test.each([
    [409, LIVE_TEXT],
    [403, '개인 토큰으로는 계정을 삭제할 수 없습니다'],
    [503, '지금은 계정을 삭제할 수 없습니다'],
    [500, '서버 내부 오류가 났습니다'],
  ])('삭제 요청 중에 화면을 떠난 뒤 %s 로 실패하면 아무것도 지우지 않는다', async (status, text) => {
    const pending = deferred()
    authApi.deleteMe.mockReturnValue(pending.promise)
    await signedInStart()
    await confirmDelete()
    await screen.findByRole('button', { name: '삭제하는 중…' })
    await leaveScreen()
    await act(async () => { pending.reject(httpError(status, text)) })
    expect(getSessionStatus()).toBe('signed_in')
    expect(googleSignOut).not.toHaveBeenCalled()
    expect(deviceApi.remove).not.toHaveBeenCalled()
    expect(SecureStore.__items().has('dw-refresh')).toBe(true)
    expect(await AsyncStorage.getItem('dw-push-device')).toBe('5')
    expect(await AsyncStorage.getItem('dw-picked-block')).toBe('3')
  })

  test('화면을 떠난 뒤 200 이 와도 정리 단계 하나가 실패하면 나머지는 한다', async () => {
    const pending = deferred()
    authApi.deleteMe.mockReturnValue(pending.promise)
    googleSignOut.mockRejectedValue(new Error('google down'))
    await signedInStart()
    await confirmDelete()
    await screen.findByRole('button', { name: '삭제하는 중…' })
    await leaveScreen()
    await act(async () => { pending.resolve(DONE) })
    await waitFor(() => expect(googleSignOut).toHaveBeenCalledTimes(1))
    expect(getSessionStatus()).toBe('signed_out')
    expect(await AsyncStorage.getItem('dw-push-device')).toBeNull()
  })

  test('화면에 토큰이 없다', async () => {
    await signedInStart()
    await confirmDelete()
    await screen.findByText('계정을 삭제했습니다')
    const json = JSON.stringify(screen.toJSON())
    for (const secret of ['SECRET', 'dwr_']) expect(json).not.toContain(secret)
  })
})
