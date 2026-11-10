import { AppState, StyleSheet } from 'react-native'
import { render, screen, fireEvent, act } from '@testing-library/react-native'
import { deployApi, notificationApi } from '../api'
import DeployList from '../../app/index'
import StatusBadge from '../components/StatusBadge'
import { lightColors } from '../theme'
import { SafeAreaProvider } from 'react-native-safe-area-context'

const mockPush = jest.fn()
// 화면 포커스 흉내 - 마운트 때 효과를 한 번 실행하고, 다시 포커스를 받는 것은 mockFocus.regain() 으로 만든다
const mockFocus = { effect: null, regain: () => mockFocus.effect() }
// 헤더 버튼은 mockHeader.show 일 때만 그린다 (본문의 ＋ 새 배포 버튼과 겹치지 않게)
const mockHeader = { show: false }
jest.mock('expo-router', () => {
  const React = require('react')
  return {
    useRouter: () => ({ push: mockPush }),
    Stack: { Screen: ({ options }) => (mockHeader.show && options?.headerRight ? options.headerRight() : null) },
    useFocusEffect: (effect) => {
      mockFocus.effect = effect
      React.useEffect(() => effect(), [effect])
    },
  }
})
jest.mock('../api', () => ({ deployApi: { getAll: jest.fn() }, notificationApi: { getUnreadCount: jest.fn() } }))

const deploys = [
  { d_id: 7, repo_url: 'https://github.com/acme/api', branch: 'main', language: 'Node.js', status: 'running', endpoint: 'https://abc.example.com', env_pending: 0 },
  { d_id: 8, repo_url: 'https://github.com/acme/web', branch: 'dev', language: 'Python', status: 'needs_input', endpoint: null, env_pending: 2 },
  { d_id: 9, repo_url: 'https://github.com/acme/build', branch: null, language: null, status: 'building', endpoint: null, env_pending: 0 },
]

beforeEach(() => {
  jest.useFakeTimers()
  mockPush.mockClear()
  mockHeader.show = false
  mockFocus.effect = null
  deployApi.getAll.mockReset()
  notificationApi.getUnreadCount.mockReset().mockResolvedValue({ count: 0 })
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

  test('연결 실패 메시지가 앞머리와 같으면 한 번만 보여 준다', async () => {
    deployApi.getAll.mockRejectedValue(new Error('서버에 연결할 수 없습니다'))
    await render(<DeployList />)
    expect(await screen.findByText('서버에 연결할 수 없습니다')).toBeTruthy()
    expect(screen.queryByText(/서버에 연결할 수 없습니다 :/)).toBeNull()
  })

  test('목록 아래 여백에 하단 안전 영역을 더한다', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 34 } }}>
        <DeployList />
      </SafeAreaProvider>,
    )
    await screen.findByText('acme/api')
    expect(StyleSheet.flatten(screen.getByTestId('deploy-list').props.contentContainerStyle).paddingBottom).toBe(24 * 2 + 34)
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

describe('배포 목록 화면 - 계정 연결과 포커스 새로고침', () => {
  test('헤더에는 ＋ 새 배포가, 헤더 아래 보조 줄에는 계정 연결이 있다 (390pt 에 모두 들어가도록)', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    await render(<DeployList />)
    await screen.findByText('acme/api')
    // 헤더를 켜지 않아도 계정 연결은 본문 보조 줄에서 눌린다
    await fireEvent.press(screen.getByText('계정 연결'))
    expect(mockPush).toHaveBeenCalledWith('/accounts')
    mockHeader.show = true
    await render(<DeployList />)
    await fireEvent.press(screen.getAllByText('＋ 새 배포')[0])
    expect(mockPush).toHaveBeenCalledWith('/new')
  })

  test('보조 줄의 알림 설정을 누르면 알림 설정 화면으로 간다', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    await render(<DeployList />)
    await screen.findByText('acme/api')
    await fireEvent.press(screen.getByRole('button', { name: '알림 설정' }))
    expect(mockPush).toHaveBeenCalledWith('/notification-settings')
  })

  test('계정 연결은 헤더에 없다', async () => {
    mockHeader.show = true
    deployApi.getAll.mockResolvedValue(deploys)
    await render(<DeployList />)
    await screen.findByText('acme/api')
    expect(screen.getAllByText('계정 연결')).toHaveLength(1)
    expect(screen.getAllByText('＋ 새 배포')).toHaveLength(1)
    expect(screen.getAllByTestId('quick-links')).toHaveLength(1)
  })

  test('보조 줄 버튼과 헤더 버튼은 눌림 높이가 44 이상이다', async () => {
    mockHeader.show = true
    deployApi.getAll.mockResolvedValue(deploys)
    await render(<DeployList />)
    await screen.findByText('acme/api')
    for (const name of ['계정 연결', '＋ 새 배포', '알림']) {
      const style = StyleSheet.flatten(screen.getByRole('button', { name }).props.style)
      expect(style.minHeight).toBeGreaterThanOrEqual(44)
      expect(style.minWidth).toBeGreaterThanOrEqual(44)
    }
  })

  test('처음 열 때는 포커스 새로고침이 한 번 더 부르지 않는다', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    await render(<DeployList />)
    await screen.findByText('acme/api')
    expect(deployApi.getAll).toHaveBeenCalledTimes(1)
  })

  test('다른 화면에 갔다가 다시 포커스를 받으면 목록을 다시 받는다', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    await render(<DeployList />)
    await screen.findByText('acme/api')
    deployApi.getAll.mockResolvedValue([{ ...deploys[0], d_id: 12, repo_url: 'https://github.com/acme/fresh' }])
    await act(async () => { mockFocus.regain() })
    expect(await screen.findByText('acme/fresh')).toBeTruthy()
    expect(deployApi.getAll).toHaveBeenCalledTimes(2)
  })

  test('포커스를 여러 번 받으면 그때마다 한 번씩 다시 받는다', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    await render(<DeployList />)
    await screen.findByText('acme/api')
    await act(async () => { mockFocus.regain() })
    await act(async () => { mockFocus.regain() })
    expect(deployApi.getAll).toHaveBeenCalledTimes(3)
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

describe('배포 목록 화면 - 문제 배너와 헬스 점', () => {
  const withIncident = { ...deploys[0], open_incident_id: 12, auto_recover: true, health_state: 'unhealthy' }

  test('open_incident_id 가 있는 배포만 배너가 나오고, 누르면 인시던트 화면으로 간다', async () => {
    deployApi.getAll.mockResolvedValue([withIncident, { ...deploys[1], open_incident_id: null }])
    await render(<DeployList />)
    expect(await screen.findByText('acme/api에 문제가 있습니다 · 자동 복구 중')).toBeTruthy()
    expect(screen.queryByText(/acme\/web에 문제가 있습니다/)).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: /acme\/api에 문제가 있습니다/ }))
    expect(mockPush).toHaveBeenCalledWith('/incidents/12')
    expect(mockPush).not.toHaveBeenCalledWith('/deploys/7')
  })

  test('자동 복구가 꺼진 배포는 확인이 필요합니다 문구', async () => {
    deployApi.getAll.mockResolvedValue([{ ...withIncident, auto_recover: false }])
    await render(<DeployList />)
    expect(await screen.findByText('acme/api에 문제가 있습니다 · 확인이 필요합니다')).toBeTruthy()
  })

  test('확인 필요(needs_action) 인시던트도 배너가 나오고 확인이 필요합니다 문구, 누르면 그 인시던트로 간다', async () => {
    deployApi.getAll.mockResolvedValue([{ ...withIncident, open_incident_id: 21, open_incident_status: 'needs_action' }])
    await render(<DeployList />)
    expect(await screen.findByText('acme/api에 문제가 있습니다 · 확인이 필요합니다')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: /배포 #7\)/ }))
    expect(mockPush).toHaveBeenCalledWith('/incidents/21')
  })

  test('복구 중(recovering)이고 자동 복구가 켜져 있으면 자동 복구 중 문구', async () => {
    deployApi.getAll.mockResolvedValue([{ ...withIncident, open_incident_status: 'recovering' }])
    await render(<DeployList />)
    expect(await screen.findByText('acme/api에 문제가 있습니다 · 자동 복구 중')).toBeTruthy()
  })

  test('열린 인시던트가 없으면 배너가 하나도 없다 (옛 서버 응답처럼 필드가 없어도 된다)', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    await render(<DeployList />)
    await screen.findByText('acme/api')
    expect(screen.queryByText(/에 문제가 있습니다/)).toBeNull()
  })

  test('실행 중인 카드에만 헬스 점이 붙는다', async () => {
    deployApi.getAll.mockResolvedValue([withIncident, { ...deploys[1], health_state: 'healthy' }])
    await render(<DeployList />)
    await screen.findByText('acme/api')
    expect(screen.getAllByTestId('health-dot')).toHaveLength(1)
    expect(screen.getByLabelText('헬스체크: 응답 없음')).toBeTruthy()
  })

  test('연결 오류와 배너가 함께 나올 수 있다', async () => {
    deployApi.getAll.mockResolvedValueOnce([withIncident]).mockRejectedValue(new Error('연결 끊김'))
    await render(<DeployList />)
    await screen.findByText('acme/api에 문제가 있습니다 · 자동 복구 중')
    await act(async () => { jest.advanceTimersByTime(15000) })
    expect(await screen.findByText('서버에 연결할 수 없습니다 :연결 끊김')).toBeTruthy()
    expect(screen.getByText('acme/api에 문제가 있습니다 · 자동 복구 중')).toBeTruthy()
  })
})

describe('배포 목록 화면 - 알림 종 버튼과 안 읽은 수 배지', () => {
  beforeEach(() => { mockHeader.show = true })

  test('읽지 않은 알림이 있으면 배지에 수가 나오고 라벨에도 들어간다', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    notificationApi.getUnreadCount.mockResolvedValue({ count: 3 })
    await render(<DeployList />)
    expect(await screen.findByText('3')).toBeTruthy()
    expect(screen.getByRole('button', { name: '알림 3개 읽지 않음' })).toBeTruthy()
  })

  test('99를 넘으면 99+ 로 줄여 보인다', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    notificationApi.getUnreadCount.mockResolvedValue({ count: 150 })
    await render(<DeployList />)
    expect(await screen.findByText('99+')).toBeTruthy()
  })

  test('0 이면 배지가 없고 라벨은 알림', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    await render(<DeployList />)
    await screen.findByText('acme/api')
    expect(screen.queryByTestId('unread-badge')).toBeNull()
    expect(screen.getByRole('button', { name: '알림' })).toBeTruthy()
  })

  test('조회가 실패하면 배지 없이 조용하다', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    notificationApi.getUnreadCount.mockRejectedValue(new Error('x'))
    await render(<DeployList />)
    await screen.findByText('acme/api')
    expect(screen.queryByTestId('unread-badge')).toBeNull()
  })

  test('종을 누르면 /notifications 로 간다', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    notificationApi.getUnreadCount.mockResolvedValue({ count: 2 })
    await render(<DeployList />)
    await fireEvent.press(await screen.findByRole('button', { name: '알림 2개 읽지 않음' }))
    expect(mockPush).toHaveBeenCalledWith('/notifications')
  })

  test('알림 화면에서 돌아와 포커스를 받으면 안 읽은 수를 다시 받는다', async () => {
    deployApi.getAll.mockResolvedValue(deploys)
    notificationApi.getUnreadCount.mockResolvedValue({ count: 3 })
    await render(<DeployList />)
    expect(await screen.findByText('3')).toBeTruthy()
    expect(notificationApi.getUnreadCount).toHaveBeenCalledTimes(1)
    notificationApi.getUnreadCount.mockResolvedValue({ count: 0 })
    await act(async () => { mockFocus.regain() })
    expect(notificationApi.getUnreadCount).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('unread-badge')).toBeNull()
  })
})
