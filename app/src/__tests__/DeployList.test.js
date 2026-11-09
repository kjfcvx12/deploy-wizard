import { AppState, StyleSheet } from 'react-native'
import { render, screen, fireEvent, act } from '@testing-library/react-native'
import { deployApi } from '../api'
import DeployList from '../../app/index'
import StatusBadge from '../components/StatusBadge'
import { lightColors } from '../theme'

const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  Stack: { Screen: () => null },
}))
jest.mock('../api', () => ({ deployApi: { getAll: jest.fn() } }))

const deploys = [
  { d_id: 7, repo_url: 'https://github.com/acme/api', branch: 'main', language: 'Node.js', status: 'running', endpoint: 'https://abc.example.com', env_pending: 0 },
  { d_id: 8, repo_url: 'https://github.com/acme/web', branch: 'dev', language: 'Python', status: 'needs_input', endpoint: null, env_pending: 2 },
  { d_id: 9, repo_url: 'https://github.com/acme/build', branch: null, language: null, status: 'building', endpoint: null, env_pending: 0 },
]

beforeEach(() => {
  jest.useFakeTimers()
  mockPush.mockClear()
  deployApi.getAll.mockReset()
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() }))
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('배포 목록 화면', () => {
  test('카드에 이름, 메타 줄, 상태가 나온다', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    await render(<DeployList />)
    expect(await screen.findByText('acme/api')).toBeTruthy()
    expect(screen.getByText('#7 · main · Node.js · abc.example.com')).toBeTruthy()
    expect(screen.getByText('#8 · dev · Python · 환경변수 2개 입력 필요')).toBeTruthy()
    expect(screen.getByText('#9')).toBeTruthy()
    expect(screen.getByText('정상')).toBeTruthy()
    expect(screen.getByText('입력 필요')).toBeTruthy()
    expect(screen.getByText('빌드 중')).toBeTruthy()
  })

  test('카드를 누르면 상세 화면으로 간다', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    await render(<DeployList />)
    await fireEvent.press(await screen.findByText('acme/web'))
    expect(mockPush).toHaveBeenCalledWith('/deploys/8')
  })

  test('불러오는 동안 스피너를 보여 준다', async () => {
    deployApi.getAll.mockReturnValue(new Promise(() => {}))
    await render(<DeployList />)
    expect(screen.getByLabelText('불러오는 중')).toBeTruthy()
  })

  test('비어 있으면 안내 문구와 새 배포 버튼', async () => {
    deployApi.getAll.mockResolvedValue([])
    await render(<DeployList />)
    expect(await screen.findByText('아직 배포한 것이 없습니다.')).toBeTruthy()
    await fireEvent.press(screen.getByText('＋ 새 배포'))
    expect(mockPush).toHaveBeenCalledWith('/new')
  })

  test('실패하면 메시지와 다시 시도 버튼, 누르면 다시 부른다', async () => {
    deployApi.getAll.mockRejectedValueOnce(new Error('연결 끊김')).mockResolvedValue(deploys)
    await render(<DeployList />)
    expect(await screen.findByText('서버에 연결할 수 없습니다 :연결 끊김')).toBeTruthy()
    await fireEvent.press(screen.getByText('다시 시도'))
    expect(await screen.findByText('acme/api')).toBeTruthy()
    expect(deployApi.getAll).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('다시 시도')).toBeNull()
  })

  test('진행 중인 배포가 있으면 3초, 없으면 15초 간격', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    await render(<DeployList />)
    await screen.findByText('acme/api')
    await act(async () => { jest.advanceTimersByTime(3000) })
    expect(deployApi.getAll).toHaveBeenCalledTimes(2)

    deployApi.getAll.mockResolvedValue([deploys[0]])
    await act(async () => { jest.advanceTimersByTime(3000) })
    expect(deployApi.getAll).toHaveBeenCalledTimes(3)
    await act(async () => { jest.advanceTimersByTime(14999) })
    expect(deployApi.getAll).toHaveBeenCalledTimes(3)
    await act(async () => { jest.advanceTimersByTime(1) })
    expect(deployApi.getAll).toHaveBeenCalledTimes(4)
  })

  test('실패 뒤에는 10초 뒤에 다시 시도한다', async () => {
    deployApi.getAll.mockRejectedValue(new Error('x'))
    await render(<DeployList />)
    await screen.findByText('서버에 연결할 수 없습니다 :x')
    await act(async () => { jest.advanceTimersByTime(9999) })
    expect(deployApi.getAll).toHaveBeenCalledTimes(1)
    await act(async () => { jest.advanceTimersByTime(1) })
    expect(deployApi.getAll).toHaveBeenCalledTimes(2)
  })

  test('언마운트하면 타이머가 남지 않는다', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    const { unmount } = await render(<DeployList />)
    await screen.findByText('acme/api')
    await unmount()
    await act(async () => { jest.advanceTimersByTime(60000) })
    expect(deployApi.getAll).toHaveBeenCalledTimes(1)
  })
})

describe('StatusBadge', () => {
  test.each([
    ['running', '정상'],
    ['failed', '실패'],
    ['deploying', '배포 중'],
    ['needs_input', '입력 필요'],
    ['stopped', '멈춤'],
  ])('%s 상태 라벨', async (status, label) => {
    await render(<StatusBadge status={status} />)
    expect(screen.getByText(label)).toBeTruthy()
  })

  test.each([
    ['running', lightColors.okBg],
    ['failed', lightColors.errBg],
    ['deploying', lightColors.infoBg],
    ['needs_input', lightColors.warnBg],
    ['stopped', lightColors.surface2],
  ])('%s 상태 배경색', async (status, bg) => {
    await render(<StatusBadge status={status} />)
    expect(StyleSheet.flatten(screen.getByTestId('status-badge').props.style).backgroundColor).toBe(bg)
  })

  test('모르는 상태는 값 그대로', async () => {
    await render(<StatusBadge status="weird" />)
    expect(screen.getByText('weird')).toBeTruthy()
  })
})
