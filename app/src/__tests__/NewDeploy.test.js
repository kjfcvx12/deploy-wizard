import { AccessibilityInfo, Platform, ScrollView, StyleSheet } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native'
import { accountApi, adviceApi, deployApi } from '../api'
import { readPickedBlock } from '../accounts/pickedBlock'
import NewDeploy from '../../app/new'

const mockReplace = jest.fn()
const mockPush = jest.fn()
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
// 화면 포커스 흉내 - 마운트 때 효과를 한 번 실행하고, 다시 포커스를 받는 것은 mockFocus.regain() 으로 만든다
const mockFocus = { effect: null, regain: () => mockFocus.effect() }
jest.mock('expo-router', () => {
  const React = require('react')
  return {
    useRouter: () => ({ replace: mockReplace, push: mockPush }),
    Stack: { Screen: () => null },
    useFocusEffect: (effect) => {
      mockFocus.effect = effect
      React.useEffect(() => effect(), [effect])
    },
  }
})
jest.mock('../accounts/pickedBlock', () => ({ readPickedBlock: jest.fn() }))
jest.mock('../api', () => ({
  accountApi: { getConnections: jest.fn(), getGithubRepositories: jest.fn() },
  adviceApi: { analyze: jest.fn() },
  deployApi: { getRemote: jest.fn(), create: jest.fn() },
}))

const advice = {
  tier: 'medium', confidence: 'medium', cpu: null, memory: null,
  cost: { monthly_min: null, monthly_max: null, currency: 'USD', basis_date: null, note: '트래픽에 따라 늘어납니다' },
  reasons: ['중간 사양으로 잡았습니다'],
  needs: [{ kind: 'env_vars', supported: true, message: null, count: 4 }],
  unknowns: [], language: 'python', support_level: 'official', app_dir: 'backend', commit_sha: 'abc',
}

// 연결 블록 한 개 (aws, gh 는 id 또는 null)
const block = (c_id, label, aws, gh) => ({
  c_id, label,
  aws: aws ? { a_id: aws, status: 'verified', aws_account_id: '2222' } : null,
  github: gh ? { g_id: gh, status: 'active', account_login: 'acme' } : null,
})
const URL_PLACEHOLDER = 'https://github.com/소유자/레포'

beforeEach(() => {
  mockFocus.effect = null
  mockReplace.mockClear()
  mockPush.mockClear()
  readPickedBlock.mockReset().mockResolvedValue(null)
  accountApi.getConnections.mockReset().mockResolvedValue([])
  accountApi.getGithubRepositories.mockReset().mockResolvedValue([])
  adviceApi.analyze.mockReset()
  deployApi.getRemote.mockReset()
  deployApi.create.mockReset()
})

// 주소 입력칸에 글자를 넣는다
const typeUrl = async (text) => { await fireEvent.changeText(screen.getByPlaceholderText(URL_PLACEHOLDER), text) }

describe('새 배포 화면 - 키보드와 안전 영역', () => {
  afterEach(() => { jest.restoreAllMocks() })

  test('안드로이드에서는 스크롤을 KeyboardAvoidingView(height) 가 감싼다 (기기에서는 확인하지 못했다)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    await render(<NewDeploy />)
    const wrapper = screen.getByTestId('keyboard-avoiding')
    expect(mockKavProps[mockKavProps.length - 1].behavior).toBe('height')
    expect(StyleSheet.flatten(wrapper.props.style).flex).toBe(1)
    expect(screen.getByTestId('new-scroll').props.automaticallyAdjustKeyboardInsets).toBe(true)
  })

  test('iOS 에서는 behavior 를 주지 않는다', async () => {
    await render(<NewDeploy />)
    expect(mockKavProps[mockKavProps.length - 1].behavior).toBeUndefined()
  })

  test('스크롤 아래 여백에 하단 안전 영역을 더한다', async () => {
    await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 34 } }}>
        <NewDeploy />
      </SafeAreaProvider>,
    )
    expect(StyleSheet.flatten(screen.getByTestId('new-scroll').props.contentContainerStyle).paddingBottom).toBe(24 * 2 + 34)
  })
})

describe('새 배포 화면', () => {
  test('주소가 비어 있으면 분석을 눌러도 아무것도 부르지 않는다', async () => {
    await render(<NewDeploy />)
    await fireEvent.press(screen.getByText('분석'))
    expect(adviceApi.analyze).not.toHaveBeenCalled()
  })

  test('브랜치를 고르지 않으면 branch 를 null 로 분석한다', async () => {
    adviceApi.analyze.mockResolvedValue(advice)
    await render(<NewDeploy />)
    await typeUrl('  https://github.com/acme/api  ')
    await fireEvent.press(screen.getByText('분석'))
    expect(adviceApi.analyze).toHaveBeenCalledWith({
      repo_url: 'https://github.com/acme/api', branch: null, aws_account_id: null, github_installation_id: null,
    })
    expect(await screen.findByText('분석 결과')).toBeTruthy()
    expect(screen.getByText('환경변수 4개 입력이 필요합니다')).toBeTruthy()
    expect(screen.getByText('앱 폴더: backend')).toBeTruthy()
  })

  test('주소를 고치면 분석 결과가 지워진다', async () => {
    adviceApi.analyze.mockResolvedValue(advice)
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('분석'))
    await screen.findByText('분석 결과')
    await typeUrl('https://github.com/acme/api2')
    expect(screen.queryByText('분석 결과')).toBeNull()
    expect(screen.queryByText('이 레포로 배포')).toBeNull()
  })

  test('다른 레포로 를 누르면 분석 결과가 지워진다', async () => {
    adviceApi.analyze.mockResolvedValue(advice)
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('분석'))
    await screen.findByText('분석 결과')
    await fireEvent.press(screen.getByText('다른 레포로'))
    expect(screen.queryByText('분석 결과')).toBeNull()
  })

  test('수정 뒤 늦게 도착한 분석 응답은 버린다', async () => {
    let resolve
    adviceApi.analyze.mockReturnValue(new Promise((r) => { resolve = r }))
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('분석'))
    expect(screen.getByText('분석 중...')).toBeTruthy()
    await typeUrl('https://github.com/acme/other')
    await act(async () => { resolve(advice) })
    expect(screen.queryByText('분석 결과')).toBeNull()
    expect(screen.getByText('분석')).toBeTruthy()
  })

  test('분석 중에 두 번 눌러도 요청은 한 번만 간다', async () => {
    adviceApi.analyze.mockReturnValue(new Promise(() => {}))
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/api')
    const button = screen.getByText('분석')
    await act(async () => {
      fireEvent.press(button)
      fireEvent.press(button)
    })
    expect(adviceApi.analyze).toHaveBeenCalledTimes(1)
  })

  test('400 이면 서버 detail 을 안내로 보이고 결과 패널은 없다', async () => {
    adviceApi.analyze.mockRejectedValue(new Error('https://github.com/소유자/레포 형식의 주소만 받습니다.'))
    await render(<NewDeploy />)
    await typeUrl('nope')
    await fireEvent.press(screen.getByText('분석'))
    expect(await screen.findByText('https://github.com/소유자/레포 형식의 주소만 받습니다.')).toBeTruthy()
    expect(screen.queryByText('분석 결과')).toBeNull()
    expect(screen.getByText('분석')).toBeTruthy()
  })

  test('이 레포로 배포 는 분석한 입력으로 만들고 상세 화면으로 바꿔 간다', async () => {
    adviceApi.analyze.mockResolvedValue(advice)
    deployApi.create.mockResolvedValue({ d_id: 7 })
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('분석'))
    await fireEvent.press(await screen.findByText('이 레포로 배포'))
    expect(deployApi.create).toHaveBeenCalledWith('https://github.com/acme/api', null, null, null)
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/deploys/7'))
  })

  test('배포 만들기가 실패하면 결과를 둔 채 오류를 보이고 다시 누를 수 있다', async () => {
    adviceApi.analyze.mockResolvedValue(advice)
    deployApi.create.mockRejectedValueOnce(new Error('진행 중인 배포가 있습니다')).mockResolvedValue({ d_id: 8 })
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('분석'))
    await fireEvent.press(await screen.findByText('이 레포로 배포'))
    expect(await screen.findByText('진행 중인 배포가 있습니다')).toBeTruthy()
    expect(screen.getByText('분석 결과')).toBeTruthy()
    await fireEvent.press(screen.getByText('이 레포로 배포'))
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/deploys/8'))
  })

  test('배포 중에 두 번 눌러도 배포는 한 번만 만든다', async () => {
    adviceApi.analyze.mockResolvedValue(advice)
    deployApi.create.mockReturnValue(new Promise(() => {}))
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('분석'))
    const button = await screen.findByText('이 레포로 배포')
    await act(async () => {
      fireEvent.press(button)
      fireEvent.press(button)
    })
    expect(deployApi.create).toHaveBeenCalledTimes(1)
  })

  test('브랜치를 고르면 그 브랜치로 분석하고, 다시 고르면 이전 결과는 지워진다', async () => {
    adviceApi.analyze.mockResolvedValue(advice)
    deployApi.getRemote.mockResolvedValue({ default_branch: 'main', branches: ['main', 'dev'] })
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('브랜치 고르기'))
    expect(deployApi.getRemote).toHaveBeenCalledWith('https://github.com/acme/api', '')
    await fireEvent.press(await screen.findByText('dev'))
    expect(screen.getByText('main (기본)')).toBeTruthy()
    await fireEvent.press(screen.getByText('분석'))
    await screen.findByText('분석 결과')
    expect(adviceApi.analyze).toHaveBeenCalledWith(expect.objectContaining({ branch: 'dev' }))
    await fireEvent.press(screen.getByText('main (기본)'))
    expect(screen.queryByText('분석 결과')).toBeNull()
  })

  test('브랜치를 불러오지 못하면 오류를 보인다', async () => {
    deployApi.getRemote.mockRejectedValue(new Error('레포를 조회할 수 없습니다 :없음'))
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/none')
    await fireEvent.press(screen.getByText('브랜치 고르기'))
    expect(await screen.findByText('레포를 조회할 수 없습니다 :없음')).toBeTruthy()
  })

  test('연결 블록이 없으면 연결 선택을 그리지 않고 public 안내만 보인다', async () => {
    await render(<NewDeploy />)
    await waitFor(() => expect(accountApi.getConnections).toHaveBeenCalled())
    expect(screen.queryByText(/연결 안 함/)).toBeNull()
    expect(screen.getByText(/지금은 public 레포만 됩니다/)).toBeTruthy()
  })

  test('연결 블록을 고르면 그 AWS 계정과 GitHub 설치로 분석하고 레포 목록이 나온다', async () => {
    accountApi.getConnections.mockResolvedValue([block(1, '회사', 5, 3), block(2, '개인', null, null)])
    accountApi.getGithubRepositories.mockResolvedValue([
      { full_name: 'acme/secret', html_url: 'https://github.com/acme/secret', private: true, default_branch: 'main' },
      { full_name: 'acme/open', html_url: 'https://github.com/acme/open', private: false, default_branch: 'main' },
    ])
    adviceApi.analyze.mockResolvedValue(advice)
    await render(<NewDeploy />)
    await fireEvent.press(await screen.findByText('회사 — AWS 2222 · GitHub acme'))
    expect(accountApi.getGithubRepositories).toHaveBeenCalledWith(3)
    expect(await screen.findByText('acme/secret')).toBeTruthy()
    expect(screen.getByText('private')).toBeTruthy()
    expect(screen.getByText('public')).toBeTruthy()
    await fireEvent.press(screen.getByText('acme/open'))
    expect(screen.getByPlaceholderText('레포를 고르거나 주소를 입력하세요').props.value).toBe('https://github.com/acme/open')
    await fireEvent.press(screen.getByText('분석'))
    expect(adviceApi.analyze).toHaveBeenCalledWith({
      repo_url: 'https://github.com/acme/open', branch: null, aws_account_id: '5', github_installation_id: '3',
    })
  })

  test('블록이 하나뿐이면 미리 골라 둔다', async () => {
    accountApi.getConnections.mockResolvedValue([block(1, '회사', 5, 3)])
    await render(<NewDeploy />)
    await waitFor(() => expect(accountApi.getGithubRepositories).toHaveBeenCalledWith(3))
    expect(screen.getByText(/GitHub 연결을 골랐으니 private 레포도 됩니다/)).toBeTruthy()
  })

  test('연결을 바꾸면 분석 결과가 지워진다', async () => {
    accountApi.getConnections.mockResolvedValue([block(1, '회사', 5, 3), block(2, '개인', 6, null)])
    adviceApi.analyze.mockResolvedValue(advice)
    await render(<NewDeploy />)
    await fireEvent.press(await screen.findByText('개인 — AWS 2222 · GitHub 없음 (public만)'))
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('분석'))
    await screen.findByText('분석 결과')
    await fireEvent.press(screen.getByText('연결 안 함 (개발 계정 · public 레포만)'))
    expect(screen.queryByText('분석 결과')).toBeNull()
  })

  test('연결 목록을 못 불러와도 화면은 쓸 수 있다', async () => {
    accountApi.getConnections.mockRejectedValue(new Error('x'))
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/api')
    expect(screen.getByText('분석')).toBeTruthy()
  })
})

describe('새 배포 화면 - 늦은 응답과 접근성 (수정 1차)', () => {
  const remoteData = { default_branch: 'main', branches: ['main', 'dev'] }

  test('주소를 바꾼 뒤 늦게 온 브랜치 목록은 버린다 (분석은 새 주소, branch null)', async () => {
    let resolve
    deployApi.getRemote.mockReturnValue(new Promise((r) => { resolve = r }))
    adviceApi.analyze.mockResolvedValue(advice)
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/a')
    await fireEvent.press(screen.getByText('브랜치 고르기'))
    await typeUrl('https://github.com/acme/b')
    await act(async () => { resolve(remoteData) })
    expect(screen.queryByText('main (기본)')).toBeNull()
    expect(screen.getByText('브랜치 고르기')).toBeTruthy()
    await fireEvent.press(screen.getByText('분석'))
    expect(adviceApi.analyze).toHaveBeenCalledWith(expect.objectContaining({ repo_url: 'https://github.com/acme/b', branch: null }))
  })

  test('주소를 바꾼 뒤 늦게 온 브랜치 오류는 보이지 않고 버튼도 풀려 있다', async () => {
    let reject
    deployApi.getRemote.mockReturnValue(new Promise((_, r) => { reject = r }))
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/a')
    await fireEvent.press(screen.getByText('브랜치 고르기'))
    await typeUrl('https://github.com/acme/b')
    await act(async () => { reject(new Error('레포를 조회할 수 없습니다 :옛 주소')) })
    expect(screen.queryByText('레포를 조회할 수 없습니다 :옛 주소')).toBeNull()
    adviceApi.analyze.mockResolvedValue(advice)
    await fireEvent.press(screen.getByText('분석'))
    expect(adviceApi.analyze).toHaveBeenCalledTimes(1)
  })

  test('연결을 바꾼 뒤 늦게 온 브랜치 목록도 버린다', async () => {
    let resolve
    accountApi.getConnections.mockResolvedValue([block(1, '회사', 5, 3), block(2, '개인', 6, null)])
    deployApi.getRemote.mockReturnValue(new Promise((r) => { resolve = r }))
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/a')
    await fireEvent.press(screen.getByText('브랜치 고르기'))
    await fireEvent.press(await screen.findByText('개인 — AWS 2222 · GitHub 없음 (public만)'))
    await act(async () => { resolve(remoteData) })
    expect(screen.queryByText('main (기본)')).toBeNull()
  })

  test('연결이 하나뿐이라 미리 골라질 때도 분석 결과를 지운다', async () => {
    let resolve
    accountApi.getConnections.mockReturnValue(new Promise((r) => { resolve = r }))
    adviceApi.analyze.mockResolvedValue(advice)
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/a')
    await fireEvent.press(screen.getByText('분석'))
    await screen.findByText('분석 결과')
    await act(async () => { resolve([block(1, '회사', 5, 3)]) })
    expect(screen.queryByText('분석 결과')).toBeNull()
  })

  test('주소가 없는 레포 항목이 와도 죽지 않고 나머지만 보인다', async () => {
    accountApi.getConnections.mockResolvedValue([block(1, '회사', 5, 3)])
    accountApi.getGithubRepositories.mockResolvedValue([
      { full_name: 'acme/no-url', private: false }, null, { html_url: 'https://github.com/acme/x' },
      { full_name: 'acme/ok', html_url: 'https://github.com/acme/ok', private: false },
    ])
    await render(<NewDeploy />)
    expect(await screen.findByText('acme/ok')).toBeTruthy()
    expect(screen.queryByText('acme/no-url')).toBeNull()
  })

  test('고른 연결은 radio 의 checked 상태로 알려 준다', async () => {
    accountApi.getConnections.mockResolvedValue([block(1, '회사', 5, 3), block(2, '개인', 6, null)])
    await render(<NewDeploy />)
    await fireEvent.press(await screen.findByText('개인 — AWS 2222 · GitHub 없음 (public만)'))
    expect(screen.getByRole('radio', { name: /개인/, checked: true })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /회사/, checked: false })).toBeTruthy()
  })

  test('새 결과가 처음 배치될 때만 스크롤하고 제목으로 초점을 옮긴다 (접기·펴기 재배치에는 가만히 둔다)', async () => {
    const scrollTo = ScrollView.prototype.scrollTo
    scrollTo.mockClear()
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {})
    adviceApi.analyze.mockResolvedValue({ ...advice, unknowns: ['하나'] })
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('분석'))
    await screen.findByText('분석 결과')
    const layout = (y) => ({ nativeEvent: { layout: { x: 0, y, width: 300, height: 400 } } })
    await fireEvent(screen.getByTestId('advice-panel'), 'layout', layout(300))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ y: 300, animated: true })
    expect(focus).toHaveBeenCalledTimes(1)
    expect(focus.mock.calls[0][1]).toBe('focus')
    await fireEvent.press(screen.getByText('알 수 없었던 것 (1)'))
    await fireEvent(screen.getByTestId('advice-panel'), 'layout', layout(300))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
    // 새 분석 결과가 나오면 다시 한 번
    await typeUrl('https://github.com/acme/api2')
    await fireEvent.press(screen.getByText('분석'))
    await screen.findByText('분석 결과')
    await fireEvent(screen.getByTestId('advice-panel'), 'layout', layout(310))
    expect(scrollTo).toHaveBeenCalledTimes(2)
    expect(focus).toHaveBeenCalledTimes(2)
    focus.mockRestore()
  })
})

describe('새 배포 화면 - 기본으로 고른 연결 블록 (C2 5)', () => {
  const HINT = '연결된 계정이 없습니다. 계정 연결을 하면 비공개 레포와 내 AWS 계정으로 배포할 수 있습니다.'
  const TWO = [block(1, '회사', 5, 3), block(2, '개인', 6, 4)]

  test('여러 블록이면 계정 연결 화면에서 선택해 둔 블록을 미리 고르고 그 레포 목록을 부른다', async () => {
    accountApi.getConnections.mockResolvedValue(TWO)
    readPickedBlock.mockResolvedValue(2)
    await render(<NewDeploy />)
    expect(await screen.findByRole('radio', { name: /개인/, checked: true })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /회사/, checked: false })).toBeTruthy()
    expect(accountApi.getGithubRepositories).toHaveBeenCalledTimes(1)
    expect(accountApi.getGithubRepositories).toHaveBeenCalledWith(4)
  })

  test('선택해 둔 블록으로 분석을 시작한다 (AWS·GitHub 번호가 그 블록의 것)', async () => {
    accountApi.getConnections.mockResolvedValue(TWO)
    readPickedBlock.mockResolvedValue(2)
    adviceApi.analyze.mockResolvedValue(advice)
    await render(<NewDeploy />)
    await screen.findByRole('radio', { name: /개인/, checked: true })
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('분석'))
    expect(adviceApi.analyze).toHaveBeenCalledWith(expect.objectContaining({ aws_account_id: '6', github_installation_id: '4' }))
  })

  test('여러 블록인데 선택해 둔 것이 없으면 연결 안 함으로 시작한다', async () => {
    accountApi.getConnections.mockResolvedValue(TWO)
    await render(<NewDeploy />)
    expect(await screen.findByRole('radio', { name: /연결 안 함/, checked: true })).toBeTruthy()
    expect(accountApi.getGithubRepositories).not.toHaveBeenCalled()
  })

  test('선택해 둔 블록이 이제 쓸 수 없으면(목록에 없으면) 연결 안 함으로 시작한다', async () => {
    accountApi.getConnections.mockResolvedValue([...TWO, block(9, '끊긴 블록', null, null)])
    readPickedBlock.mockResolvedValue(9)
    await render(<NewDeploy />)
    expect(await screen.findByRole('radio', { name: /연결 안 함/, checked: true })).toBeTruthy()
    expect(accountApi.getGithubRepositories).not.toHaveBeenCalled()
  })

  test('선택해 둔 블록이 쓸 수 없고 쓸 수 있는 블록이 하나뿐이면 그 하나를 고른다', async () => {
    accountApi.getConnections.mockResolvedValue([block(1, '회사', 5, 3), block(9, '끊긴 블록', null, null)])
    readPickedBlock.mockResolvedValue(9)
    await render(<NewDeploy />)
    expect(await screen.findByRole('radio', { name: /회사/, checked: true })).toBeTruthy()
    expect(accountApi.getGithubRepositories).toHaveBeenCalledWith(3)
  })

  test('선택해 둔 블록 번호가 목록에 없어도 쓸 수 있는 블록이 하나뿐이면 그 하나를 고른다', async () => {
    accountApi.getConnections.mockResolvedValue([block(1, '회사', 5, 3)])
    readPickedBlock.mockResolvedValue(77)
    await render(<NewDeploy />)
    expect(await screen.findByRole('radio', { name: /회사/, checked: true })).toBeTruthy()
  })

  test('기본으로 골라질 때 이전 분석 결과를 지운다 (선택해 둔 블록)', async () => {
    let resolve
    accountApi.getConnections.mockReturnValue(new Promise((r) => { resolve = r }))
    readPickedBlock.mockResolvedValue(2)
    adviceApi.analyze.mockResolvedValue(advice)
    await render(<NewDeploy />)
    await typeUrl('https://github.com/acme/a')
    await fireEvent.press(screen.getByText('분석'))
    await screen.findByText('분석 결과')
    await act(async () => { resolve(TWO) })
    expect(screen.queryByText('분석 결과')).toBeNull()
    expect(screen.getByRole('radio', { name: /개인/, checked: true })).toBeTruthy()
  })

  test('기본으로 고른 뒤 다른 블록을 고르면 늦게 온 이전 레포 목록은 버린다', async () => {
    let resolveFirst
    accountApi.getConnections.mockResolvedValue(TWO)
    readPickedBlock.mockResolvedValue(2)
    accountApi.getGithubRepositories
      .mockReturnValueOnce(new Promise((r) => { resolveFirst = r }))
      .mockResolvedValueOnce([{ full_name: 'acme/first', html_url: 'https://github.com/acme/first', private: false }])
    await render(<NewDeploy />)
    await fireEvent.press(await screen.findByText('회사 — AWS 2222 · GitHub acme'))
    expect(await screen.findByText('acme/first')).toBeTruthy()
    await act(async () => { resolveFirst([{ full_name: 'acme/late', html_url: 'https://github.com/acme/late', private: false }]) })
    expect(screen.queryByText('acme/late')).toBeNull()
    expect(screen.getByText('acme/first')).toBeTruthy()
  })

  test('화면을 떠난 뒤 늦게 온 연결 목록은 버린다 (레포 목록을 부르지 않고 경고도 없다)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    let resolve
    accountApi.getConnections.mockReturnValue(new Promise((r) => { resolve = r }))
    const { unmount } = await render(<NewDeploy />)
    await unmount()
    await act(async () => { resolve([block(1, '회사', 5, 3)]) })
    expect(accountApi.getGithubRepositories).not.toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  test('쓸 수 있는 블록이 없으면 안내와 [계정 연결 열기] 버튼이 나오고, 누르면 /accounts 로 간다', async () => {
    await render(<NewDeploy />)
    expect(await screen.findByText(HINT)).toBeTruthy()
    const button = screen.getByRole('button', { name: '계정 연결 열기' })
    expect(StyleSheet.flatten(button.props.style).minHeight).toBeGreaterThanOrEqual(44)
    await fireEvent.press(button)
    expect(mockPush).toHaveBeenCalledWith('/accounts')
  })

  test('끊긴 블록만 있어도 안내가 나온다', async () => {
    accountApi.getConnections.mockResolvedValue([block(9, '끊긴 블록', null, null)])
    await render(<NewDeploy />)
    expect(await screen.findByText(HINT)).toBeTruthy()
    expect(screen.queryByText(/연결 안 함/)).toBeNull()
  })

  test('연결 목록을 받는 동안에는 안내가 번쩍이지 않는다', async () => {
    let resolve
    accountApi.getConnections.mockReturnValue(new Promise((r) => { resolve = r }))
    await render(<NewDeploy />)
    expect(screen.queryByText(HINT)).toBeNull()
    expect(screen.queryByText('계정 연결 열기')).toBeNull()
    await act(async () => { resolve([]) })
    expect(screen.getByText(HINT)).toBeTruthy()
  })

  test('연결 목록을 못 받으면 안내를 따로 보이지 않는다', async () => {
    accountApi.getConnections.mockRejectedValue(new Error('x'))
    await render(<NewDeploy />)
    await waitFor(() => expect(accountApi.getConnections).toHaveBeenCalled())
    expect(screen.queryByText(HINT)).toBeNull()
    expect(screen.queryByText('계정 연결 열기')).toBeNull()
  })

  test('쓸 수 있는 블록이 있으면 안내는 없다', async () => {
    accountApi.getConnections.mockResolvedValue(TWO)
    await render(<NewDeploy />)
    await screen.findByText('회사 — AWS 2222 · GitHub acme')
    expect(screen.queryByText(HINT)).toBeNull()
  })
})

describe('새 배포 화면 - 돌아왔을 때 연결 목록 다시 받기 (최종 검토 3)', () => {
  const HINT = '연결된 계정이 없습니다. 계정 연결을 하면 비공개 레포와 내 AWS 계정으로 배포할 수 있습니다.'
  const ONE_BLOCK = [block(1, '회사', 5, 3)]
  const TWO = [block(1, '회사', 5, 3), block(2, '개인', 6, 4)]
  const regain = async () => { await act(async () => { mockFocus.regain() }) }

  test('처음 열 때는 포커스가 연결 목록을 한 번 더 받지 않는다', async () => {
    await render(<NewDeploy />)
    await screen.findByText(HINT)
    expect(accountApi.getConnections).toHaveBeenCalledTimes(1)
  })

  test('계정 연결을 하고 돌아오면 안내가 사라지고 그 블록이 미리 골라진다', async () => {
    await render(<NewDeploy />)
    expect(await screen.findByText(HINT)).toBeTruthy()
    accountApi.getConnections.mockResolvedValue(ONE_BLOCK)
    await regain()
    expect(await screen.findByRole('radio', { name: /회사/, checked: true })).toBeTruthy()
    expect(screen.queryByText(HINT)).toBeNull()
    expect(accountApi.getConnections).toHaveBeenCalledTimes(2)
    expect(accountApi.getGithubRepositories).toHaveBeenCalledWith(3)
  })

  test('쓸 수 있는 블록이 여럿이고 선택해 둔 것이 있으면 돌아왔을 때 그 블록을 고른다', async () => {
    await render(<NewDeploy />)
    await screen.findByText(HINT)
    accountApi.getConnections.mockResolvedValue(TWO)
    readPickedBlock.mockResolvedValue(2)
    await regain()
    expect(await screen.findByRole('radio', { name: /개인/, checked: true })).toBeTruthy()
  })

  test('쓸 수 있는 블록이 여럿인데 선택해 둔 것이 없으면 연결 안 함 그대로 둔다', async () => {
    await render(<NewDeploy />)
    await screen.findByText(HINT)
    accountApi.getConnections.mockResolvedValue(TWO)
    await regain()
    expect(await screen.findByRole('radio', { name: /연결 안 함/, checked: true })).toBeTruthy()
    expect(screen.queryByText(HINT)).toBeNull()
  })

  test('사용자가 직접 고른 블록은 돌아와도 덮지 않는다 (연결 안 함도 마찬가지)', async () => {
    accountApi.getConnections.mockResolvedValue(TWO)
    await render(<NewDeploy />)
    await fireEvent.press(await screen.findByText('개인 — AWS 2222 · GitHub acme'))
    readPickedBlock.mockResolvedValue(1)
    await regain()
    await waitFor(() => expect(accountApi.getConnections).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('radio', { name: /개인/, checked: true })).toBeTruthy()
    // 연결 안 함을 골랐을 때도 기본값을 다시 적용하지 않는다
    await fireEvent.press(screen.getByText('연결 안 함 (개발 계정 · public 레포만)'))
    await regain()
    await waitFor(() => expect(accountApi.getConnections).toHaveBeenCalledTimes(3))
    expect(screen.getByRole('radio', { name: /연결 안 함/, checked: true })).toBeTruthy()
  })

  test('고른 블록이 사라지면 선택을 비우고 분석 결과도 지운다', async () => {
    accountApi.getConnections.mockResolvedValue(TWO)
    adviceApi.analyze.mockResolvedValue(advice)
    await render(<NewDeploy />)
    await fireEvent.press(await screen.findByText('개인 — AWS 2222 · GitHub acme'))
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('분석'))
    await screen.findByText('분석 결과')
    accountApi.getConnections.mockResolvedValue([TWO[0]])
    await regain()
    await waitFor(() => expect(screen.queryByText('분석 결과')).toBeNull())
    expect(screen.queryByText(/개인/)).toBeNull()
    expect(screen.getByRole('radio', { name: /연결 안 함/, checked: true })).toBeTruthy()
  })

  test('고른 블록을 쓸 수 없게 되면(연결이 끊기면) 선택을 비운다', async () => {
    accountApi.getConnections.mockResolvedValue(TWO)
    await render(<NewDeploy />)
    await fireEvent.press(await screen.findByText('개인 — AWS 2222 · GitHub acme'))
    accountApi.getConnections.mockResolvedValue([TWO[0], block(2, '개인', null, null)])
    await regain()
    await waitFor(() => expect(screen.queryByText(/개인/)).toBeNull())
    expect(screen.getByRole('radio', { name: /연결 안 함/, checked: true })).toBeTruthy()
  })

  test('마지막 블록이 사라지면 안내가 다시 나온다', async () => {
    accountApi.getConnections.mockResolvedValue(ONE_BLOCK)
    await render(<NewDeploy />)
    await screen.findByRole('radio', { name: /회사/, checked: true })
    accountApi.getConnections.mockResolvedValue([])
    await regain()
    expect(await screen.findByText(HINT)).toBeTruthy()
  })

  test('바뀐 것이 없으면 분석 결과를 그대로 둔다', async () => {
    accountApi.getConnections.mockResolvedValue(TWO)
    adviceApi.analyze.mockResolvedValue(advice)
    await render(<NewDeploy />)
    await fireEvent.press(await screen.findByText('개인 — AWS 2222 · GitHub acme'))
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('분석'))
    await screen.findByText('분석 결과')
    // 같은 내용이 새 객체로 다시 와도
    accountApi.getConnections.mockResolvedValue(TWO.map((item) => ({ ...item })))
    await regain()
    await waitFor(() => expect(accountApi.getConnections).toHaveBeenCalledTimes(2))
    expect(screen.getByText('분석 결과')).toBeTruthy()
    expect(screen.getByRole('radio', { name: /개인/, checked: true })).toBeTruthy()
  })

  test('기본으로 골라 둔 블록도 바뀐 것이 없으면 분석 결과를 지우지 않는다', async () => {
    accountApi.getConnections.mockResolvedValue(ONE_BLOCK)
    adviceApi.analyze.mockResolvedValue(advice)
    await render(<NewDeploy />)
    await screen.findByRole('radio', { name: /회사/, checked: true })
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('분석'))
    await screen.findByText('분석 결과')
    await regain()
    await waitFor(() => expect(accountApi.getConnections).toHaveBeenCalledTimes(2))
    expect(screen.getByText('분석 결과')).toBeTruthy()
    expect(accountApi.getGithubRepositories).toHaveBeenCalledTimes(1)
  })

  test('고른 블록의 AWS·GitHub 연결이 바뀌면 분석 결과를 지운다 (낡은 번호로 배포하지 않게)', async () => {
    accountApi.getConnections.mockResolvedValue(TWO)
    adviceApi.analyze.mockResolvedValue(advice)
    await render(<NewDeploy />)
    await fireEvent.press(await screen.findByText('개인 — AWS 2222 · GitHub acme'))
    await typeUrl('https://github.com/acme/api')
    await fireEvent.press(screen.getByText('분석'))
    await screen.findByText('분석 결과')
    accountApi.getConnections.mockResolvedValue([TWO[0], block(2, '개인', 6, 9)])
    await regain()
    await waitFor(() => expect(screen.queryByText('분석 결과')).toBeNull())
    expect(screen.getByRole('radio', { name: /개인/, checked: true })).toBeTruthy()
    expect(accountApi.getGithubRepositories).toHaveBeenLastCalledWith(9)
  })

  test('돌아와 다시 받는 목록이 실패하면 지금 화면을 그대로 둔다', async () => {
    accountApi.getConnections.mockResolvedValue(TWO)
    await render(<NewDeploy />)
    await fireEvent.press(await screen.findByText('개인 — AWS 2222 · GitHub acme'))
    accountApi.getConnections.mockRejectedValue(new Error('x'))
    await regain()
    await waitFor(() => expect(accountApi.getConnections).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('radio', { name: /개인/, checked: true })).toBeTruthy()
    expect(screen.queryByText(HINT)).toBeNull()
  })

  test('늦게 온 이전 응답은 버린다 (나중에 보낸 요청이 이긴다)', async () => {
    let resolveSlow
    await render(<NewDeploy />)
    await screen.findByText(HINT)
    accountApi.getConnections.mockReturnValueOnce(new Promise((r) => { resolveSlow = r })).mockResolvedValue(ONE_BLOCK)
    await regain()
    await regain()
    expect(await screen.findByRole('radio', { name: /회사/, checked: true })).toBeTruthy()
    await act(async () => { resolveSlow([]) })
    expect(screen.getByRole('radio', { name: /회사/, checked: true })).toBeTruthy()
    expect(screen.queryByText(HINT)).toBeNull()
  })

  test('화면을 떠난 뒤 늦게 온 응답은 버린다 (경고도 없다)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    let resolve
    const { unmount } = await render(<NewDeploy />)
    await screen.findByText(HINT)
    accountApi.getConnections.mockReturnValue(new Promise((r) => { resolve = r }))
    await regain()
    await unmount()
    await act(async () => { resolve(ONE_BLOCK) })
    expect(accountApi.getGithubRepositories).not.toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
