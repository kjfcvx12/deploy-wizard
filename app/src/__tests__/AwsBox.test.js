import { useRef, useState } from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native'
import { accountApi } from '../api'
import { confirmAction } from '../confirm'
import { DELETE_TEXT } from '../accounts/constants'
import { awsVerifiedNotice, cleanupNotice, STACK_UPDATED_NOTICE } from '../accounts/notices'
import { Notice } from '../components/ui'
import AwsBox from '../components/accounts/AwsBox'

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }))
jest.mock('../api', () => ({
  BASE_URL: 'http://localhost:8081',
  accountApi: {
    createConnectionAws: jest.fn(), createAws: jest.fn(), attachRole: jest.fn(), reverifyAws: jest.fn(),
    getTemplateStatus: jest.fn(), deleteTemplateFiles: jest.fn(), deleteAws: jest.fn(), setConnectionAws: jest.fn(),
  },
}))
jest.mock('../confirm', () => ({ confirmAction: jest.fn() }))

const SECRET = 'EXT-9f3a7c1d-SECRET-VALUE'
const ARN = 'arn:aws:iam::222222222222:role/DeployWizardCrossAccountRole'
const SETUP = {
  a_id: 7, label: '운영 계정', external_id: SECRET, our_account_id: '111122223333',
  template_download_url: '/api/accounts/aws/template',
  stack_create_url: 'https://ap-northeast-2.console.aws.amazon.com/cloudformation/home?region=ap-northeast-2#/stacks/create',
}
const aws = (over = {}) => ({
  a_id: 1, label: '운영 AWS', role_arn: ARN, aws_account_id: '222222222222', region: null, status: 'verified',
  last_verified_at: '2026-11-09T00:00:00', last_error: null, created_at: '2026-11-01T00:00:00', updated_at: '2026-11-09T00:00:00', ...over,
})
const blockOf = (account, c_id = 1, label = '운영 계정') => ({ c_id, label, aws: account, github: null })
const status = (over = {}) => ({
  a_id: 1, current_version: 2, latest_version: 2, update_needed: false, template_file_count: 0,
  template_download_url: '/api/accounts/aws/template', stack_list_url: 'https://ap-northeast-2.console.aws.amazon.com/cloudformation/home?region=ap-northeast-2#/stacks', ...over,
})

// 화면(AccountsScreen)의 run/busy 와 같은 규칙으로 AwsBox 를 감싼다
function Harness({ block, connections, awsAccounts = [], templateStatus = {}, reload, setNotice }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const run = async (work) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try { await work() } catch (e) { setError(e.message) } finally { busyRef.current = false; setBusy(false) }
  }
  return (
    <>
      {!!error && <Notice>{error}</Notice>}
      <AwsBox block={block} connections={connections || [block]} awsAccounts={awsAccounts} templateStatus={templateStatus}
        busy={busy} run={run} reload={reload} setNotice={setNotice} />
    </>
  )
}

let reload
let setNotice
beforeEach(() => {
  reload = jest.fn().mockResolvedValue(true)
  setNotice = jest.fn()
  for (const fn of Object.values(accountApi)) fn.mockReset()
  confirmAction.mockReset()
  jest.spyOn(console, 'error')
  jest.spyOn(console, 'warn')
})
afterEach(() => {
  const noisy = [...console.error.mock.calls, ...console.warn.mock.calls]
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

const show = (block, extra = {}) => render(<Harness block={block} reload={reload} setNotice={setNotice} {...extra} />)
const btn = (name) => screen.getByRole('button', { name })
const treeText = () => JSON.stringify(screen.toJSON())

describe('AWS 상자 - 연결 전', () => {
  test('연결 안 됨 배지와 안내, 채운 계정 추가만 보인다', async () => {
    await show(blockOf(null))
    expect(screen.getByText('AWS 계정')).toBeTruthy()
    expect(screen.getByText('연결 안 됨')).toBeTruthy()
    expect(screen.getByText('이 블록은 아직 AWS 연결 전입니다. 연결하지 않으면 개발용 계정으로 배포됩니다.')).toBeTruthy()
    expect(btn('운영 계정 AWS 계정 추가')).toBeEnabled()
    expect(screen.queryByText('연결 확인')).toBeNull()
    expect(screen.queryByText('연결 해제')).toBeNull()
  })

  test('계정 추가는 블록 경로로 연결을 시작하고 안내를 연 뒤 목록을 다시 받는다', async () => {
    accountApi.createConnectionAws.mockResolvedValue(SETUP)
    await show(blockOf(null))
    await fireEvent.press(btn('운영 계정 AWS 계정 추가'))
    expect(accountApi.createConnectionAws).toHaveBeenCalledWith(1)
    expect(accountApi.createAws).not.toHaveBeenCalled()
    expect(await screen.findByText('역할 만들고 붙여넣기 — 운영 계정')).toBeTruthy()
    expect(screen.getByText(SECRET)).toBeTruthy()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('이미 연결되어 있다는 409 는 서버 메시지로 보이고 안내는 열리지 않으며 버튼이 풀린다', async () => {
    accountApi.createConnectionAws.mockRejectedValue(new Error('이 블록에는 이미 AWS 계정이 연결되어 있습니다'))
    await show(blockOf(null))
    await fireEvent.press(btn('운영 계정 AWS 계정 추가'))
    expect(await screen.findByText('이 블록에는 이미 AWS 계정이 연결되어 있습니다')).toBeTruthy()
    expect(screen.queryByText(/역할 만들고 붙여넣기/)).toBeNull()
    expect(btn('운영 계정 AWS 계정 추가')).toBeEnabled()
  })

  test('계정 추가를 두 번 눌러도 요청은 한 번이다', async () => {
    let resolve
    accountApi.createConnectionAws.mockReturnValue(new Promise((r) => { resolve = r }))
    await show(blockOf(null))
    await fireEvent.press(btn('운영 계정 AWS 계정 추가'))
    await fireEvent.press(btn('운영 계정 AWS 계정 추가'))
    expect(accountApi.createConnectionAws).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(SETUP) })
  })

  test('연결해 둔 다른 계정이 있으면 이미 연결한 계정에서 고르기가 보인다', async () => {
    await show(blockOf(null), { awsAccounts: [aws({ a_id: 5, label: '개발 AWS' })] })
    expect(btn('운영 계정 AWS 이미 연결한 계정에서 고르기')).toBeEnabled()
  })

  test('연결해 둔 계정이 없으면 고르기 버튼이 없다', async () => {
    await show(blockOf(null))
    expect(screen.queryByText('이미 연결한 계정에서 고르기')).toBeNull()
  })
})

describe('AWS 상자 - 새 계정 추가 (이미 연결된 블록)', () => {
  const open = async () => {
    await show(blockOf(aws()), { templateStatus: { 1: status() } })
    await fireEvent.press(btn('운영 계정 AWS 계정 추가'))
  }

  test('이름부터 묻고, 비었거나 공백이면 다음이 잠긴다', async () => {
    await open()
    expect(accountApi.createAws).not.toHaveBeenCalled()
    expect(screen.getByText('AWS 계정 추가')).toBeTruthy()
    expect(btn('운영 계정 AWS 계정 추가 다음')).toBeDisabled()
    await fireEvent.changeText(screen.getByPlaceholderText('예: 운영 계정'), '   ')
    expect(btn('운영 계정 AWS 계정 추가 다음')).toBeDisabled()
  })

  test('다음을 누르면 공백을 지운 이름으로 createAws 를 부르고 안내를 연다', async () => {
    accountApi.createAws.mockResolvedValue({ ...SETUP, a_id: 9, label: '새 계정' })
    await open()
    await fireEvent.changeText(screen.getByPlaceholderText('예: 운영 계정'), '  새 계정 ')
    await fireEvent.press(btn('운영 계정 AWS 계정 추가 다음'))
    expect(accountApi.createAws).toHaveBeenCalledWith('새 계정')
    expect(accountApi.createConnectionAws).not.toHaveBeenCalled()
    expect(await screen.findByText('역할 만들고 붙여넣기 — 새 계정')).toBeTruthy()
    expect(screen.queryByPlaceholderText('예: 운영 계정')).toBeNull()
  })

  test('취소하면 아무것도 보내지 않는다', async () => {
    await open()
    await fireEvent.press(btn('운영 계정 AWS 계정 추가 취소'))
    expect(screen.queryByPlaceholderText('예: 운영 계정')).toBeNull()
    expect(accountApi.createAws).not.toHaveBeenCalled()
  })

  test('실패하면 서버 메시지를 보이고 버튼이 풀린다', async () => {
    accountApi.createAws.mockRejectedValue(new Error('같은 이름의 계정이 있습니다'))
    await open()
    await fireEvent.changeText(screen.getByPlaceholderText('예: 운영 계정'), '새 계정')
    await fireEvent.press(btn('운영 계정 AWS 계정 추가 다음'))
    expect(await screen.findByText('같은 이름의 계정이 있습니다')).toBeTruthy()
    expect(btn('운영 계정 AWS 계정 추가')).toBeEnabled()
  })
})

describe('AWS 상자 - 안내와 RoleArn 등록', () => {
  const start = async () => {
    accountApi.createConnectionAws.mockResolvedValue(SETUP)
    await show(blockOf(null))
    await fireEvent.press(btn('운영 계정 AWS 계정 추가'))
    await screen.findByText('역할 만들고 붙여넣기 — 운영 계정')
  }
  const input = () => screen.getByPlaceholderText('arn:aws:iam::...:role/DeployWizardCrossAccountRole')

  test('RoleArn 은 공백을 지워 한 번 보내고, 안내를 닫고, 목록을 다시 받고, 확인 알림을 낸다', async () => {
    await start()
    const done = aws({ a_id: 7, label: '운영 계정' })
    let resolve
    accountApi.attachRole.mockReturnValue(new Promise((r) => { resolve = r }))
    accountApi.getTemplateStatus.mockResolvedValue(status({ a_id: 7, current_version: 2 }))
    await fireEvent.changeText(input(), `  ${ARN} `)
    await fireEvent.press(btn('운영 계정 역할 ARN 확인'))
    await fireEvent.press(btn('운영 계정 역할 ARN 확인'))
    await fireEvent(input(), 'submitEditing')
    expect(accountApi.attachRole).toHaveBeenCalledTimes(1)
    expect(accountApi.attachRole).toHaveBeenCalledWith(7, ARN)
    await act(async () => { resolve(done) })
    await waitFor(() => expect(screen.queryByText(/역할 만들고 붙여넣기/)).toBeNull())
    expect(reload).toHaveBeenCalledTimes(2)
    expect(accountApi.getTemplateStatus).toHaveBeenCalledWith(7)
    expect(setNotice).toHaveBeenLastCalledWith(awsVerifiedNotice(done, status({ a_id: 7 })))
  })

  test('안내를 닫으면 ExternalId 가 화면 트리에서 사라지고 어떤 요청에도 실리지 않는다', async () => {
    await start()
    expect(treeText()).toContain(SECRET)
    accountApi.attachRole.mockResolvedValue(aws({ a_id: 7 }))
    accountApi.getTemplateStatus.mockResolvedValue(status({ a_id: 7 }))
    await fireEvent.changeText(input(), ARN)
    await fireEvent.press(btn('운영 계정 역할 ARN 확인'))
    await waitFor(() => expect(screen.queryByText(/역할 만들고 붙여넣기/)).toBeNull())
    expect(treeText()).not.toContain(SECRET)
    expect(JSON.stringify([...Object.values(accountApi).map((fn) => fn.mock.calls), setNotice.mock.calls, reload.mock.calls])).not.toContain(SECRET)
  })

  test('나중에를 눌러도 ExternalId 가 트리에서 사라진다', async () => {
    await start()
    await fireEvent.press(btn('운영 계정 안내 나중에'))
    expect(screen.queryByText(/역할 만들고 붙여넣기/)).toBeNull()
    expect(treeText()).not.toContain(SECRET)
    expect(accountApi.attachRole).not.toHaveBeenCalled()
  })

  test('등록이 거절되면 안내 안에 서버 메시지를 보이고, 안내와 입력은 그대로이며 버튼이 풀린다', async () => {
    await start()
    accountApi.attachRole.mockRejectedValue(new Error('역할을 빌릴 수 없습니다. ExternalId 를 확인하세요'))
    await fireEvent.changeText(input(), ARN)
    await fireEvent.press(btn('운영 계정 역할 ARN 확인'))
    expect(await screen.findByText('역할을 빌릴 수 없습니다. ExternalId 를 확인하세요')).toBeTruthy()
    expect(input().props.value).toBe(ARN)
    expect(btn('운영 계정 역할 ARN 확인')).toBeEnabled()
    expect(screen.getByText(SECRET)).toBeTruthy()
  })

  test('다시 누르면 지난 오류는 지워진다', async () => {
    await start()
    accountApi.attachRole.mockRejectedValueOnce(new Error('첫 오류')).mockResolvedValue(aws({ a_id: 7 }))
    accountApi.getTemplateStatus.mockResolvedValue(status({ a_id: 7 }))
    await fireEvent.changeText(input(), ARN)
    await fireEvent.press(btn('운영 계정 역할 ARN 확인'))
    await screen.findByText('첫 오류')
    await fireEvent.press(btn('운영 계정 역할 ARN 확인'))
    await waitFor(() => expect(screen.queryByText('첫 오류')).toBeNull())
  })

  test('새 계정(블록에 안 이어진 것)을 등록하면 이을 방법을 알림에 덧붙인다', async () => {
    accountApi.createAws.mockResolvedValue({ ...SETUP, a_id: 9, label: '새 계정' })
    await show(blockOf(aws()))
    await fireEvent.press(btn('운영 계정 AWS 계정 추가'))
    await fireEvent.changeText(screen.getByPlaceholderText('예: 운영 계정'), '새 계정')
    await fireEvent.press(btn('운영 계정 AWS 계정 추가 다음'))
    await screen.findByText('역할 만들고 붙여넣기 — 새 계정')
    const done = aws({ a_id: 9, label: '새 계정' })
    accountApi.attachRole.mockResolvedValue(done)
    accountApi.getTemplateStatus.mockResolvedValue(status({ a_id: 9 }))
    await fireEvent.changeText(input(), ARN)
    await fireEvent.press(btn('새 계정 역할 ARN 확인'))
    await waitFor(() => expect(setNotice).toHaveBeenCalled())
    expect(setNotice).toHaveBeenLastCalledWith(`${awsVerifiedNotice(done, status({ a_id: 9 }))} — 이 블록에 쓰려면 [이미 연결한 계정에서 고르기]로 고르세요`)
  })

  test('등록 뒤 템플릿 상태를 못 읽으면 화면 오류로 알린다', async () => {
    await start()
    accountApi.attachRole.mockResolvedValue(aws({ a_id: 7 }))
    accountApi.getTemplateStatus.mockRejectedValue(new Error('템플릿 버전을 읽을 수 없습니다'))
    await fireEvent.changeText(input(), ARN)
    await fireEvent.press(btn('운영 계정 역할 ARN 확인'))
    expect(await screen.findByText('템플릿 버전을 읽을 수 없습니다')).toBeTruthy()
    expect(treeText()).not.toContain(SECRET)
  })
})

describe('AWS 상자 - 대기 중인 계정 이어서 하기', () => {
  test('역할 등록 대기 배지와 역할 ARN 입력 버튼, ExternalId 없이 RoleArn 만 받는다', async () => {
    await show(blockOf(aws({ status: 'pending', role_arn: null, aws_account_id: null })))
    expect(screen.getByText('역할 등록 대기')).toBeTruthy()
    expect(screen.getByText('역할 미등록 — 스택을 만들고 RoleArn을 넣으면 연결됩니다')).toBeTruthy()
    expect(screen.queryByText('연결 확인')).toBeNull()
    await fireEvent.press(btn('운영 계정 AWS 역할 ARN 입력'))
    expect(screen.getByText(/ExternalId는 처음 한 번만 보여주기 때문에 다시 볼 수 없습니다/)).toBeTruthy()
    accountApi.attachRole.mockResolvedValue(aws({ a_id: 1 }))
    accountApi.getTemplateStatus.mockResolvedValue(status())
    await fireEvent.changeText(screen.getByPlaceholderText('arn:aws:iam::...:role/DeployWizardCrossAccountRole'), ARN)
    await fireEvent.press(btn('운영 AWS 역할 ARN 확인'))
    await waitFor(() => expect(accountApi.attachRole).toHaveBeenCalledWith(1, ARN))
  })
})

describe('AWS 상자 - 연결된 계정', () => {
  test('상태, 이름, 계정 ID, 역할 ARN 전체와 템플릿 상태가 보인다', async () => {
    const long = `arn:aws:iam::222222222222:role/${'LongRoleName'.repeat(5)}`
    await show(blockOf(aws({ role_arn: long })), { templateStatus: { 1: status({ current_version: 2 }) } })
    expect(screen.getByText('연결됨')).toBeTruthy()
    expect(screen.getByText('운영 AWS')).toBeTruthy()
    expect(screen.getByText('계정 222222222222')).toBeTruthy()
    expect(screen.getByText(long)).toBeTruthy()
    expect(screen.getByText('템플릿 최신 (버전 2) · S3에 남은 템플릿 파일 없음')).toBeTruthy()
    expect(btn('운영 계정 AWS 연결 확인')).toBeEnabled()
    expect(screen.queryByText('다시 확인')).toBeNull()
  })

  test('남은 템플릿 파일 수를 보인다', async () => {
    await show(blockOf(aws()), { templateStatus: { 1: status({ template_file_count: 3 }) } })
    expect(screen.getByText('템플릿 최신 (버전 2) · S3에 올린 템플릿 파일 3개 남음')).toBeTruthy()
  })

  test('연결 확인은 다시 검증하고 목록을 받고 확인 알림을 낸다', async () => {
    const account = aws()
    accountApi.reverifyAws.mockResolvedValue(account)
    accountApi.getTemplateStatus.mockResolvedValue(status({ current_version: 2 }))
    await show(blockOf(account))
    await fireEvent.press(btn('운영 계정 AWS 연결 확인'))
    await waitFor(() => expect(setNotice).toHaveBeenLastCalledWith(awsVerifiedNotice(account, status())))
    expect(accountApi.reverifyAws).toHaveBeenCalledWith(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('확인이 실패하면 서버 메시지를 보이고 그래도 목록을 다시 받는다', async () => {
    accountApi.reverifyAws.mockRejectedValue(new Error('역할을 빌릴 수 없습니다'))
    await show(blockOf(aws()))
    await fireEvent.press(btn('운영 계정 AWS 연결 확인'))
    expect(await screen.findByText('역할을 빌릴 수 없습니다')).toBeTruthy()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(setNotice).not.toHaveBeenCalledWith(expect.stringContaining('연결 확인됨'))
    expect(btn('운영 계정 AWS 연결 확인')).toBeEnabled()
  })

  test('확인이 두 번 눌려도 요청은 한 번이다', async () => {
    let resolve
    accountApi.reverifyAws.mockReturnValue(new Promise((r) => { resolve = r }))
    await show(blockOf(aws()))
    await fireEvent.press(btn('운영 계정 AWS 연결 확인'))
    await fireEvent.press(btn('운영 계정 AWS 연결 확인'))
    expect(accountApi.reverifyAws).toHaveBeenCalledTimes(1)
    expect(btn('운영 계정 AWS 연결 확인')).toBeDisabled()
    await act(async () => { resolve(aws({ status: 'invalid' })) })
  })

  test('확인 실패 상태는 배지, 마지막 오류(길어도 줄바꿈), 다시 확인 버튼을 보인다', async () => {
    const last = `AssumeRole 거부: ${'AccessDenied '.repeat(12)}`.trim()
    await show(blockOf(aws({ status: 'invalid', last_error: last })))
    expect(screen.getByText('확인 실패')).toBeTruthy()
    expect(screen.getByText(last)).toBeTruthy()
    expect(btn('운영 계정 AWS 다시 확인')).toBeEnabled()
    expect(screen.queryByText('연결 확인')).toBeNull()
  })

  test('verified 에서는 지난 오류를 보이지 않는다', async () => {
    await show(blockOf(aws({ last_error: '지난 오류' })))
    expect(screen.queryByText('지난 오류')).toBeNull()
  })

  test('작업 중이면 모든 버튼이 잠긴다', async () => {
    let resolve
    accountApi.reverifyAws.mockReturnValue(new Promise((r) => { resolve = r }))
    await show(blockOf(aws()), { awsAccounts: [aws({ a_id: 5, label: '개발 AWS' })], templateStatus: { 1: status({ template_file_count: 2, update_needed: true }) } })
    await fireEvent.press(btn('운영 계정 AWS 연결 확인'))
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled()
    await act(async () => { resolve(aws({ status: 'invalid' })) })
  })
})

describe('AWS 상자 - 연결 해제', () => {
  test('다른 블록도 쓰는 계정이면 확인 없이 이 블록에서만 뗀다', async () => {
    const mine = blockOf(aws())
    const other = blockOf(aws(), 2, '개발 계정')
    accountApi.setConnectionAws.mockResolvedValue({})
    await show(mine, { connections: [mine, other] })
    await fireEvent.press(btn('운영 계정 AWS 연결 해제'))
    expect(confirmAction).not.toHaveBeenCalled()
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(accountApi.setConnectionAws).toHaveBeenCalledWith(1, null)
    expect(accountApi.deleteAws).not.toHaveBeenCalled()
  })

  test('이 블록만 쓰는 계정이면 웹과 같은 글로 확인하고, 안전한 선택이 먼저다', async () => {
    await show(blockOf(aws()))
    await fireEvent.press(btn('운영 계정 AWS 연결 해제'))
    expect(confirmAction).toHaveBeenCalledTimes(1)
    const args = confirmAction.mock.calls[0][0]
    expect(args.title).toBe(DELETE_TEXT.aws.title)
    expect(args.message).toBe(DELETE_TEXT.aws.body)
    expect(args.cancelText).toBe('그대로 두기')
    expect(args.confirmText).toBe('연결 해제')
    expect(accountApi.deleteAws).not.toHaveBeenCalled()
    expect(accountApi.setConnectionAws).not.toHaveBeenCalled()
  })

  test('취소하면 아무것도 보내지 않는다', async () => {
    await show(blockOf(aws()))
    await fireEvent.press(btn('운영 계정 AWS 연결 해제'))
    expect(accountApi.deleteAws).not.toHaveBeenCalled()
    expect(accountApi.setConnectionAws).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  test('확인하면 계정 연결을 지우고 목록을 다시 받는다', async () => {
    accountApi.deleteAws.mockResolvedValue({})
    await show(blockOf(aws()))
    await fireEvent.press(btn('운영 계정 AWS 연결 해제'))
    await act(async () => { confirmAction.mock.calls[0][0].onConfirm() })
    expect(accountApi.deleteAws).toHaveBeenCalledWith(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('지우기가 실패하면 서버 메시지를 보이고 버튼이 풀린다', async () => {
    accountApi.deleteAws.mockRejectedValue(new Error('지울 수 없습니다'))
    await show(blockOf(aws()))
    await fireEvent.press(btn('운영 계정 AWS 연결 해제'))
    await act(async () => { confirmAction.mock.calls[0][0].onConfirm() })
    expect(await screen.findByText('지울 수 없습니다')).toBeTruthy()
    expect(btn('운영 계정 AWS 연결 해제')).toBeEnabled()
  })

  test('확인이 두 번 들어와도 요청은 한 번이다', async () => {
    let resolve
    accountApi.deleteAws.mockReturnValue(new Promise((r) => { resolve = r }))
    await show(blockOf(aws()))
    await fireEvent.press(btn('운영 계정 AWS 연결 해제'))
    const { onConfirm } = confirmAction.mock.calls[0][0]
    await act(async () => { onConfirm(); onConfirm() })
    expect(accountApi.deleteAws).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({}) })
  })
})

describe('AWS 상자 - 스택 업데이트', () => {
  const needed = status({ current_version: 0, latest_version: 2, update_needed: true })
  const open = async () => {
    await show(blockOf(aws()), { templateStatus: { 1: needed } })
    await fireEvent.press(btn('운영 계정 AWS 스택 업데이트'))
  }

  test('업데이트가 필요하면 경고와 스택 업데이트 버튼을 보이고, 최신 표시는 숨긴다', async () => {
    await show(blockOf(aws()), { templateStatus: { 1: needed } })
    expect(screen.getByText('스택 업데이트 필요')).toBeTruthy()
    expect(screen.getByText(/새 기능에 필요한 권한이 템플릿에 추가됐습니다/)).toBeTruthy()
    expect(screen.queryByText(/템플릿 최신/)).toBeNull()
    expect(btn('운영 계정 AWS 스택 업데이트')).toBeEnabled()
  })

  test('버튼을 누르면 업데이트 안내가 열린다', async () => {
    await open()
    expect(screen.getByText('스택 업데이트가 필요합니다 — 운영 AWS')).toBeTruthy()
  })

  test('업데이트 확인: 아직 예전 버전이면 안내가 열린 채 웹과 같은 글을 보인다', async () => {
    accountApi.getTemplateStatus.mockResolvedValue(needed)
    await open()
    await fireEvent.press(btn('운영 AWS 업데이트 확인'))
    expect(accountApi.getTemplateStatus).toHaveBeenCalledWith(1)
    expect(await screen.findByText('아직 예전 버전(0)입니다. 스택 상태가 UPDATE_COMPLETE 인지 확인한 뒤 다시 눌러 주세요.')).toBeTruthy()
    expect(screen.getByText('스택 업데이트가 필요합니다 — 운영 AWS')).toBeTruthy()
    expect(setNotice).not.toHaveBeenCalledWith(STACK_UPDATED_NOTICE)
    expect(btn('운영 AWS 업데이트 확인')).toBeEnabled()
  })

  test('업데이트 확인: 최신이 되었으면 안내를 닫고 알림을 내고 목록을 다시 받는다', async () => {
    accountApi.getTemplateStatus.mockResolvedValue(status({ current_version: 2, update_needed: false }))
    await open()
    await fireEvent.press(btn('운영 AWS 업데이트 확인'))
    await waitFor(() => expect(screen.queryByText(/스택 업데이트가 필요합니다/)).toBeNull())
    expect(setNotice).toHaveBeenLastCalledWith(STACK_UPDATED_NOTICE)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('업데이트 확인이 실패하면 안내 안에 서버 메시지를 보인다', async () => {
    accountApi.getTemplateStatus.mockRejectedValue(new Error('스택을 찾을 수 없습니다'))
    await open()
    await fireEvent.press(btn('운영 AWS 업데이트 확인'))
    expect(await screen.findByText('스택을 찾을 수 없습니다')).toBeTruthy()
    expect(screen.getByText('스택 업데이트가 필요합니다 — 운영 AWS')).toBeTruthy()
  })

  test('나중에는 안내를 닫고 아무것도 보내지 않는다', async () => {
    await open()
    await fireEvent.press(btn('운영 AWS 업데이트 안내 나중에'))
    expect(screen.queryByText(/스택 업데이트가 필요합니다/)).toBeNull()
    expect(accountApi.getTemplateStatus).not.toHaveBeenCalled()
  })
})

describe('AWS 상자 - 템플릿 파일 삭제', () => {
  const withFiles = status({ template_file_count: 3 })

  test('남은 파일이 없으면 버튼이 없다', async () => {
    await show(blockOf(aws()), { templateStatus: { 1: status() } })
    expect(screen.queryByText('템플릿 파일 삭제')).toBeNull()
  })

  test('웹과 같은 글로 확인하고 안전한 선택(그대로 두기)이 먼저다', async () => {
    await show(blockOf(aws()), { templateStatus: { 1: withFiles } })
    await fireEvent.press(btn('운영 계정 AWS 템플릿 파일 삭제'))
    expect(confirmAction).toHaveBeenCalledTimes(1)
    const args = confirmAction.mock.calls[0][0]
    expect(args.title).toBe('올렸던 템플릿 파일을 지울까요?')
    expect(args.message).toContain('스택을 만들 때 콘솔에 올린 deploy_wizard_role.yaml이 내 AWS 계정의 S3에 남아 있습니다. 그 파일만 지웁니다. 버킷과 다른 파일은 건드리지 않습니다.')
    expect(args.message).toContain('지워도 다시 등록할 필요는 없습니다.')
    expect(args.cancelText).toBe('그대로 두기')
    expect(args.confirmText).toBe('삭제')
  })

  test('취소하면 요청이 0 건이다', async () => {
    await show(blockOf(aws()), { templateStatus: { 1: withFiles } })
    await fireEvent.press(btn('운영 계정 AWS 템플릿 파일 삭제'))
    expect(accountApi.deleteTemplateFiles).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  test('확인하면 지운 수를 알리고 목록을 다시 받는다', async () => {
    accountApi.deleteTemplateFiles.mockResolvedValue({ deleted: 3 })
    await show(blockOf(aws()), { templateStatus: { 1: withFiles } })
    await fireEvent.press(btn('운영 계정 AWS 템플릿 파일 삭제'))
    await act(async () => { confirmAction.mock.calls[0][0].onConfirm() })
    expect(accountApi.deleteTemplateFiles).toHaveBeenCalledWith(1)
    expect(setNotice).toHaveBeenLastCalledWith(cleanupNotice(3))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('0 개를 지웠다는 응답도 알린다', async () => {
    accountApi.deleteTemplateFiles.mockResolvedValue({ deleted: 0 })
    await show(blockOf(aws()), { templateStatus: { 1: withFiles } })
    await fireEvent.press(btn('운영 계정 AWS 템플릿 파일 삭제'))
    await act(async () => { confirmAction.mock.calls[0][0].onConfirm() })
    expect(setNotice).toHaveBeenLastCalledWith('지울 템플릿 파일이 없습니다. 이미 깨끗합니다.')
  })

  test('실패하면 서버 메시지를 보이고 버튼이 풀린다', async () => {
    accountApi.deleteTemplateFiles.mockRejectedValue(new Error('권한이 없습니다'))
    await show(blockOf(aws()), { templateStatus: { 1: withFiles } })
    await fireEvent.press(btn('운영 계정 AWS 템플릿 파일 삭제'))
    await act(async () => { confirmAction.mock.calls[0][0].onConfirm() })
    expect(await screen.findByText('권한이 없습니다')).toBeTruthy()
    expect(btn('운영 계정 AWS 템플릿 파일 삭제')).toBeEnabled()
  })
})

describe('AWS 상자 - 이미 연결한 계정에서 고르기', () => {
  const others = [aws({ a_id: 1 }), aws({ a_id: 5, label: '개발 AWS', status: 'pending', aws_account_id: null, role_arn: null }), aws({ a_id: 6, label: '실험 AWS', aws_account_id: '333333333333' })]

  test('이 블록이 쓰는 계정은 빼고 보여 주며, 누르면 그 계정을 잇는다', async () => {
    accountApi.setConnectionAws.mockResolvedValue({})
    await show(blockOf(aws()), { awsAccounts: others })
    await fireEvent.press(btn('운영 계정 AWS 이미 연결한 계정에서 고르기'))
    expect(screen.getByText('운영 계정에 이을 AWS 계정')).toBeTruthy()
    expect(screen.getByText('역할 등록 대기 · 역할 미등록')).toBeTruthy()
    expect(screen.getByText('연결됨 · 계정 333333333333')).toBeTruthy()
    expect(screen.getAllByText('운영 AWS')).toHaveLength(1)
    await fireEvent.press(screen.getByText('실험 AWS'))
    await waitFor(() => expect(accountApi.setConnectionAws).toHaveBeenCalledWith(1, 6))
    expect(accountApi.setConnectionAws).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('운영 계정에 이을 AWS 계정')).toBeNull()
  })

  test('다른 작업 중에는 항목이 잠기고 눌러도 보내지 않으며 창도 닫히지 않는다 (최종 검토 4)', async () => {
    let resolve
    accountApi.reverifyAws.mockReturnValue(new Promise((r) => { resolve = r }))
    accountApi.getTemplateStatus.mockResolvedValue(status())
    accountApi.setConnectionAws.mockResolvedValue({})
    await show(blockOf(aws()), { awsAccounts: others })
    await fireEvent.press(btn('운영 계정 AWS 이미 연결한 계정에서 고르기'))
    expect(btn('운영 계정에 이을 AWS 계정: 실험 AWS, 연결됨 · 계정 333333333333')).toBeEnabled()
    await fireEvent.press(btn('운영 계정 AWS 연결 확인'))
    expect(btn('운영 계정에 이을 AWS 계정: 실험 AWS, 연결됨 · 계정 333333333333')).toBeDisabled()
    await fireEvent.press(screen.getByText('실험 AWS'))
    expect(accountApi.setConnectionAws).not.toHaveBeenCalled()
    expect(screen.getByText('운영 계정에 이을 AWS 계정')).toBeTruthy()
    await act(async () => { resolve({ status: 'invalid', a_id: 1 }) })
    expect(btn('운영 계정에 이을 AWS 계정: 실험 AWS, 연결됨 · 계정 333333333333')).toBeEnabled()
    await fireEvent.press(screen.getByText('실험 AWS'))
    await waitFor(() => expect(accountApi.setConnectionAws).toHaveBeenCalledTimes(1))
  })

  test('닫기는 아무것도 보내지 않는다', async () => {
    await show(blockOf(aws()), { awsAccounts: others })
    await fireEvent.press(btn('운영 계정 AWS 이미 연결한 계정에서 고르기'))
    await fireEvent.press(btn('운영 계정에 이을 AWS 계정 닫기'))
    expect(screen.queryByText('운영 계정에 이을 AWS 계정')).toBeNull()
    expect(accountApi.setConnectionAws).not.toHaveBeenCalled()
  })

  test('잇기가 실패하면 서버 메시지를 보인다', async () => {
    accountApi.setConnectionAws.mockRejectedValue(new Error('이을 수 없습니다'))
    await show(blockOf(aws()), { awsAccounts: others })
    await fireEvent.press(btn('운영 계정 AWS 이미 연결한 계정에서 고르기'))
    await fireEvent.press(screen.getByText('실험 AWS'))
    expect(await screen.findByText('이을 수 없습니다')).toBeTruthy()
  })
})

describe('AWS 상자 - 접근성', () => {
  test('상자의 모든 버튼 이름에 블록 이름이 들어간다', async () => {
    await show(blockOf(aws({ status: 'invalid', last_error: 'x' })), {
      awsAccounts: [aws({ a_id: 5, label: '개발 AWS' })], templateStatus: { 1: status({ update_needed: true, template_file_count: 2 }) },
    })
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThanOrEqual(6)
    for (const b of buttons) expect(b.props.accessibilityLabel).toContain('운영 계정')
  })

  test('연결 전 상자도 마찬가지다', async () => {
    await show(blockOf(null), { awsAccounts: [aws({ a_id: 5, label: '개발 AWS' })] })
    for (const b of screen.getAllByRole('button')) expect(b.props.accessibilityLabel).toContain('운영 계정')
  })
})
