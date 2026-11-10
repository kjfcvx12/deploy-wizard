import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import { render, screen } from '@testing-library/react-native'
import RootLayout from '../../app/_layout'

const mockPush = jest.fn()
jest.mock('expo-router', () => {
  const { View } = require('react-native')
  return {
    DarkTheme: { colors: {} },
    DefaultTheme: { colors: {} },
    ThemeProvider: ({ children }) => children,
    Stack: () => <View testID="stack" />,
    useRouter: () => ({ push: mockPush }),
  }
})
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }))

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT'
const response = (link, id = 'n-1', actionIdentifier = DEFAULT_ACTION) => ({ actionIdentifier, notification: { request: { identifier: id, content: { data: { link } } } } })
// 리스너를 한 번 등록한 뒤 그 함수를 돌려준다
const listener = () => Notifications.addNotificationResponseReceivedListener.mock.calls[0][0]

let remove
let consoleSpies
beforeEach(() => {
  mockPush.mockReset()
  remove = jest.fn()
  Notifications.setNotificationHandler.mockReset()
  Notifications.addNotificationResponseReceivedListener.mockReset().mockImplementation(() => ({ remove }))
  Notifications.getLastNotificationResponse.mockReset().mockReturnValue(null)
  Notifications.clearLastNotificationResponse.mockReset()
  Notifications.requestPermissionsAsync.mockClear()
  Notifications.getPermissionsAsync.mockClear()
  Notifications.getExpoPushTokenAsync.mockClear()
  consoleSpies = ['log', 'info', 'warn', 'error'].map((k) => jest.spyOn(console, k))
})

afterEach(() => {
  const noisy = consoleSpies.flatMap((spy) => spy.mock.calls)
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

describe('루트 레이아웃 - 알림 연결', () => {
  test('화면을 그리고 앞에서 받은 알림은 배너·목록에 보이되 소리와 숫자는 없다', async () => {
    await render(<RootLayout />)
    expect(screen.getByTestId('stack')).toBeTruthy()
    const { handleNotification } = Notifications.setNotificationHandler.mock.calls[0][0]
    // iOS 는 조용히 (소리 없음)
    expect(await handleNotification({})).toEqual({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false })
  })

  test('안드로이드에서는 shouldPlaySound 가 true 다 (false 면 앞에서 받은 알림의 상단 배너가 뜨지 않는다 - 타입 정의 설명)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    await render(<RootLayout />)
    const { handleNotification } = Notifications.setNotificationHandler.mock.calls[0][0]
    expect(await handleNotification({})).toEqual({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false })
  })

  test.each([
    ['다른 액션 버튼', 'expo.modules.notifications.actions.OTHER'],
    ['알림 닫기', 'expo.modules.notifications.actions.DISMISS'],
    ['액션 없음', null],
  ])('알림 탭: 기본 액션이 아니면(%s) 링크가 유효해도 이동하지 않는다', async (_name, action) => {
    await render(<RootLayout />)
    listener()(response('deploywizard://deploys/12', 'n-1', action))
    expect(mockPush).not.toHaveBeenCalled()
  })

  test('첫 실행의 응답도 기본 액션이 아니면 이동하지 않는다 (비우기는 한다)', async () => {
    Notifications.getLastNotificationResponse.mockReturnValue(response('deploywizard://deploys/12', 'cold', 'expo.modules.notifications.actions.OTHER'))
    await render(<RootLayout />)
    expect(mockPush).not.toHaveBeenCalled()
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1)
  })

  test('앱을 켜는 것만으로는 권한도 토큰도 요청하지 않는다', async () => {
    await render(<RootLayout />)
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled()
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled()
  })

  test.each([
    ['인시던트 링크', 'deploywizard://incidents/7', '/incidents/7'],
    ['배포 링크', 'deploywizard://deploys/12', '/deploys/12'],
  ])('알림 탭 (앱 켜짐): %s 는 검증된 경로로 이동', async (_name, link, route) => {
    await render(<RootLayout />)
    listener()(response(link))
    expect(mockPush).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith(route)
  })

  test.each([
    ['다른 스킴', 'https://evil.example/deploys/1'],
    ['허용 밖 경로', 'deploywizard://accounts'],
    ['상위 경로', 'deploywizard://deploys/../accounts'],
    ['쿼리', 'deploywizard://deploys/1?next=/x'],
    ['숫자 0', 'deploywizard://deploys/0'],
    ['숫자 아님', 7],
    ['null', null],
    ['없음', undefined],
  ])('알림 탭: %s 는 무시', async (_name, link) => {
    await render(<RootLayout />)
    listener()(response(link))
    expect(mockPush).not.toHaveBeenCalled()
  })

  test('data 가 없거나 응답이 이상해도 무시하고 던지지 않는다', async () => {
    await render(<RootLayout />)
    for (const value of [null, undefined, {}, { notification: { request: { content: {} } } }, { notification: { request: { content: { data: 'x' } } } }]) {
      expect(() => listener()(value)).not.toThrow()
    }
    expect(mockPush).not.toHaveBeenCalled()
  })

  test('이동이 던져도 앱이 죽지 않는다', async () => {
    mockPush.mockImplementation(() => { throw new Error('not mounted') })
    await render(<RootLayout />)
    expect(() => listener()(response('deploywizard://deploys/3'))).not.toThrow()
  })

  test('첫 실행(꺼져 있다가 알림으로 켜짐): 마지막 응답을 한 번 처리하고 비운다', async () => {
    Notifications.getLastNotificationResponse.mockReturnValue(response('deploywizard://incidents/9', 'cold'))
    await render(<RootLayout />)
    expect(mockPush).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith('/incidents/9')
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1)
    // 같은 알림이 리스너로 또 오면 두 번 이동하지 않는다
    listener()(response('deploywizard://incidents/9', 'cold'))
    expect(mockPush).toHaveBeenCalledTimes(1)
  })

  test('첫 실행의 응답이 허용 밖 링크면 이동하지 않는다 (그래도 비운다)', async () => {
    Notifications.getLastNotificationResponse.mockReturnValue(response('https://evil.example/x'))
    await render(<RootLayout />)
    expect(mockPush).not.toHaveBeenCalled()
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1)
  })

  test('마지막 응답이 없으면 이동·비우기 없음', async () => {
    await render(<RootLayout />)
    expect(mockPush).not.toHaveBeenCalled()
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled()
  })

  test('화면이 닫히면 리스너를 떼고 표시 방식을 풀어 준다', async () => {
    const view = await render(<RootLayout />)
    expect(remove).not.toHaveBeenCalled()
    await view.unmount()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(Notifications.setNotificationHandler).toHaveBeenLastCalledWith(null)
  })

  test('웹에서는 알림 모듈을 건드리지 않는다', async () => {
    jest.replaceProperty(Platform, 'OS', 'web')
    await render(<RootLayout />)
    expect(screen.getByTestId('stack')).toBeTruthy()
    expect(Notifications.setNotificationHandler).not.toHaveBeenCalled()
    expect(Notifications.addNotificationResponseReceivedListener).not.toHaveBeenCalled()
    expect(Notifications.getLastNotificationResponse).not.toHaveBeenCalled()
  })

  test('알림 모듈이 던지는 환경이어도 레이아웃은 그려진다', async () => {
    Notifications.setNotificationHandler.mockImplementation(() => { throw new Error('native module missing') })
    await render(<RootLayout />)
    expect(screen.getByTestId('stack')).toBeTruthy()
  })
})
