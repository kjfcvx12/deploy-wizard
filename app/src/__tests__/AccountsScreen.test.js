import { StrictMode } from 'react'
import { Platform, ScrollView, StyleSheet } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native'
import { accountApi } from '../api'
import { confirmAction } from '../confirm'
import { DELETE_TEXT } from '../accounts/constants'
import { readPickedBlock, writePickedBlock } from '../accounts/pickedBlock'
import AccountsScreen from '../../app/accounts'

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
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
}))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }))
jest.mock('../api', () => ({
  BASE_URL: 'http://localhost:8081',
  accountApi: {
    getConnections: jest.fn(),
    listAws: jest.fn(),
    listGithub: jest.fn(),
    createConnection: jest.fn(),
    deleteConnection: jest.fn(),
    createConnectionAws: jest.fn(),
    reverifyAws: jest.fn(),
    attachRole: jest.fn(),
    getTemplateStatus: jest.fn(),
    setConnectionAws: jest.fn(),
  },
}))
jest.mock('../confirm', () => ({ confirmAction: jest.fn() }))
jest.mock('../accounts/pickedBlock', () => ({ readPickedBlock: jest.fn(), writePickedBlock: jest.fn() }))

const block = (c_id, label) => ({ c_id, label, aws: null, github: null })
const ONE = [block(1, '운영 계정')]
const TWO = [block(1, '운영 계정'), block(2, '개발 계정')]

beforeEach(() => {
  mockKavProps.length = 0
  accountApi.getConnections.mockReset().mockResolvedValue(TWO)
  accountApi.listAws.mockReset().mockResolvedValue([])
  accountApi.listGithub.mockReset().mockResolvedValue([])
  accountApi.createConnection.mockReset()
  accountApi.deleteConnection.mockReset()
  accountApi.createConnectionAws.mockReset()
  accountApi.reverifyAws.mockReset()
  accountApi.attachRole.mockReset()
  accountApi.getTemplateStatus.mockReset()
  accountApi.setConnectionAws.mockReset()
  confirmAction.mockReset()
  readPickedBlock.mockReset().mockResolvedValue(null)
  writePickedBlock.mockReset().mockResolvedValue(undefined)
})

describe('계정 연결 화면 - 불러오기', () => {
  test('불러오는 동안 스피너, 끝나면 블록 카드', async () => {
    let resolve
    accountApi.getConnections.mockReturnValue(new Promise((r) => { resolve = r }))
    await render(<AccountsScreen />)
    expect(screen.getByLabelText('불러오는 중')).toBeTruthy()
    await act(async () => { resolve(TWO) })
    expect(await screen.findByText('운영 계정')).toBeTruthy()
    expect(screen.getByText('개발 계정')).toBeTruthy()
    expect(screen.queryByLabelText('불러오는 중')).toBeNull()
  })

  test('블록 목록, AWS 목록, GitHub 목록을 함께 부른다', async () => {
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    expect(accountApi.getConnections).toHaveBeenCalledTimes(1)
    expect(accountApi.listAws).toHaveBeenCalledTimes(1)
    expect(accountApi.listGithub).toHaveBeenCalledTimes(1)
  })

  test('비어 있으면 안내와 채운 ＋ 블록 추가 버튼', async () => {
    accountApi.getConnections.mockResolvedValue([])
    await render(<AccountsScreen />)
    expect(await screen.findByText(/아직 블록이 없습니다/)).toBeTruthy()
    expect(screen.getAllByText('＋ 블록 추가')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '＋ 블록 추가' })).toBeEnabled()
  })

  test('불러오기에 실패하면 한국어 안내와 다시 시도 버튼, 누르면 다시 부른다', async () => {
    accountApi.getConnections.mockRejectedValueOnce(new Error('서버에 연결할 수 없습니다'))
    await render(<AccountsScreen />)
    expect(await screen.findByText(/계정 연결을 불러오지 못했습니다/)).toBeTruthy()
    expect(screen.getByText(/서버에 연결할 수 없습니다/)).toBeTruthy()
    await fireEvent.press(screen.getByText('다시 시도'))
    expect(await screen.findByText('운영 계정')).toBeTruthy()
    expect(accountApi.getConnections).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('다시 시도')).toBeNull()
  })

  test('AWS 목록만 실패해도 한 번에 실패로 본다', async () => {
    accountApi.listAws.mockRejectedValueOnce(new Error('AWS 목록 실패'))
    await render(<AccountsScreen />)
    expect(await screen.findByText(/AWS 목록 실패/)).toBeTruthy()
    expect(screen.queryByText('운영 계정')).toBeNull()
  })

  test('언마운트한 뒤 늦게 온 응답은 버린다 (경고 없이)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    let resolve
    accountApi.getConnections.mockReturnValue(new Promise((r) => { resolve = r }))
    const { unmount } = await render(<AccountsScreen />)
    await unmount()
    await act(async () => { resolve(TWO) })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('계정 연결 화면 - 선택', () => {
  test('저장해 둔 블록이 아직 있으면 선택됨으로 시작한다', async () => {
    readPickedBlock.mockResolvedValue(2)
    await render(<AccountsScreen />)
    await screen.findByText('개발 계정')
    expect(screen.getAllByText('선택됨')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '개발 계정 선택됨' })).toBeDisabled()
    expect(screen.getAllByText('선택')).toHaveLength(1)
  })

  test('저장해 둔 블록이 사라졌으면 고른 것이 없다', async () => {
    readPickedBlock.mockResolvedValue(99)
    await render(<AccountsScreen />)
    await screen.findByText('개발 계정')
    expect(screen.queryByText('선택됨')).toBeNull()
    expect(screen.getAllByText('선택')).toHaveLength(2)
  })

  test('블록이 하나뿐이면 그 블록이 선택됨이다', async () => {
    accountApi.getConnections.mockResolvedValue(ONE)
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    expect(screen.getByText('선택됨')).toBeTruthy()
  })

  test('선택을 누르면 그 블록을 저장하고 선택됨으로 바뀐다', async () => {
    await render(<AccountsScreen />)
    await screen.findByText('개발 계정')
    await fireEvent.press(screen.getAllByText('선택')[1])
    expect(writePickedBlock).toHaveBeenCalledWith(2)
    expect(screen.getAllByText('선택됨')).toHaveLength(1)
    expect(screen.getAllByText('선택')).toHaveLength(1)
  })
})

describe('계정 연결 화면 - 블록 추가', () => {
  // 블록 추가 폼을 연다
  const openForm = async () => {
    await fireEvent.press(await screen.findByText('＋ 블록 추가'))
  }

  test('빈 이름이나 공백만 있으면 추가 버튼이 잠겨 있다', async () => {
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await openForm()
    expect(screen.getByRole('button', { name: '추가' })).toBeDisabled()
    await fireEvent.changeText(screen.getByPlaceholderText('예: 운영 계정'), '   ')
    expect(screen.getByRole('button', { name: '추가' })).toBeDisabled()
    await fireEvent.press(screen.getByText('추가'))
    expect(accountApi.createConnection).not.toHaveBeenCalled()
    await fireEvent.changeText(screen.getByPlaceholderText('예: 운영 계정'), '새 블록')
    expect(screen.getByRole('button', { name: '추가' })).toBeEnabled()
  })

  test('추가하면 createConnection(이름)을 부르고 목록을 다시 받아 폼을 닫는다', async () => {
    accountApi.getConnections.mockResolvedValueOnce(TWO).mockResolvedValue([...TWO, block(3, '새 블록')])
    accountApi.createConnection.mockResolvedValue(block(3, '새 블록'))
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await openForm()
    await fireEvent.changeText(screen.getByPlaceholderText('예: 운영 계정'), '  새 블록 ')
    await fireEvent.press(screen.getByText('추가'))
    expect(await screen.findByText('새 블록')).toBeTruthy()
    expect(accountApi.createConnection).toHaveBeenCalledWith('새 블록')
    expect(accountApi.getConnections).toHaveBeenCalledTimes(2)
    expect(screen.queryByPlaceholderText('예: 운영 계정')).toBeNull()
  })

  test('새 카드가 처음 배치되면 그 위치로 스크롤한다 (한 번만)', async () => {
    accountApi.getConnections.mockResolvedValueOnce(TWO).mockResolvedValue([...TWO, block(3, '새 블록')])
    accountApi.createConnection.mockResolvedValue(block(3, '새 블록'))
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await openForm()
    await fireEvent.changeText(screen.getByPlaceholderText('예: 운영 계정'), '새 블록')
    await fireEvent.press(screen.getByText('추가'))
    await screen.findByText('새 블록')

    const scrollTo = ScrollView.prototype.scrollTo
    scrollTo.mockClear()
    const layout = (y) => ({ nativeEvent: { layout: { x: 0, y, width: 300, height: 200 } } })
    await fireEvent(screen.getByTestId('block-row-3'), 'layout', layout(420))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ y: 420, animated: true })
    await fireEvent(screen.getByTestId('block-row-3'), 'layout', layout(430))
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  test('실패하면 서버 메시지를 보여 주고 폼과 입력을 그대로 두며 버튼이 풀린다', async () => {
    accountApi.createConnection.mockRejectedValue(new Error('이미 같은 이름의 블록이 있습니다'))
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await openForm()
    await fireEvent.changeText(screen.getByPlaceholderText('예: 운영 계정'), '운영 계정')
    await fireEvent.press(screen.getByText('추가'))
    expect(await screen.findByText('이미 같은 이름의 블록이 있습니다')).toBeTruthy()
    expect(screen.getByPlaceholderText('예: 운영 계정').props.value).toBe('운영 계정')
    expect(screen.getByRole('button', { name: '추가' })).toBeEnabled()
  })

  test('취소하면 폼이 닫히고 아무것도 보내지 않는다', async () => {
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await openForm()
    await fireEvent.press(screen.getByText('취소'))
    expect(screen.queryByPlaceholderText('예: 운영 계정')).toBeNull()
    expect(accountApi.createConnection).not.toHaveBeenCalled()
  })

  test('작업 중에 추가를 두 번 눌러도 요청은 한 번이다', async () => {
    let resolve
    accountApi.createConnection.mockReturnValue(new Promise((r) => { resolve = r }))
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await openForm()
    await fireEvent.changeText(screen.getByPlaceholderText('예: 운영 계정'), '새 블록')
    await fireEvent.press(screen.getByText('추가'))
    await fireEvent.press(screen.getByText('추가'))
    await fireEvent(screen.getByPlaceholderText('예: 운영 계정'), 'submitEditing')
    expect(accountApi.createConnection).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(block(3, '새 블록')) })
  })
})

describe('계정 연결 화면 - 블록 삭제', () => {
  test('삭제 확인은 웹과 같은 글을 쓰고 안전한 선택(그대로 두기)이 먼저다', async () => {
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await fireEvent.press(screen.getAllByText('블록 삭제')[0])
    expect(confirmAction).toHaveBeenCalledTimes(1)
    const args = confirmAction.mock.calls[0][0]
    expect(args.title).toBe(DELETE_TEXT.block.title)
    expect(args.message).toBe(DELETE_TEXT.block.body)
    expect(args.cancelText).toBe('그대로 두기')
    expect(args.confirmText).toBe('블록 삭제')
  })

  test('취소하면 아무 요청도 보내지 않는다', async () => {
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await fireEvent.press(screen.getAllByText('블록 삭제')[0])
    expect(accountApi.deleteConnection).not.toHaveBeenCalled()
    expect(accountApi.getConnections).toHaveBeenCalledTimes(1)
  })

  test('확인하면 그 블록만 지우고 목록을 다시 받는다', async () => {
    accountApi.getConnections.mockResolvedValueOnce(TWO).mockResolvedValue([TWO[1]])
    accountApi.deleteConnection.mockResolvedValue(null)
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await fireEvent.press(screen.getAllByText('블록 삭제')[0])
    await act(async () => { confirmAction.mock.calls[0][0].onConfirm() })
    await waitFor(() => expect(screen.queryByText('운영 계정')).toBeNull())
    expect(accountApi.deleteConnection).toHaveBeenCalledWith(1)
    expect(screen.getByText('개발 계정')).toBeTruthy()
  })

  test('삭제가 실패하면 서버 메시지를 보여 주고 버튼이 풀린다', async () => {
    accountApi.deleteConnection.mockRejectedValue(new Error('삭제할 수 없습니다'))
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await fireEvent.press(screen.getAllByText('블록 삭제')[0])
    await act(async () => { confirmAction.mock.calls[0][0].onConfirm() })
    expect(await screen.findByText('삭제할 수 없습니다')).toBeTruthy()
    expect(screen.getByRole('button', { name: '운영 계정 블록 삭제' })).toBeEnabled()
  })

  test('삭제가 진행되는 동안 다시 확인해도 요청은 한 번이다', async () => {
    let resolve
    accountApi.deleteConnection.mockReturnValue(new Promise((r) => { resolve = r }))
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await fireEvent.press(screen.getAllByText('블록 삭제')[0])
    const { onConfirm } = confirmAction.mock.calls[0][0]
    await act(async () => { onConfirm(); onConfirm() })
    expect(accountApi.deleteConnection).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '운영 계정 블록 삭제' })).toBeDisabled()
    await act(async () => { resolve(null) })
  })
})

const aws = (a_id, over = {}) => ({
  a_id, label: `AWS ${a_id}`, role_arn: `arn:aws:iam::22222222222${a_id}:role/DeployWizardCrossAccountRole`, aws_account_id: `22222222222${a_id}`,
  region: null, status: 'verified', last_verified_at: null, last_error: null, created_at: '', updated_at: '', ...over,
})
const tstatus = (a_id, over = {}) => ({
  a_id, current_version: 2, latest_version: 2, update_needed: false, template_file_count: 0,
  template_download_url: '/api/accounts/aws/template', stack_list_url: 'https://console.aws.amazon.com/cloudformation/home#/stacks', ...over,
})

describe('계정 연결 화면 - AWS 상자', () => {
  test('블록마다 AWS 상자가 카드 안에 들어간다', async () => {
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    expect(screen.getAllByText('AWS 계정')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '운영 계정 AWS 계정 추가' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '개발 계정 AWS 계정 추가' })).toBeEnabled()
  })

  test('확인된 AWS 계정만 템플릿 상태를 읽고, 업데이트가 필요하면 상자에 경고가 보인다', async () => {
    const withAws = [
      { c_id: 1, label: '운영 계정', aws: aws(1), github: null },
      { c_id: 2, label: '개발 계정', aws: aws(2, { status: 'pending', aws_account_id: null, role_arn: null }), github: null },
      { c_id: 3, label: '실험 계정', aws: aws(3, { status: 'invalid', last_error: '거부됨' }), github: null },
    ]
    accountApi.getConnections.mockResolvedValue(withAws)
    accountApi.listAws.mockResolvedValue(withAws.map((item) => item.aws))
    accountApi.getTemplateStatus.mockResolvedValue(tstatus(1, { update_needed: true, current_version: 0 }))
    await render(<AccountsScreen />)
    expect(await screen.findByText('스택 업데이트 필요')).toBeTruthy()
    expect(accountApi.getTemplateStatus).toHaveBeenCalledTimes(1)
    expect(accountApi.getTemplateStatus).toHaveBeenCalledWith(1)
    expect(screen.getByRole('button', { name: '운영 계정 AWS 스택 업데이트' })).toBeEnabled()
  })

  test('템플릿 상태를 못 읽어도 화면은 정상이고 오류를 띄우지 않는다', async () => {
    const withAws = [{ c_id: 1, label: '운영 계정', aws: aws(1), github: null }]
    accountApi.getConnections.mockResolvedValue(withAws)
    accountApi.listAws.mockResolvedValue([withAws[0].aws])
    accountApi.getTemplateStatus.mockRejectedValue(new Error('버전을 읽을 수 없습니다'))
    await render(<AccountsScreen />)
    await screen.findByText('계정 222222222221')
    await waitFor(() => expect(accountApi.getTemplateStatus).toHaveBeenCalled())
    expect(screen.queryByText('버전을 읽을 수 없습니다')).toBeNull()
    expect(screen.queryByText(/템플릿 최신/)).toBeNull()
    expect(screen.queryByText('스택 업데이트 필요')).toBeNull()
  })

  test('언마운트한 뒤 늦게 온 템플릿 상태는 버린다 (경고 없이)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const withAws = [{ c_id: 1, label: '운영 계정', aws: aws(1), github: null }]
    accountApi.getConnections.mockResolvedValue(withAws)
    accountApi.listAws.mockResolvedValue([withAws[0].aws])
    let resolve
    accountApi.getTemplateStatus.mockReturnValue(new Promise((r) => { resolve = r }))
    const { unmount } = await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await unmount()
    await act(async () => { resolve(tstatus(1)) })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  test('연결을 시작하는 동안 모든 블록의 버튼이 잠기고, 끝나면 안내가 열린다', async () => {
    let resolve
    accountApi.createConnectionAws.mockReturnValue(new Promise((r) => { resolve = r }))
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 AWS 계정 추가' }))
    expect(screen.getByRole('button', { name: '개발 계정 AWS 계정 추가' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '개발 계정 블록 삭제' })).toBeDisabled()
    await act(async () => { resolve({ a_id: 9, label: '운영 계정', external_id: 'EXT-1', our_account_id: '111122223333', template_download_url: '/api/accounts/aws/template', stack_create_url: 'https://console.aws.amazon.com/cloudformation/home#/stacks/create' }) })
    expect(await screen.findByText('역할 만들고 붙여넣기 — 운영 계정')).toBeTruthy()
    expect(accountApi.createConnectionAws).toHaveBeenCalledWith(1)
  })

  test('서버가 409 로 거절하면 화면 위에 서버 메시지를 보이고 버튼이 풀린다', async () => {
    accountApi.createConnectionAws.mockRejectedValue(new Error('이 블록에는 이미 AWS 계정이 연결되어 있습니다'))
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 AWS 계정 추가' }))
    expect(await screen.findByText('이 블록에는 이미 AWS 계정이 연결되어 있습니다')).toBeTruthy()
    expect(screen.getByRole('button', { name: '운영 계정 AWS 계정 추가' })).toBeEnabled()
  })

  test('다른 블록이 쓰는 계정은 고르기 목록에 나오고, 고르면 이 블록에 이은 뒤 목록을 다시 받는다', async () => {
    const shared = aws(5, { label: '공용 AWS' })
    accountApi.listAws.mockResolvedValue([shared])
    accountApi.setConnectionAws.mockResolvedValue({})
    await render(<AccountsScreen />)
    await screen.findByText('운영 계정')
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 AWS 이미 연결한 계정에서 고르기' }))
    await fireEvent.press(screen.getByText('공용 AWS'))
    await waitFor(() => expect(accountApi.setConnectionAws).toHaveBeenCalledWith(1, 5))
    await waitFor(() => expect(accountApi.getConnections).toHaveBeenCalledTimes(2))
  })
})

describe('계정 연결 화면 - 메시지가 화면 밖에 있을 때', () => {
  const THREE = [
    { c_id: 1, label: '운영 계정', aws: null, github: null },
    { c_id: 2, label: '개발 계정', aws: null, github: null },
    { c_id: 3, label: '실험 계정', aws: aws(3), github: null },
  ]
  const SETUP9 = { a_id: 9, label: '운영 계정', external_id: 'EXT-1', our_account_id: '111122223333', template_download_url: '/api/accounts/aws/template', stack_create_url: 'https://console.aws.amazon.com/cloudformation/home#/stacks/create' }

  beforeEach(() => {
    accountApi.getConnections.mockResolvedValue(THREE)
    accountApi.listAws.mockResolvedValue([THREE[2].aws])
    accountApi.getTemplateStatus.mockResolvedValue(tstatus(3))
  })

  test('아래쪽 블록에서 실패하면 오류를 보이고 맨 위로 스크롤한다', async () => {
    accountApi.createConnectionAws.mockRejectedValue(new Error('이 블록에는 이미 AWS 계정이 연결되어 있습니다'))
    await render(<AccountsScreen />)
    await screen.findByText('실험 계정')
    ScrollView.prototype.scrollTo.mockClear()
    await fireEvent.press(screen.getByRole('button', { name: '개발 계정 AWS 계정 추가' }))
    expect(await screen.findByText('이 블록에는 이미 AWS 계정이 연결되어 있습니다')).toBeTruthy()
    expect(ScrollView.prototype.scrollTo).toHaveBeenCalledWith({ y: 0, animated: true })
  })

  test('마지막 블록의 연결 확인 알림도 맨 위로 스크롤해 보인다', async () => {
    accountApi.reverifyAws.mockResolvedValue(THREE[2].aws)
    await render(<AccountsScreen />)
    await screen.findByText('실험 계정')
    ScrollView.prototype.scrollTo.mockClear()
    await fireEvent.press(screen.getByRole('button', { name: '실험 계정 AWS 연결 확인' }))
    expect(await screen.findByText(/AWS 계정 연결 확인됨/)).toBeTruthy()
    expect(ScrollView.prototype.scrollTo).toHaveBeenCalledWith({ y: 0, animated: true })
  })

  test('메시지가 없으면 스크롤하지 않는다', async () => {
    ScrollView.prototype.scrollTo.mockClear()
    await render(<AccountsScreen />)
    await screen.findByText('실험 계정')
    expect(ScrollView.prototype.scrollTo).not.toHaveBeenCalled()
  })

  test('안내(Modal) 안의 오류는 화면을 스크롤하지 않는다', async () => {
    accountApi.createConnectionAws.mockResolvedValue(SETUP9)
    accountApi.attachRole.mockRejectedValue(new Error('역할을 빌릴 수 없습니다'))
    await render(<AccountsScreen />)
    await screen.findByText('실험 계정')
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 AWS 계정 추가' }))
    await screen.findByText('역할 만들고 붙여넣기 — 운영 계정')
    ScrollView.prototype.scrollTo.mockClear()
    await fireEvent.changeText(screen.getByPlaceholderText('arn:aws:iam::...:role/DeployWizardCrossAccountRole'), 'arn:aws:iam::222222222222:role/X')
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 역할 ARN 확인' }))
    expect(await screen.findByText('역할을 빌릴 수 없습니다')).toBeTruthy()
    expect(ScrollView.prototype.scrollTo).not.toHaveBeenCalled()
  })

  test('StrictMode 에서도 계정 추가가 끝까지 되어 안내가 열린다', async () => {
    accountApi.createConnectionAws.mockResolvedValue(SETUP9)
    await render(<StrictMode><AccountsScreen /></StrictMode>)
    await screen.findByText('실험 계정')
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 AWS 계정 추가' }))
    expect(await screen.findByText('역할 만들고 붙여넣기 — 운영 계정')).toBeTruthy()
    expect(accountApi.createConnectionAws).toHaveBeenCalledWith(1)
  })
})

describe('계정 연결 화면 - 키보드와 안전 영역', () => {
  afterEach(() => { jest.restoreAllMocks() })

  test('안드로이드에서는 스크롤을 KeyboardAvoidingView(height) 가 감싼다 (기기에서는 확인하지 못했다)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    await render(<AccountsScreen />)
    const wrapper = screen.getByTestId('keyboard-avoiding')
    expect(mockKavProps[mockKavProps.length - 1].behavior).toBe('height')
    expect(StyleSheet.flatten(wrapper.props.style).flex).toBe(1)
    const scroll = screen.getByTestId('accounts-scroll')
    expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(true)
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled')
    expect(scroll.props.keyboardDismissMode).toBe('on-drag')
  })

  test('스크롤 아래 여백에 하단 안전 영역을 더한다', async () => {
    await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 34 } }}>
        <AccountsScreen />
      </SafeAreaProvider>,
    )
    expect(StyleSheet.flatten(screen.getByTestId('accounts-scroll').props.contentContainerStyle).paddingBottom).toBe(24 * 2 + 34)
  })
})
