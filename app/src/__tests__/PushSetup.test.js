import { AppState, Linking, Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Notifications from 'expo-notifications'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native'
import { deviceApi, notificationApi } from '../api'
import DeployDetail from '../../app/deploys/[d_id]'
import PushPermissionGuide from '../components/ops/PushPermissionGuide'
import PushSetupCard from '../components/ops/PushSetupCard'

const mockConstants = { expoConfig: { extra: { eas: { projectId: 'proj-1' } } } }
jest.mock('expo-constants', () => ({ __esModule: true, get default() { return mockConstants } }))
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), dismissTo: jest.fn(), canGoBack: () => true, push: jest.fn() }),
  useLocalSearchParams: () => ({ d_id: '7' }),
  Stack: { Screen: () => null },
}))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }))
jest.mock('../api', () => ({
  deployApi: {
    getOne: jest.fn(), getLogs: jest.fn(), getIssues: jest.fn(), getHealth: jest.fn(),
    redeploy: jest.fn(), stop: jest.fn(), start: jest.fn(), remove: jest.fn(),
  },
  envApi: { getAll: jest.fn() },
  incidentApi: { getOne: jest.fn() },
  deviceApi: { register: jest.fn(), remove: jest.fn() },
  notificationApi: { patchSettings: jest.fn() },
}))
const { deployApi, envApi } = require('../api')

const TOKEN = 'ExponentPushToken[abc-SECRET-xyz789]'
const UNDETERMINED = { status: 'undetermined', granted: false, canAskAgain: true }
const GRANTED = { status: 'granted', granted: true, canAskAgain: true }
const DENIED = { status: 'denied', granted: false, canAskAgain: false }
const deploy = {
  d_id: 7, repo_url: 'https://github.com/acme/api', branch: 'main', commit_sha: 'abcdef1234567', language: 'Node.js',
  app_dir: '.', support_level: 'official', fix_count: 0, status: 'running', endpoint: 'https://svc-abcdefghij.ecs.ap-northeast-2.on.aws',
  error_step: null, error_msg: null, explain: null, dockerfile: null, dockerfile_source: 'template_rule', port: 3000,
  service_arn: 'arn:aws:ecs:x', image_uri: 'img:1',
}

let consoleSpies
beforeEach(async () => {
  await AsyncStorage.clear()
  mockConstants.expoConfig = { extra: { eas: { projectId: 'proj-1' } } }
  Notifications.getPermissionsAsync.mockReset().mockResolvedValue(UNDETERMINED)
  Notifications.requestPermissionsAsync.mockReset().mockResolvedValue(GRANTED)
  Notifications.getExpoPushTokenAsync.mockReset().mockResolvedValue({ data: TOKEN })
  deviceApi.register.mockReset().mockResolvedValue({ p_d_id: 4 })
  deviceApi.remove.mockReset().mockResolvedValue({})
  notificationApi.patchSettings.mockReset().mockResolvedValue({})
  for (const fn of Object.values(deployApi)) fn.mockReset()
  deployApi.getOne.mockResolvedValue(deploy)
  deployApi.getLogs.mockResolvedValue([])
  deployApi.getIssues.mockResolvedValue([])
  deployApi.getHealth.mockResolvedValue({ health: 'healthy' })
  envApi.getAll.mockReset().mockResolvedValue([])
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() }))
  consoleSpies = ['log', 'info', 'warn', 'error'].map((k) => jest.spyOn(console, k))
})

afterEach(() => {
  const noisy = consoleSpies.flatMap((spy) => spy.mock.calls)
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

const flush = () => act(async () => {})

describe('PushPermissionGuide (S-17)', () => {
  test('undetermined: 설명이 먼저, 그 아래 [알림 켜기] [나중에]', async () => {
    const onEnable = jest.fn()
    const onLater = jest.fn()
    await render(<PushPermissionGuide state="undetermined" onEnable={onEnable} onLater={onLater} />)
    expect(screen.getByText(/문제가 생겼을 때 바로 알려드리려고 알림 권한이 필요합니다/)).toBeTruthy()
    // 화면 순서: 설명 글이 첫 버튼보다 앞
    const order = screen.toJSON()
    const flat = JSON.stringify(order)
    expect(flat.indexOf('알림 권한이 필요합니다')).toBeLessThan(flat.indexOf('알림 켜기'))
    await fireEvent.press(screen.getByRole('button', { name: '알림 켜기' }))
    await fireEvent.press(screen.getByRole('button', { name: '나중에' }))
    expect(onEnable).toHaveBeenCalledTimes(1)
    expect(onLater).toHaveBeenCalledTimes(1)
  })

  test('busy 면 [알림 켜기] 가 잠긴다', async () => {
    await render(<PushPermissionGuide state="undetermined" busy onEnable={jest.fn()} onLater={jest.fn()} />)
    expect(screen.getByRole('button', { name: '알림 켜기' }).props.accessibilityState).toMatchObject({ disabled: true })
  })

  test('denied: OS 설정에서 켜는 방법 + [설정 열기] 가 Linking.openSettings 를 부른다 (켜기 버튼은 없다)', async () => {
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue()
    await render(<PushPermissionGuide state="denied" onEnable={jest.fn()} onLater={jest.fn()} />)
    expect(screen.getByText(/기기 설정/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '알림 켜기' })).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: '설정 열기' }))
    expect(open).toHaveBeenCalledTimes(1)
  })

  test('설정 열기가 실패해도 던지지 않는다', async () => {
    jest.spyOn(Linking, 'openSettings').mockRejectedValue(new Error('x'))
    await render(<PushPermissionGuide state="denied" onLater={jest.fn()} />)
    await fireEvent.press(screen.getByRole('button', { name: '설정 열기' }))
    await flush()
  })

  test('no_project: 스토어 빌드 준비(EAS 프로젝트 연결) 안내, 나머지는 그대로라고 적고 켜기 버튼은 없다', async () => {
    await render(<PushPermissionGuide state="no_project" />)
    expect(screen.getByText(/EAS 프로젝트/)).toBeTruthy()
    expect(screen.getByText(/나머지 기능은 그대로/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('unsupported: 한 줄 안내만', async () => {
    await render(<PushPermissionGuide state="unsupported" />)
    expect(screen.getByText(/푸시 알림을 쓸 수 없습니다/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('granted·null 이면 아무것도 그리지 않는다', async () => {
    const a = await render(<PushPermissionGuide state="granted" />)
    expect(a.toJSON()).toBeNull()
    const b = await render(<PushPermissionGuide state={null} />)
    expect(b.toJSON()).toBeNull()
  })

  test('onLater 가 없으면 [나중에] 도 없다 (고정 안내용)', async () => {
    await render(<PushPermissionGuide state="undetermined" onEnable={jest.fn()} />)
    expect(screen.queryByRole('button', { name: '나중에' })).toBeNull()
  })
})

describe('PushSetupCard - 한 번짜리 안내 카드', () => {
  test('running + undetermined + 닫은 적 없음: 카드가 보인다 - 그리고 권한은 아직 묻지 않았다', async () => {
    await render(<PushSetupCard active />)
    expect(await screen.findByRole('button', { name: '알림 켜기' })).toBeTruthy()
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled()
    expect(deviceApi.register).not.toHaveBeenCalled()
  })

  test('running 이 아니면 (active=false) 보이지 않고 상태도 읽지 않는다', async () => {
    await render(<PushSetupCard active={false} />)
    await flush()
    expect(screen.queryByRole('button', { name: '알림 켜기' })).toBeNull()
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled()
  })

  test.each([
    ['허용됨', GRANTED, null],
    ['거부됨', DENIED, null],
    ['프로젝트 없음', UNDETERMINED, 'no_project'],
    ['웹', UNDETERMINED, 'web'],
  ])('%s: 보이지 않는다', async (_name, permission, special) => {
    Notifications.getPermissionsAsync.mockResolvedValue(permission)
    if (special === 'no_project') mockConstants.expoConfig = {}
    if (special === 'web') jest.replaceProperty(Platform, 'OS', 'web')
    await render(<PushSetupCard active />)
    await flush()
    expect(screen.queryByRole('button', { name: '알림 켜기' })).toBeNull()
    expect(screen.toJSON()).toBeNull()
  })

  test('이미 닫았으면 보이지 않는다', async () => {
    await AsyncStorage.setItem('dw-push-card-dismissed', '1')
    await render(<PushSetupCard active />)
    await flush()
    expect(screen.toJSON()).toBeNull()
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled()
  })

  test('이미 보인 카드는 배포가 running 을 벗어나면(active=false) 사라진다 - 다시 running 이면 보인다', async () => {
    const view = await render(<PushSetupCard active />)
    expect(await screen.findByRole('button', { name: '알림 켜기' })).toBeTruthy()
    await view.rerender(<PushSetupCard active={false} />)
    expect(screen.toJSON()).toBeNull()
    await view.rerender(<PushSetupCard active />)
    expect(await screen.findByRole('button', { name: '알림 켜기' })).toBeTruthy()
  })

  test('[나중에]: 카드가 사라지고 기억하며, 다시 열어도 안 보인다', async () => {
    const first = await render(<PushSetupCard active />)
    await fireEvent.press(await screen.findByRole('button', { name: '나중에' }))
    await flush()
    expect(screen.toJSON()).toBeNull()
    expect(await AsyncStorage.getItem('dw-push-card-dismissed')).toBe('1')
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    await first.unmount()
    await render(<PushSetupCard active />)
    await flush()
    expect(screen.toJSON()).toBeNull()
  })

  test('[알림 켜기]: 이때 비로소 권한을 묻고, 등록하고, 서버 푸시 설정을 켜고, 카드를 지운다', async () => {
    await render(<PushSetupCard active />)
    await fireEvent.press(await screen.findByRole('button', { name: '알림 켜기' }))
    await waitFor(() => expect(screen.toJSON()).toBeNull())
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1)
    expect(deviceApi.register).toHaveBeenCalledTimes(1)
    expect(deviceApi.register).toHaveBeenCalledWith({ expo_token: TOKEN, platform: 'ios' })
    expect(notificationApi.patchSettings).toHaveBeenCalledWith({ notify_push: true })
    expect(await AsyncStorage.getItem('dw-push-device')).toBe('4')
  })

  test('연타해도 등록은 한 번', async () => {
    await render(<PushSetupCard active />)
    const button = await screen.findByRole('button', { name: '알림 켜기' })
    await fireEvent.press(button)
    await fireEvent.press(button)
    await waitFor(() => expect(screen.toJSON()).toBeNull())
    expect(deviceApi.register).toHaveBeenCalledTimes(1)
  })

  test('사용자가 OS 창에서 거부: 거부 안내로 바뀌고 다시 안 뜨게 기억한다 (등록 없음)', async () => {
    Notifications.requestPermissionsAsync.mockResolvedValue(DENIED)
    await render(<PushSetupCard active />)
    await fireEvent.press(await screen.findByRole('button', { name: '알림 켜기' }))
    expect(await screen.findByText(/기기 설정/)).toBeTruthy()
    expect(deviceApi.register).not.toHaveBeenCalled()
    expect(await AsyncStorage.getItem('dw-push-card-dismissed')).toBe('1')
    await fireEvent.press(screen.getByRole('button', { name: '나중에' }))
    await flush()
    expect(screen.toJSON()).toBeNull()
  })

  test('서버 등록 실패: 서버 문장을 보이되 토큰은 어디에도 없다, 카드는 남아 다시 누를 수 있다', async () => {
    deviceApi.register.mockRejectedValue(Object.assign(new Error(`형식이 틀립니다 ${TOKEN}`), { status: 422 }))
    await render(<PushSetupCard active />)
    await fireEvent.press(await screen.findByRole('button', { name: '알림 켜기' }))
    expect(await screen.findByText(/형식이 틀립니다/)).toBeTruthy()
    expect(JSON.stringify(screen.toJSON())).not.toContain('SECRET')
    expect(screen.getByRole('button', { name: '알림 켜기' })).toBeTruthy()
    expect(await AsyncStorage.getItem('dw-push-card-dismissed')).toBeNull()
  })

  test('토큰은 그려진 화면 어디에도 없다 (성공 전·후)', async () => {
    await render(<PushSetupCard active />)
    await fireEvent.press(await screen.findByRole('button', { name: '알림 켜기' }))
    await waitFor(() => expect(screen.toJSON()).toBeNull())
    expect(JSON.stringify(screen.toJSON())).not.toContain('SECRET')
  })
})

describe('배포 상세 화면에 붙은 카드', () => {
  const open = async (over = {}) => {
    deployApi.getOne.mockResolvedValue({ ...deploy, ...over })
    await render(<DeployDetail />)
    await screen.findByText('acme/api')
    await flush()
  }

  test('running 이면 카드가 보이고 화면을 여는 것만으로는 권한을 묻지 않는다', async () => {
    await open()
    expect(await screen.findByRole('button', { name: '알림 켜기' })).toBeTruthy()
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
  })

  test.each([['failed'], ['stopped']])('%s 이면 카드가 없다', async (status) => {
    await open({ status, endpoint: null })
    expect(screen.queryByRole('button', { name: '알림 켜기' })).toBeNull()
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled()
  })
})
