import { AppState, ScrollView, StyleSheet } from 'react-native'
import { render, screen, fireEvent, act } from '@testing-library/react-native'
import { deployApi, envApi } from '../api'
import DeploySettings from '../../app/deploy-settings/[d_id]'
import DeployDetail from '../../app/deploys/[d_id]'

const mockBack = jest.fn()
const mockReplace = jest.fn()
const mockPush = jest.fn()
let mockCanGoBack = true
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, replace: mockReplace, push: mockPush, dismissTo: jest.fn(), canGoBack: () => mockCanGoBack }),
  useLocalSearchParams: () => ({ d_id: '7' }),
  Stack: { Screen: () => null },
  useFocusEffect: () => {},
}))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }))
jest.mock('../api', () => ({
  deployApi: {
    getOne: jest.fn(), patchSettings: jest.fn(),
    getLogs: jest.fn(), getIssues: jest.fn(), getHealth: jest.fn(), redeploy: jest.fn(), stop: jest.fn(), start: jest.fn(), remove: jest.fn(),
  },
  envApi: { getAll: jest.fn(), put: jest.fn(), clearValue: jest.fn(), continueDeploy: jest.fn() },
  incidentApi: { getOne: jest.fn() },
}))

const base = {
  d_id: 7, repo_url: 'https://github.com/acme/api', branch: 'main', status: 'running', auto_redeploy: true, auto_recover: true,
}
const REDEPLOY = '새 커밋이 오면 자동 재배포'
const RECOVER = '문제가 생기면 자동 복구'
const notFound = Object.assign(new Error('해당 id의 배포가 없습니다'), { status: 404 })
const NOT_FOUND_TEXT = '배포를 찾을 수 없습니다. 이미 삭제된 배포일 수 있습니다.'
const NOTE_TEXT = '변경은 누르는 즉시 저장됩니다. 이미 진행 중인 배포에는 영향이 없습니다.'

// 끝낼 시점을 테스트가 정하는 약속
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  jest.useFakeTimers()
  for (const fn of [mockBack, mockReplace, mockPush]) fn.mockReset()
  mockCanGoBack = true
  for (const fn of Object.values(deployApi)) fn.mockReset()
  deployApi.getOne.mockResolvedValue({ ...base })
  deployApi.patchSettings.mockResolvedValue({ ...base })
  deployApi.getLogs.mockResolvedValue([])
  deployApi.getIssues.mockResolvedValue([])
  deployApi.getHealth.mockResolvedValue({ health: 'healthy' })
  for (const fn of Object.values(envApi)) fn.mockReset()
  envApi.getAll.mockResolvedValue([])
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() }))
  jest.spyOn(console, 'error')
  jest.spyOn(console, 'warn')
})

afterEach(() => {
  const noisy = [...console.error.mock.calls, ...console.warn.mock.calls]
  jest.useRealTimers()
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

const open = async (deploy = base) => {
  deployApi.getOne.mockResolvedValue({ ...deploy })
  const view = await render(<DeploySettings />)
  await screen.findByRole('switch', { name: new RegExp(REDEPLOY) })
  return view
}
const row = (name) => screen.getByRole('switch', { name: new RegExp(name) })
const flush = async () => { await act(async () => {}) }

describe('배포 설정 - 처음 값', () => {
  test('두 스위치가 서버 값을 그대로 보여 주고 다시 받지 않는다 (폴링 없음)', async () => {
    await open({ ...base, auto_redeploy: false, auto_recover: true })
    expect(row(REDEPLOY).props.accessibilityState).toMatchObject({ checked: false })
    expect(row(RECOVER).props.accessibilityState).toMatchObject({ checked: true })
    expect(deployApi.getOne).toHaveBeenCalledTimes(1)
    expect(deployApi.getOne).toHaveBeenCalledWith('7')
    await act(async () => { jest.advanceTimersByTime(60000) })
    expect(deployApi.getOne).toHaveBeenCalledTimes(1)
  })

  test('설명 글: 자동 복구는 재시작과 이전 버전으로 되돌리기만 한다고 말한다', async () => {
    await open()
    expect(screen.getByText(/자동 복구는 재시작과 이전 버전으로 되돌리기만 합니다/)).toBeTruthy()
    expect(screen.getByText(REDEPLOY)).toBeTruthy()
    expect(screen.getByText(RECOVER)).toBeTruthy()
  })

  test('각 줄은 하나의 접근성 요소: switch 역할, 이름에 설정 이름과 배포 번호, 44pt 이상', async () => {
    await open()
    for (const name of [REDEPLOY, RECOVER]) {
      const el = row(name)
      expect(el.props.accessibilityLabel).toContain(name)
      expect(el.props.accessibilityLabel).toContain('배포 #7')
      expect(StyleSheet.flatten(el.props.style).minHeight).toBeGreaterThanOrEqual(44)
    }
    // 안쪽 스위치는 따로 읽히지 않는다
    expect(screen.getAllByRole('switch')).toHaveLength(2)
  })

  test('서버가 값을 보내지 않은 옛 응답이면 자동 복구는 켜짐(기본), 자동 재배포는 꺼짐으로 본다', async () => {
    deployApi.getOne.mockResolvedValue({ d_id: 7, repo_url: base.repo_url })
    await render(<DeploySettings />)
    await screen.findByRole('switch', { name: new RegExp(REDEPLOY) })
    expect(row(REDEPLOY).props.accessibilityState).toMatchObject({ checked: false })
    expect(row(RECOVER).props.accessibilityState).toMatchObject({ checked: true })
  })
})

describe('배포 설정 - 변경', () => {
  test('바꾼 항목 하나만 보내고 바로 새 값으로 보이며 성공하면 "저장했습니다"', async () => {
    const call = deferred()
    deployApi.patchSettings.mockReturnValueOnce(call.promise)
    await open()
    await fireEvent.press(row(RECOVER))
    // 서버 응답 전에 이미 새 값 (낙관적)
    expect(row(RECOVER).props.accessibilityState).toMatchObject({ checked: false })
    expect(deployApi.patchSettings).toHaveBeenCalledTimes(1)
    expect(deployApi.patchSettings).toHaveBeenCalledWith('7', { auto_recover: false })
    expect(deployApi.patchSettings.mock.calls[0][1]).toEqual({ auto_recover: false })
    expect(screen.queryByText('저장했습니다')).toBeNull()
    await act(async () => { call.resolve({ ...base, auto_recover: false }) })
    expect(screen.getByText('저장했습니다')).toBeTruthy()
    expect(row(RECOVER).props.accessibilityState).toMatchObject({ checked: false })
    expect(row(REDEPLOY).props.accessibilityState).toMatchObject({ checked: true })
  })

  test('자동 재배포를 끄면 { auto_redeploy: false } 만 보낸다', async () => {
    await open()
    await fireEvent.press(row(REDEPLOY))
    await flush()
    expect(deployApi.patchSettings).toHaveBeenCalledWith('7', { auto_redeploy: false })
  })

  test('꺼진 스위치를 켜면 true 를 보낸다', async () => {
    await open({ ...base, auto_redeploy: false })
    await fireEvent.press(row(REDEPLOY))
    await flush()
    expect(deployApi.patchSettings).toHaveBeenCalledWith('7', { auto_redeploy: true })
  })

  test('"저장했습니다" 는 잠시 뒤 사라지고, 다음 변경을 시작하면 바로 사라진다', async () => {
    await open()
    await fireEvent.press(row(RECOVER))
    await flush()
    expect(screen.getByText('저장했습니다')).toBeTruthy()
    await act(async () => { jest.advanceTimersByTime(4000) })
    expect(screen.queryByText('저장했습니다')).toBeNull()

    await fireEvent.press(row(RECOVER))
    await flush()
    expect(screen.getByText('저장했습니다')).toBeTruthy()
    const pending = deferred()
    deployApi.patchSettings.mockReturnValueOnce(pending.promise)
    await fireEvent.press(row(REDEPLOY))
    expect(screen.queryByText('저장했습니다')).toBeNull()
    await act(async () => { pending.resolve({}) })
    expect(screen.getByText('저장했습니다')).toBeTruthy()
  })

  test('한 스위치의 저장 안내 타이머가 다른 스위치의 오류를 지우지 않는다 (B 가 느리게 실패)', async () => {
    const slow = deferred()
    await open()
    deployApi.patchSettings.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({})
    await fireEvent.press(row(REDEPLOY))
    await fireEvent.press(row(RECOVER))
    await flush()
    expect(screen.getByText('저장했습니다')).toBeTruthy()
    await act(async () => { jest.advanceTimersByTime(1000) })
    await act(async () => { slow.reject(new Error('서버 오류')) })
    expect(screen.getByText('서버 오류')).toBeTruthy()
    await act(async () => { jest.advanceTimersByTime(5000) })
    expect(screen.getByText('서버 오류')).toBeTruthy()
  })

  test('실패하면 이전 값으로 되돌리고 서버의 한국어 메시지를 보여 준다', async () => {
    deployApi.patchSettings.mockRejectedValueOnce(new Error('변경할 설정을 하나 이상 보내 주세요'))
    await open()
    await fireEvent.press(row(RECOVER))
    await flush()
    expect(row(RECOVER).props.accessibilityState).toMatchObject({ checked: true })
    expect(screen.getByText('변경할 설정을 하나 이상 보내 주세요')).toBeTruthy()
    expect(screen.queryByText('저장했습니다')).toBeNull()
    // 다시 누를 수 있다
    await fireEvent.press(row(RECOVER))
    await flush()
    expect(deployApi.patchSettings).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('변경할 설정을 하나 이상 보내 주세요')).toBeNull()
    expect(screen.getByText('저장했습니다')).toBeTruthy()
  })

  test('실패는 그 스위치만 되돌린다 (다른 스위치의 새 값은 유지)', async () => {
    const a = deferred()
    const b = deferred()
    await open()
    deployApi.patchSettings.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    await fireEvent.press(row(REDEPLOY))
    await fireEvent.press(row(RECOVER))
    expect(deployApi.patchSettings.mock.calls.map((c) => c[1])).toEqual([{ auto_redeploy: false }, { auto_recover: false }])
    await act(async () => { a.reject(new Error('서버 오류')) })
    expect(row(REDEPLOY).props.accessibilityState).toMatchObject({ checked: true })
    expect(row(RECOVER).props.accessibilityState).toMatchObject({ checked: false })
    await act(async () => { b.resolve({}) })
    expect(row(RECOVER).props.accessibilityState).toMatchObject({ checked: false })
  })

  test('요청이 가는 동안 같은 스위치를 또 눌러도 요청은 하나이고 값은 처음 누른 그대로다', async () => {
    const call = deferred()
    deployApi.patchSettings.mockReturnValueOnce(call.promise)
    await open()
    await fireEvent.press(row(RECOVER))
    await fireEvent.press(row(RECOVER))
    await fireEvent.press(row(RECOVER))
    expect(deployApi.patchSettings).toHaveBeenCalledTimes(1)
    expect(row(RECOVER).props.accessibilityState).toMatchObject({ checked: false, busy: true })
    await act(async () => { call.resolve({}) })
    expect(row(RECOVER).props.accessibilityState).toMatchObject({ checked: false, busy: false })
    expect(deployApi.patchSettings).toHaveBeenCalledTimes(1)
  })

  test('요청이 실패한 뒤에는 잠금이 풀려 다시 누를 수 있다', async () => {
    const call = deferred()
    deployApi.patchSettings.mockReturnValueOnce(call.promise)
    await open()
    await fireEvent.press(row(RECOVER))
    await act(async () => { call.reject(new Error('연결 실패')) })
    expect(row(RECOVER).props.accessibilityState).toMatchObject({ checked: true, busy: false })
    await fireEvent.press(row(RECOVER))
    expect(deployApi.patchSettings).toHaveBeenCalledTimes(2)
    await flush()
  })

  test('한 스위치의 요청이 가는 중에도 다른 스위치는 누를 수 있다', async () => {
    const call = deferred()
    deployApi.patchSettings.mockReturnValueOnce(call.promise)
    await open()
    await fireEvent.press(row(RECOVER))
    await fireEvent.press(row(REDEPLOY))
    expect(deployApi.patchSettings).toHaveBeenCalledTimes(2)
    await act(async () => { call.resolve({}) })
  })

  test('404 로 저장에 실패하면(그 사이 배포가 지워짐) 없는 배포 안내로 바뀐다', async () => {
    deployApi.patchSettings.mockRejectedValueOnce(notFound)
    await open()
    await fireEvent.press(row(RECOVER))
    await flush()
    expect(screen.getByText(NOT_FOUND_TEXT)).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})

describe('배포 설정 - 맨 아래 안내 자리', () => {
  test('평소엔 기본 글이 보이고 맨 위에는 안내 띠가 없다', async () => {
    await open()
    expect(screen.getByText(NOTE_TEXT)).toBeTruthy()
    expect(screen.queryByText('저장했습니다')).toBeNull()
  })

  test('저장 성공 안내가 맨 아래 자리에서 기본 글을 대신하고 3초 뒤 기본 글로 돌아온다', async () => {
    await open()
    await fireEvent.press(row(RECOVER))
    await flush()
    expect(screen.getByText('저장했습니다').parent.props.accessibilityRole).toBe('alert')
    expect(screen.queryByText(NOTE_TEXT)).toBeNull()
    await act(async () => { jest.advanceTimersByTime(3100) })
    expect(screen.queryByText('저장했습니다')).toBeNull()
    expect(screen.getByText(NOTE_TEXT)).toBeTruthy()
  })

  test('안내가 뜨면 맨 아래로 스크롤하고, 맨 위로는 올리지 않는다', async () => {
    const scrollToEnd = jest.fn()
    const scrollTo = jest.fn()
    jest.spyOn(ScrollView.prototype, 'scrollToEnd').mockImplementation(scrollToEnd)
    jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(scrollTo)
    await open()
    await fireEvent.press(row(RECOVER))
    await flush()
    expect(scrollToEnd).toHaveBeenCalled()
    expect(scrollTo).not.toHaveBeenCalled()
  })

  test('스위치가 실패하면 서버 오류 문장 전체가 alert 로 보이고 스위치는 되돌아간다', async () => {
    const long = '지금은 설정을 바꿀 수 없습니다. 잠시 뒤 다시 시도해 주세요. '.repeat(4).trim()
    deployApi.patchSettings.mockRejectedValueOnce(new Error(long))
    await open()
    await fireEvent.press(row(RECOVER))
    await flush()
    expect(screen.getByText(long).parent.props.accessibilityRole).toBe('alert')
    expect(screen.queryByText(NOTE_TEXT)).toBeNull()
    expect(row(RECOVER).props.accessibilityState).toMatchObject({ checked: true })
  })

  test('404 면 안내와 돌아가기만 보이고 기본 글은 없다', async () => {
    deployApi.getOne.mockRejectedValue(notFound)
    await render(<DeploySettings />)
    expect(await screen.findByText(NOT_FOUND_TEXT)).toBeTruthy()
    expect(screen.getByRole('button', { name: '돌아가기' })).toBeTruthy()
    expect(screen.queryByText(NOTE_TEXT)).toBeNull()
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull()
  })
})

describe('배포 설정 - 불러오기와 정리', () => {
  test('불러오는 중에는 스피너만 보이고 스위치는 없다', async () => {
    deployApi.getOne.mockReturnValue(new Promise(() => {}))
    await render(<DeploySettings />)
    expect(screen.getByLabelText('불러오는 중')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  test('404 면 고정 안내와 돌아가기 버튼 (스위치 없음)', async () => {
    deployApi.getOne.mockRejectedValue(notFound)
    await render(<DeploySettings />)
    expect(await screen.findByText(NOT_FOUND_TEXT)).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText('해당 id의 배포가 없습니다')).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: '돌아가기' }))
    expect(mockBack).toHaveBeenCalledTimes(1)
  })

  test('돌아갈 화면이 없으면 목록으로 바꾼다', async () => {
    mockCanGoBack = false
    deployApi.getOne.mockRejectedValue(notFound)
    await render(<DeploySettings />)
    await screen.findByText(NOT_FOUND_TEXT)
    await fireEvent.press(screen.getByRole('button', { name: '돌아가기' }))
    expect(mockReplace).toHaveBeenCalledWith('/')
    expect(mockBack).not.toHaveBeenCalled()
  })

  test('연결 실패면 메시지와 다시 시도 - 다시 시도하면 스위치가 나온다', async () => {
    deployApi.getOne.mockRejectedValueOnce(new Error('서버에 연결할 수 없습니다'))
    await render(<DeploySettings />)
    expect(await screen.findByText('서버에 연결할 수 없습니다')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findByRole('switch', { name: new RegExp(REDEPLOY) })).toBeTruthy()
    expect(screen.queryByText('서버에 연결할 수 없습니다')).toBeNull()
    expect(deployApi.getOne).toHaveBeenCalledTimes(2)
  })

  test('화면을 닫은 뒤 늦게 온 응답은 버려지고 경고도 없다 (불러오기·저장·성공 안내 타이머)', async () => {
    const load = deferred()
    deployApi.getOne.mockReturnValue(load.promise)
    const view = await render(<DeploySettings />)
    await view.unmount()
    await act(async () => { load.resolve({ ...base }) })

    const call = deferred()
    deployApi.patchSettings.mockReturnValueOnce(call.promise)
    deployApi.getOne.mockResolvedValue({ ...base })
    const view2 = await render(<DeploySettings />)
    await screen.findByRole('switch', { name: new RegExp(RECOVER) })
    await fireEvent.press(row(RECOVER))
    await view2.unmount()
    await act(async () => { call.resolve({}) })
    await act(async () => { jest.advanceTimersByTime(10000) })

    const call2 = deferred()
    deployApi.patchSettings.mockReturnValueOnce(call2.promise)
    const view3 = await render(<DeploySettings />)
    await screen.findByRole('switch', { name: new RegExp(RECOVER) })
    await fireEvent.press(row(RECOVER))
    await view3.unmount()
    await act(async () => { call2.reject(new Error('늦은 실패')) })
  })

  test('성공 안내가 떠 있는 채로 화면을 닫으면 타이머가 남지 않는다', async () => {
    const setSpy = jest.spyOn(global, 'setTimeout')
    const clearSpy = jest.spyOn(global, 'clearTimeout')
    const view = await open()
    await fireEvent.press(row(RECOVER))
    await flush()
    expect(screen.getByText('저장했습니다')).toBeTruthy()
    // 안내를 지우는 타이머를 찾아 둔다
    const idx = setSpy.mock.calls.findIndex((c) => c[1] === 3000)
    expect(idx).toBeGreaterThanOrEqual(0)
    const timerId = setSpy.mock.results[idx].value
    await view.unmount()
    expect(clearSpy).toHaveBeenCalledWith(timerId)
  })
})

describe('배포 상세 - 설정 버튼', () => {
  test('[설정] 은 이름에 배포 번호를 담고 누르면 설정 화면으로 간다', async () => {
    deployApi.getOne.mockResolvedValue({ ...base, endpoint: null, service_arn: 'arn', image_uri: 'img' })
    await render(<DeployDetail />)
    const button = await screen.findByRole('button', { name: '배포 #7 설정' })
    expect(StyleSheet.flatten(button.props.style).minHeight).toBeGreaterThanOrEqual(44)
    await fireEvent.press(button)
    expect(mockPush).toHaveBeenCalledWith('/deploy-settings/7')
  })
})
