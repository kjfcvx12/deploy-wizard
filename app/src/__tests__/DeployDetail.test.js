import { Alert, AppState, Linking, Platform, StyleSheet } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { render, screen, fireEvent, act } from '@testing-library/react-native'
import { deployApi, envApi } from '../api'
import DeployDetail from '../../app/deploys/[d_id]'
import { monoFont } from '../theme'

const mockReplace = jest.fn()
// KeyboardAvoidingView 는 behavior 를 화면 요소로 내보내지 않으므로, 받은 속성을 기록하는 대체품을 쓴다
const mockKavProps = []
jest.mock('react-native/Libraries/Components/Keyboard/KeyboardAvoidingView', () => {
  const React = require('react')
  const { View } = require('react-native')
  return {
    __esModule: true,
    default: (props) => {
      mockKavProps.push(props)
      return React.createElement(View, { testID: props.testID, style: props.style }, props.children)
    },
  }
})
const mockDismissTo = jest.fn()
let mockCanGoBack = true
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, dismissTo: mockDismissTo, canGoBack: () => mockCanGoBack, push: jest.fn() }),
  useLocalSearchParams: () => ({ d_id: '7' }),
  Stack: { Screen: () => null },
}))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }))
jest.mock('../api', () => ({
  deployApi: {
    getOne: jest.fn(), getLogs: jest.fn(), getIssues: jest.fn(), getHealth: jest.fn(),
    redeploy: jest.fn(), stop: jest.fn(), start: jest.fn(), remove: jest.fn(),
  },
  envApi: { getAll: jest.fn(), put: jest.fn(), clearValue: jest.fn(), continueDeploy: jest.fn() },
}))

const ENDPOINT = 'https://deploy-wizard-example-service-abcdefghij.ecs.ap-northeast-2.on.aws'
const base = {
  d_id: 7, repo_url: 'https://github.com/acme/api', branch: 'main', commit_sha: 'abcdef1234567', language: 'Node.js',
  app_dir: '.', support_level: 'official', fix_count: 0, status: 'running', endpoint: ENDPOINT,
  error_step: null, error_msg: null, explain: null, dockerfile: null, dockerfile_source: 'template_rule', port: 3000,
  service_arn: 'arn:aws:ecs:x', image_uri: 'img:1',
}
const failedDeploy = {
  ...base, status: 'failed', endpoint: null, error_step: 'building', error_msg: 'npm ERR! code ELIFECYCLE',
  explain: {
    summary: '빌드 중 패키지 설치가 실패했습니다.', cause: 'package.json 의 의존성을 내려받지 못했습니다.',
    actions: ['lock 파일을 확인한다', '네트워크를 확인한다', '다시 배포한다'], source: 'rule', cached: true,
  },
}

// 로그 n줄 (번호는 from 부터)
const makeLogs = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ d_l_id: from + i, step: 'building', level: 'info', message: `줄 ${from + i}` }))

let current
beforeEach(() => {
  jest.useFakeTimers()
  mockReplace.mockClear()
  mockDismissTo.mockClear()
  mockCanGoBack = true
  current = base
  for (const fn of Object.values(deployApi)) fn.mockReset()
  deployApi.getOne.mockImplementation(async () => current)
  deployApi.getLogs.mockResolvedValue([])
  deployApi.getIssues.mockResolvedValue([])
  deployApi.getHealth.mockResolvedValue({ health: 'healthy' })
  for (const fn of Object.values(envApi)) fn.mockReset()
  envApi.getAll.mockResolvedValue([])
  Clipboard.setStringAsync.mockReset().mockResolvedValue(true)
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() }))
  jest.spyOn(console, 'error')
})

afterEach(() => {
  expect(console.error).not.toHaveBeenCalled()
  jest.useRealTimers()
  jest.restoreAllMocks()
})

// 화면을 띄우고 첫 응답이 그려질 때까지 기다린다
const open = async (deploy = base) => {
  current = deploy
  await render(<DeployDetail />)
  await screen.findByText('acme/api')
}
const tick = async (ms) => { await act(async () => { jest.advanceTimersByTime(ms) }) }

// 버튼이 잠겨 있는지
const isDisabled = (name) => !!screen.getByRole('button', { name }).props.accessibilityState?.disabled

// 확인 창의 버튼을 이름으로 찾는다
const alertButton = (name) => Alert.alert.mock.calls[0][2].find((b) => b.text === name)

describe('배포 상세 화면 - 키보드', () => {
  test('환경변수 입력칸이 있는 바깥 스크롤은 키보드 인셋 보정과 끌어서 닫기를 켠다', async () => {
    await open({ ...base, status: 'needs_input', endpoint: null })
    // 가장 바깥 스크롤 (안쪽 로그·Dockerfile 스크롤은 그 아래에 있다)
    const outer = screen.getByTestId('detail-scroll')
    expect(outer.props.automaticallyAdjustKeyboardInsets).toBe(true)
    expect(outer.props.keyboardDismissMode).toBe('on-drag')
    expect(outer.props.keyboardShouldPersistTaps).toBe('handled')
  })

  test('안드로이드에서는 스크롤을 KeyboardAvoidingView(height) 가 감싼다 (기기에서는 확인하지 못했다)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    await open({ ...base, status: 'needs_input', endpoint: null })
    const wrapper = screen.getByTestId('keyboard-avoiding')
    expect(mockKavProps[mockKavProps.length - 1].behavior).toBe('height')
    expect(StyleSheet.flatten(wrapper.props.style).flex).toBe(1)
  })

  test('iOS 에서는 behavior 를 주지 않는다 (기존 인셋 보정만 쓴다)', async () => {
    await open({ ...base, status: 'needs_input', endpoint: null })
    expect(screen.getByTestId('keyboard-avoiding')).toBeTruthy()
    expect(mockKavProps[mockKavProps.length - 1].behavior).toBeUndefined()
  })
})

describe('배포 상세 화면 - 상태별 화면', () => {
  test('running: 머리글, 주소 카드, 응답 정상 배지, 요금 안내, 동작 버튼', async () => {
    await open()
    expect(screen.getByText(/^#7 · main · abcdef1 · Node\.js$/)).toBeTruthy()
    expect(screen.getByText(ENDPOINT)).toBeTruthy()
    expect(await screen.findByText('응답 정상')).toBeTruthy()
    expect(screen.getByText(/로드밸런서와 컨테이너 요금이 계속 나옵니다/)).toBeTruthy()
    expect(screen.getByText('다시 배포')).toBeTruthy()
    expect(screen.getByText('멈춤')).toBeTruthy()
    expect(screen.getByText('삭제')).toBeTruthy()
    expect(screen.queryByText('멈춘 상태입니다.')).toBeNull()
  })

  test('running: 응답이 없으면 응답 없음, 확인 전이면 확인 전', async () => {
    deployApi.getHealth.mockResolvedValue({ health: 'unhealthy' })
    await open()
    expect(await screen.findByText('응답 없음')).toBeTruthy()
  })

  test('app_dir 이 있으면 머리글에 붙고, 실험 지원과 자가수정 배지가 나온다', async () => {
    await open({ ...base, app_dir: 'backend', support_level: 'experimental', fix_count: 2 })
    expect(screen.getByText(/· backend\/$/)).toBeTruthy()
    expect(screen.getByText('실험 지원')).toBeTruthy()
    expect(screen.getByText('자가수정 2회')).toBeTruthy()
  })

  test('failed: 해설 카드의 문구와 두 버튼, 안내 문장 (아래 동작 줄은 없다)', async () => {
    await open(failedDeploy)
    expect(screen.getByText('빌드 중 패키지 설치가 실패했습니다.')).toBeTruthy()
    expect(screen.getByText('알려진 에러 (캐시)')).toBeTruthy()
    expect(screen.getByText('package.json 의 의존성을 내려받지 못했습니다.')).toBeTruthy()
    expect(screen.getByText('1.')).toBeTruthy()
    expect(screen.getByText('lock 파일을 확인한다')).toBeTruthy()
    expect(screen.getByText('3.')).toBeTruthy()
    expect(screen.getByText('다시 배포한다')).toBeTruthy()
    expect(screen.getByText('npm ERR! code ELIFECYCLE')).toBeTruthy()
    expect(screen.getAllByText('다시 배포')).toHaveLength(1)
    expect(screen.getByText('만들어진 리소스 정리')).toBeTruthy()
    expect(screen.getByText('아무것도 누르지 않으면 그대로 둡니다. 자동으로 지우지 않습니다.')).toBeTruthy()
    expect(screen.queryByText('삭제')).toBeNull()
    expect(screen.queryByText('멈춤', { exact: true })).toBeNull()
  })

  test('failed: 해설이 없으면 단계 이름으로 제목을 만들고, 만든 리소스가 없으면 정리 버튼이 없다', async () => {
    await open({ ...failedDeploy, explain: null, service_arn: null, image_uri: null })
    expect(screen.getByText('building 단계에서 실패했습니다.')).toBeTruthy()
    expect(screen.queryByText('만들어진 리소스 정리')).toBeNull()
  })

  test('needs_input: 안내 문구, 대기 단계 표시, 다시 배포·멈춤은 숨기고 삭제는 둔다', async () => {
    await open({ ...base, status: 'needs_input', endpoint: null })
    expect(screen.getByText('환경변수 입력이 필요합니다. 아래에서 값을 입력하거나 건너뛴 뒤 [이어서 배포]를 누르세요.')).toBeTruthy()
    expect(screen.getByLabelText('푸시 완료')).toBeTruthy()
    expect(screen.getByLabelText('배포 입력 대기')).toBeTruthy()
    expect(screen.getByLabelText('완료 대기')).toBeTruthy()
    expect(await screen.findByText('입력할 환경변수를 찾지 못했습니다. [이어서 배포]를 눌러 계속하세요.')).toBeTruthy()
    expect(screen.queryByText('다시 배포')).toBeNull()
    expect(screen.queryByText('멈춤', { exact: true })).toBeNull()
    expect(screen.getByText('삭제')).toBeTruthy()
  })

  test('stopped: 멈춘 상태 카드와 다시 켜기, 다시 배포·멈춤은 숨긴다', async () => {
    await open({ ...base, status: 'stopped', endpoint: null })
    expect(screen.getByText('멈춘 상태입니다.')).toBeTruthy()
    expect(screen.getByText('다시 켜기')).toBeTruthy()
    expect(screen.queryByText('다시 배포')).toBeNull()
    expect(screen.getAllByText('멈춤')).toHaveLength(1)
    expect(screen.getByText('삭제')).toBeTruthy()
  })

  test('진행 중에는 동작 버튼이 없다', async () => {
    await open({ ...base, status: 'building', endpoint: null })
    expect(screen.queryByText('다시 배포')).toBeNull()
    expect(screen.queryByText('삭제')).toBeNull()
    expect(screen.getByLabelText('빌드 진행 중')).toBeTruthy()
  })

  test('Dockerfile 은 접혀 있고 누르면 펼쳐진다, 문제 이력도 마찬가지', async () => {
    deployApi.getIssues.mockResolvedValue([
      { d_i_id: 1, step: 'building', created_at: '2026-11-01T01:00:00Z', error_msg: 'raw', explain: { summary: '지난번 빌드 실패' } },
      { d_i_id: 2, step: 'pushing', created_at: '2026-11-02T01:00:00Z', error_msg: '푸시 원문', explain: null },
    ])
    await open({ ...base, dockerfile: 'FROM node:20\nCMD ["node","app.js"]' })
    expect(screen.queryByText(/FROM node:20/)).toBeNull()
    await fireEvent.press(screen.getByText(/Dockerfile/))
    expect(screen.getByText(/FROM node:20/)).toBeTruthy()
    expect(screen.getByText(/template_rule · 포트 3000/)).toBeTruthy()

    expect(await screen.findByText(/문제 이력/)).toBeTruthy()
    expect(screen.getByText(/\(2건\)/)).toBeTruthy()
    expect(screen.queryByText('지난번 빌드 실패')).toBeNull()
    await fireEvent.press(screen.getByText(/문제 이력/))
    expect(screen.getByText('지난번 빌드 실패')).toBeTruthy()
    expect(screen.getByText('푸시 원문')).toBeTruthy()
  })

  test('처음 불러올 때 스피너, 실패하면 메시지와 다시 시도', async () => {
    deployApi.getOne.mockRejectedValueOnce(new Error('배포를 찾을 수 없습니다')).mockImplementation(async () => base)
    await render(<DeployDetail />)
    expect(await screen.findByText('배포를 찾을 수 없습니다')).toBeTruthy()
    await fireEvent.press(screen.getByText('다시 시도'))
    expect(await screen.findByText('acme/api')).toBeTruthy()
  })
})

describe('배포 상세 화면 - 주소 카드', () => {
  test('주소를 누르면 브라우저로 연다', async () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    await open()
    await fireEvent.press(screen.getByText(ENDPOINT))
    expect(Linking.openURL).toHaveBeenCalledWith(ENDPOINT)
  })

  test('길게 누르거나 복사 버튼을 누르면 복사하고 잠깐 복사됨으로 바뀐다', async () => {
    await open()
    await fireEvent(screen.getByText(ENDPOINT), 'longPress')
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(ENDPOINT)
    expect(await screen.findByText('복사됨')).toBeTruthy()
    await tick(2000)
    expect(screen.getByText('복사')).toBeTruthy()
    await fireEvent.press(screen.getByText('복사'))
    expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(2)
  })

  test('열기·복사가 실패하면 빨간 알림', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('x'))
    await open()
    await fireEvent.press(screen.getByText(ENDPOINT))
    expect(await screen.findByText('주소를 열 수 없습니다')).toBeTruthy()
    Clipboard.setStringAsync.mockRejectedValue(new Error('x'))
    await fireEvent.press(screen.getByText('복사'))
    expect(await screen.findByText('주소를 복사하지 못했습니다')).toBeTruthy()
  })

  test('복사가 false 로 끝나면 복사 실패로 알린다 (복사됨으로 바꾸지 않는다)', async () => {
    Clipboard.setStringAsync.mockResolvedValue(false)
    await open()
    await fireEvent.press(screen.getByText('복사'))
    expect(await screen.findByText('주소를 복사하지 못했습니다')).toBeTruthy()
    expect(screen.queryByText('복사됨')).toBeNull()
  })

  test('http(s) 가 아닌 주소는 열지 않고 알린다', async () => {
    jest.spyOn(Linking, 'openURL').mockClear().mockResolvedValue(true)
    await open({ ...base, endpoint: 'javascript:alert(1)' })
    await fireEvent.press(screen.getByText('javascript:alert(1)'))
    expect(Linking.openURL).not.toHaveBeenCalled()
    expect(await screen.findByText('주소를 열 수 없습니다')).toBeTruthy()
  })

  test('헬스체크는 running 이 된 뒤 한 번만 부른다 (폴링이 여러 번 돌아도)', async () => {
    deployApi.getLogs.mockResolvedValueOnce(makeLogs(2)).mockResolvedValueOnce(makeLogs(1, 3)).mockResolvedValue([])
    await open()
    await tick(1500)
    await tick(1500)
    expect(deployApi.getOne.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(deployApi.getHealth).toHaveBeenCalledTimes(1)
  })
})

describe('배포 상세 화면 - 동작과 확인 창', () => {
  test('멈춤: 확인 창이 먼저, 그대로 두기를 먼저 놓고, 확인했을 때만 API 를 부른다', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    deployApi.stop.mockResolvedValue({})
    await open()
    await fireEvent.press(screen.getByText('멈춤'))
    expect(deployApi.stop).not.toHaveBeenCalled()
    const [title, message, buttons] = Alert.alert.mock.calls[0]
    expect(title).toBe('이 배포를 멈출까요?')
    expect(message).toBe('ECS 서비스를 내려서 컨테이너 요금이 멈춥니다. 주소는 접속되지 않게 됩니다. 이미지와 설정은 남겨 두므로 [다시 켜기] 한 번으로 다시 띄울 수 있습니다.')
    expect(buttons.map((b) => b.text)).toEqual(['그대로 두기', '멈춤'])
    expect(buttons[0].style).toBe('cancel')

    await act(async () => { alertButton('그대로 두기').onPress?.() })
    expect(deployApi.stop).not.toHaveBeenCalled()

    await act(async () => { alertButton('멈춤').onPress() })
    expect(deployApi.stop).toHaveBeenCalledWith('7')
  })

  test('삭제: 확인 창 문구와 순서, 확인하면 지우고 목록으로 돌아간다', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    deployApi.remove.mockResolvedValue(null)
    await open()
    await fireEvent.press(screen.getByText('삭제'))
    expect(deployApi.remove).not.toHaveBeenCalled()
    const [title, message, buttons] = Alert.alert.mock.calls[0]
    expect(title).toBe('이 배포를 삭제할까요?')
    expect(message).toBe('AWS에 만든 ECS 서비스와 ECR 이미지가 함께 지워져 이 배포의 요금이 모두 멈춥니다. 되돌릴 수 없습니다.')
    expect(buttons.map((b) => b.text)).toEqual(['그대로 두기', '삭제'])
    expect(buttons[1].style).toBe('destructive')

    await act(async () => { alertButton('삭제').onPress() })
    expect(deployApi.remove).toHaveBeenCalledWith('7')
    expect(mockDismissTo).toHaveBeenCalledWith('/')
    expect(mockReplace).not.toHaveBeenCalled()
  })

  test('삭제 뒤 돌아갈 화면이 없으면(주소로 바로 들어옴) 목록으로 바꾼다', async () => {
    mockCanGoBack = false
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    deployApi.remove.mockResolvedValue(null)
    await open()
    await fireEvent.press(screen.getByText('삭제'))
    await act(async () => { alertButton('삭제').onPress() })
    expect(mockReplace).toHaveBeenCalledWith('/')
    expect(mockDismissTo).not.toHaveBeenCalled()
  })

  test('삭제를 취소하면 아무것도 지우지 않는다', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    await open()
    await fireEvent.press(screen.getByText('삭제'))
    await act(async () => { alertButton('그대로 두기').onPress?.() })
    expect(deployApi.remove).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
    expect(mockDismissTo).not.toHaveBeenCalled()
  })

  test('failed: 만들어진 리소스 정리는 삭제 확인을 거친다', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    deployApi.remove.mockResolvedValue(null)
    await open(failedDeploy)
    await fireEvent.press(screen.getByText('만들어진 리소스 정리'))
    expect(deployApi.remove).not.toHaveBeenCalled()
    expect(Alert.alert.mock.calls[0][0]).toBe('이 배포를 삭제할까요?')
    await act(async () => { alertButton('삭제').onPress() })
    expect(deployApi.remove).toHaveBeenCalledWith('7')
  })

  test('다시 배포·다시 켜기는 확인 없이 바로 부른다', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    deployApi.redeploy.mockResolvedValue({})
    await open()
    await fireEvent.press(screen.getByText('다시 배포'))
    expect(deployApi.redeploy).toHaveBeenCalledWith('7')
    expect(Alert.alert).not.toHaveBeenCalled()
  })

  test('동작이 실패하면 빨간 알림을 보이고 버튼이 다시 풀린다', async () => {
    deployApi.redeploy.mockRejectedValueOnce(new Error('이미 진행 중입니다')).mockResolvedValue({})
    await open()
    await fireEvent.press(screen.getByText('다시 배포'))
    expect(await screen.findByText('이미 진행 중입니다')).toBeTruthy()
    expect(isDisabled('다시 배포')).toBe(false)
    await fireEvent.press(screen.getByText('다시 배포'))
    expect(deployApi.redeploy).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('이미 진행 중입니다')).toBeNull()
  })

  test('동작이 끝나기 전에는 버튼이 잠기고 같은 동작이 두 번 나가지 않는다', async () => {
    let finish
    deployApi.redeploy.mockImplementation(() => new Promise((r) => { finish = r }))
    await open()
    await fireEvent.press(screen.getByText('다시 배포'))
    await fireEvent.press(screen.getByText('다시 배포'))
    expect(deployApi.redeploy).toHaveBeenCalledTimes(1)
    expect(isDisabled('삭제')).toBe(true)
    expect(isDisabled('다시 배포')).toBe(true)
    await act(async () => { finish({}) })
    expect(isDisabled('삭제')).toBe(false)
  })
})

describe('배포 상세 화면 - 폴링과 로그', () => {
  test('running 이고 새 로그가 없으면 폴링이 멈춘다', async () => {
    await open()
    expect(deployApi.getOne).toHaveBeenCalledTimes(1)
    await tick(60000)
    expect(deployApi.getOne).toHaveBeenCalledTimes(1)
  })

  test('진행 중이면 1.5초마다 부르고 지난 로그 번호 이후만 받는다', async () => {
    deployApi.getLogs.mockResolvedValueOnce(makeLogs(3)).mockResolvedValue([])
    await open({ ...base, status: 'building', endpoint: null })
    expect(deployApi.getLogs).toHaveBeenLastCalledWith('7', 0)
    await tick(1499)
    expect(deployApi.getOne).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(deployApi.getOne).toHaveBeenCalledTimes(2)
    expect(deployApi.getLogs).toHaveBeenLastCalledWith('7', 3)
    expect(screen.getByLabelText('실행 로그 3줄')).toBeTruthy()
  })

  test('로그가 들어오는 동안은 running 이어도 계속 부르다가, 더 안 오면 멈춘다', async () => {
    deployApi.getLogs.mockResolvedValueOnce(makeLogs(2)).mockResolvedValue([])
    await open()
    await tick(1500)
    expect(deployApi.getOne).toHaveBeenCalledTimes(2)
    await tick(60000)
    expect(deployApi.getOne).toHaveBeenCalledTimes(2)
  })

  test('round 가 바뀌면(다시 배포) 폴링이 다시 시작되고 로그를 처음부터 받는다', async () => {
    deployApi.getLogs.mockResolvedValueOnce(makeLogs(2)).mockResolvedValue([])
    deployApi.redeploy.mockResolvedValue({})
    await open()
    await tick(1500)
    await tick(60000)
    const before = deployApi.getOne.mock.calls.length

    current = { ...base, status: 'queued', endpoint: null }
    deployApi.getLogs.mockResolvedValue(makeLogs(1, 50))
    await fireEvent.press(screen.getByText('다시 배포'))
    expect(deployApi.getOne.mock.calls.length).toBe(before + 1)
    expect(deployApi.getLogs).toHaveBeenLastCalledWith('7', 0)
    expect(screen.getByLabelText('실행 로그 1줄')).toBeTruthy()
    await tick(1500)
    expect(deployApi.getOne.mock.calls.length).toBe(before + 2)
  })

  test('stopped 에서 다시 켜기를 누르면 폴링이 다시 시작된다', async () => {
    deployApi.start.mockResolvedValue({})
    await open({ ...base, status: 'stopped', endpoint: null })
    await tick(60000)
    expect(deployApi.getOne).toHaveBeenCalledTimes(1)
    current = { ...base, status: 'queued', endpoint: null }
    await fireEvent.press(screen.getByText('다시 켜기'))
    expect(deployApi.start).toHaveBeenCalledWith('7')
    expect(deployApi.getOne).toHaveBeenCalledTimes(2)
    await tick(1500)
    expect(deployApi.getOne).toHaveBeenCalledTimes(3)
  })

  test('로그는 마지막 500줄만 보여 준다', async () => {
    deployApi.getLogs.mockResolvedValueOnce(makeLogs(400)).mockResolvedValueOnce(makeLogs(300, 401)).mockResolvedValue([])
    await open()
    await tick(1500)
    expect(screen.getByLabelText('실행 로그 500줄')).toBeTruthy()
  })

  test('로그가 없으면 기다리는 중 문구', async () => {
    await open()
    expect(screen.getByText('로그를 기다리는 중...')).toBeTruthy()
    expect(screen.getByLabelText('실행 로그 0줄')).toBeTruthy()
  })

  test('needs_input 이면 로그가 없어도 폴링이 멈추고, round 가 바뀌면(이어서 배포) 다시 시작된다', async () => {
    envApi.getAll.mockResolvedValue([])
    envApi.continueDeploy.mockResolvedValue({})
    await open({ ...base, status: 'needs_input', endpoint: null })
    await tick(60000)
    expect(deployApi.getOne).toHaveBeenCalledTimes(1)

    current = { ...base, status: 'queued', endpoint: null }
    await fireEvent.press(await screen.findByText('이어서 배포'))
    expect(envApi.continueDeploy).toHaveBeenCalledWith(7)
    expect(deployApi.getOne).toHaveBeenCalledTimes(2)
    await tick(1500)
    expect(deployApi.getOne).toHaveBeenCalledTimes(3)
  })

  test('언마운트하면 타이머가 남지 않는다', async () => {
    current = { ...base, status: 'building', endpoint: null }
    const { unmount } = await render(<DeployDetail />)
    await screen.findByText('acme/api')
    await tick(1500)
    await tick(1500)
    const calls = deployApi.getOne.mock.calls.length
    expect(calls).toBeGreaterThanOrEqual(3)
    await unmount()
    await tick(60000)
    expect(deployApi.getOne.mock.calls.length).toBe(calls)
  })
})

describe('배포 상세 화면 - 안전 영역과 글꼴', () => {
  test('스크롤 아래 여백에 하단 안전 영역을 더한다', async () => {
    const insets = { top: 0, left: 0, right: 0, bottom: 34 }
    current = base
    await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets }}>
        <DeployDetail />
      </SafeAreaProvider>,
    )
    await screen.findByText('acme/api')
    const outer = screen.getByTestId('detail-scroll')
    expect(StyleSheet.flatten(outer.props.contentContainerStyle).paddingBottom).toBe(24 * 2 + 34)
  })

  test('로그와 Dockerfile 은 monoFont 로 그린다', async () => {
    deployApi.getLogs.mockResolvedValue(makeLogs(1))
    await open({ ...base, dockerfile: 'FROM node:20' })
    await fireEvent.press(screen.getByText(/Dockerfile/))
    expect(StyleSheet.flatten(screen.getByText(/줄 1/).props.style).fontFamily).toBe(monoFont)
    expect(StyleSheet.flatten(screen.getByText(/FROM node:20/).props.style).fontFamily).toBe(monoFont)
  })
})
