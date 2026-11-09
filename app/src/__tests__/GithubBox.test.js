import { StrictMode, useRef, useState } from 'react'
import { Linking, StyleSheet } from 'react-native'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native'
import { accountApi } from '../api'
import { githubCheckNotice } from '../accounts/notices'
import { Notice } from '../components/ui'
import GithubBox from '../components/accounts/GithubBox'

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }))
jest.mock('../api', () => ({
  BASE_URL: 'http://localhost:8081',
  accountApi: { getGithubInstallUrl: jest.fn(), checkGithub: jest.fn(), setConnectionGithub: jest.fn() },
}))

const INSTALL = 'https://github.com/apps/deploy-wizard/installations/new?state=1'
const NOTICE = 'GitHub 설치 화면에서 설치를 마치고 이 앱으로 돌아오세요.'
const NOT_YET = '아직 설치가 확인되지 않았습니다. GitHub 설치를 마쳤는지 확인하고 다시 시도하세요. 서버의 GitHub 앱 콜백 주소를 이 폰에서 열 수 없으면 PC에서 연결해야 합니다.'
const gh = (over = {}) => ({
  g_id: 5, installation_id: 1001, account_login: 'kjfcvx12', account_type: 'User', repository_selection: 'all',
  status: 'active', created_at: '2026-11-01T00:00:00', updated_at: '2026-11-09T00:00:00', ...over,
})
const blockOf = (github, c_id = 1, label = '운영 계정') => ({ c_id, label, aws: null, github })
const CHECK = { g_id: 5, account_login: 'kjfcvx12', repository_count: 7, repositories: ['a', 'b'] }

// 화면(AccountsScreen)의 run/busy 와 같은 규칙으로 GithubBox 를 감싼다
function Harness({ block, installations = [], reload, setNotice, returnTick }) {
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
      <GithubBox block={block} installations={installations} busy={busy} run={run} reload={reload} setNotice={setNotice} returnTick={returnTick} />
    </>
  )
}

let reload
let setNotice
beforeEach(() => {
  reload = jest.fn().mockResolvedValue(true)
  setNotice = jest.fn()
  for (const fn of Object.values(accountApi)) fn.mockReset()
  jest.spyOn(Linking, 'openURL').mockReset().mockResolvedValue(true)
  jest.spyOn(console, 'error')
  jest.spyOn(console, 'warn')
})
afterEach(() => {
  const noisy = [...console.error.mock.calls, ...console.warn.mock.calls]
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

const el = (block, installations, returnTick) => <Harness block={block} installations={installations} reload={reload} setNotice={setNotice} returnTick={returnTick} />
const show = (block, installations) => render(el(block, installations))
const btn = (name) => screen.getByRole('button', { name })

describe('GitHub 상자 - 연결 전', () => {
  test('연결 안 됨 배지와 안내, 채운 계정 추가만 보인다', async () => {
    await show(blockOf(null))
    expect(screen.getByText('GitHub 계정')).toBeTruthy()
    expect(screen.getByText('연결 안 됨')).toBeTruthy()
    expect(screen.getByText('이 블록은 아직 GitHub 연결 전입니다. 연결하지 않으면 public 레포만 배포할 수 있습니다.')).toBeTruthy()
    expect(btn('운영 계정 GitHub 계정 추가')).toBeEnabled()
    expect(screen.queryByText('연결 확인')).toBeNull()
    expect(screen.queryByText('연결 해제')).toBeNull()
    expect(screen.queryByText('이미 연결한 계정에서 고르기')).toBeNull()
  })

  test('계정 추가 - 블록 번호로 설치 주소를 받아 한 번 열고 안내를 띄운다', async () => {
    accountApi.getGithubInstallUrl.mockResolvedValue({ url: INSTALL })
    await show(blockOf(null))
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    await waitFor(() => expect(setNotice).toHaveBeenLastCalledWith(NOTICE))
    expect(accountApi.getGithubInstallUrl).toHaveBeenCalledWith(1)
    expect(Linking.openURL).toHaveBeenCalledTimes(1)
    expect(Linking.openURL).toHaveBeenCalledWith(INSTALL)
    expect(btn('운영 계정 GitHub 계정 추가')).toBeEnabled()
  })

  test('https 가 아닌 주소는 열지 않고 알린다', async () => {
    accountApi.getGithubInstallUrl.mockResolvedValue({ url: 'http://github.com/apps/x/installations/new' })
    await show(blockOf(null))
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    expect(await screen.findByText('주소를 열 수 없습니다')).toBeTruthy()
    expect(Linking.openURL).not.toHaveBeenCalled()
    expect(setNotice).not.toHaveBeenCalledWith(NOTICE)
    expect(btn('운영 계정 GitHub 계정 추가')).toBeEnabled()
  })

  test('브라우저 열기에 실패해도 알리고 버튼을 푼다', async () => {
    accountApi.getGithubInstallUrl.mockResolvedValue({ url: INSTALL })
    Linking.openURL.mockRejectedValue(new Error('no browser'))
    await show(blockOf(null))
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    expect(await screen.findByText('주소를 열 수 없습니다')).toBeTruthy()
    expect(btn('운영 계정 GitHub 계정 추가')).toBeEnabled()
  })

  test('503 (앱 미등록) 이면 서버 메시지를 그대로 보이고 버튼을 푼다', async () => {
    accountApi.getGithubInstallUrl.mockRejectedValue(new Error('GitHub App이 등록되지 않았습니다.'))
    await show(blockOf(null))
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    expect(await screen.findByText('GitHub App이 등록되지 않았습니다.')).toBeTruthy()
    expect(Linking.openURL).not.toHaveBeenCalled()
    expect(btn('운영 계정 GitHub 계정 추가')).toBeEnabled()
  })

  test('요청이 끝나기 전에는 모든 버튼이 잠기고 두 번 눌러도 한 번만 부른다', async () => {
    let resolve
    accountApi.getGithubInstallUrl.mockReturnValue(new Promise((r) => { resolve = r }))
    await show(blockOf(null), [gh({ g_id: 9 })])
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    expect(accountApi.getGithubInstallUrl).toHaveBeenCalledTimes(1)
    expect(btn('운영 계정 GitHub 계정 추가')).toBeDisabled()
    expect(btn('운영 계정 GitHub 이미 연결한 계정에서 고르기')).toBeDisabled()
    await act(async () => { resolve({ url: INSTALL }) })
    expect(Linking.openURL).toHaveBeenCalledTimes(1)
    expect(btn('운영 계정 GitHub 계정 추가')).toBeEnabled()
  })
})

describe('GitHub 상자 - 연결됨', () => {
  test('계정 이름·종류·레포 범위·상태와 세 버튼이 보인다', async () => {
    await show(blockOf(gh({ account_type: 'Organization', repository_selection: 'selected' })))
    expect(screen.getByText('kjfcvx12')).toBeTruthy()
    expect(screen.getByText('조직 · 선택한 레포')).toBeTruthy()
    expect(screen.getByText('연결됨')).toBeTruthy()
    expect(btn('운영 계정 GitHub 계정 추가')).toBeEnabled()
    expect(btn('운영 계정 GitHub 연결 확인')).toBeEnabled()
    expect(btn('운영 계정 GitHub 연결 해제')).toBeEnabled()
  })

  test('개인 계정과 전체 레포', async () => {
    await show(blockOf(gh()))
    expect(screen.getByText('개인 · 전체 레포')).toBeTruthy()
  })

  test.each([['suspended', '일시 중지'], ['revoked', '끊김']])('%s 상태는 %s 로 보인다', async (status, label) => {
    await show(blockOf(gh({ status })))
    expect(screen.getByText(label)).toBeTruthy()
    expect(screen.queryByText('연결됨')).toBeNull()
  })

  test('모르는 상태는 값 그대로 보인다', async () => {
    await show(blockOf(gh({ status: 'weird' })))
    expect(screen.getByText('weird')).toBeTruthy()
  })

  test('연결 확인 - 확인 결과를 알림으로 보낸다', async () => {
    accountApi.checkGithub.mockResolvedValue(CHECK)
    await show(blockOf(gh()))
    await fireEvent.press(btn('운영 계정 GitHub 연결 확인'))
    await waitFor(() => expect(setNotice).toHaveBeenLastCalledWith(githubCheckNotice(CHECK)))
    expect(accountApi.checkGithub).toHaveBeenCalledTimes(1)
    expect(accountApi.checkGithub).toHaveBeenCalledWith(5)
    expect(setNotice.mock.calls.at(-1)[0]).toBe('GitHub 연결 확인됨 — kjfcvx12 · 레포 7개에 접근할 수 있습니다 (a, b 외)')
  })

  test('연결 확인이 400 이면 서버 메시지를 보이고 버튼을 푼다', async () => {
    accountApi.checkGithub.mockRejectedValue(new Error('GitHub 연결이 끊겼습니다. 다시 설치해 주세요.'))
    await show(blockOf(gh({ status: 'revoked' })))
    await fireEvent.press(btn('운영 계정 GitHub 연결 확인'))
    expect(await screen.findByText('GitHub 연결이 끊겼습니다. 다시 설치해 주세요.')).toBeTruthy()
    expect(btn('운영 계정 GitHub 연결 확인')).toBeEnabled()
  })

  test('연결 해제 - 확인 없이 블록에서 뗀다 (설치는 그대로) 그리고 목록을 다시 받는다', async () => {
    accountApi.setConnectionGithub.mockResolvedValue({})
    await show(blockOf(gh()))
    await fireEvent.press(btn('운영 계정 GitHub 연결 해제'))
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(accountApi.setConnectionGithub).toHaveBeenCalledWith(1, null)
  })

  test('연결 해제 실패 시 서버 메시지를 보이고 버튼을 푼다', async () => {
    accountApi.setConnectionGithub.mockRejectedValue(new Error('블록을 찾을 수 없습니다.'))
    await show(blockOf(gh()))
    await fireEvent.press(btn('운영 계정 GitHub 연결 해제'))
    expect(await screen.findByText('블록을 찾을 수 없습니다.')).toBeTruthy()
    expect(reload).not.toHaveBeenCalled()
    expect(btn('운영 계정 GitHub 연결 해제')).toBeEnabled()
  })

  test('이미 설치된 블록에서 계정 추가는 블록 번호 없이 주소를 받는다 (웹과 같다) 그리고 고르기 안내를 덧붙인다', async () => {
    accountApi.getGithubInstallUrl.mockResolvedValue({ url: INSTALL })
    await show(blockOf(gh()))
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith(INSTALL))
    expect(accountApi.getGithubInstallUrl).toHaveBeenCalledWith(null)
    expect(setNotice.mock.calls.at(-1)[0]).toBe(`${NOTICE} 새 계정을 이 블록에 쓰려면 [이미 연결한 계정에서 고르기]로 고르세요.`)
  })
})

describe('GitHub 상자 - 이미 연결한 계정에서 고르기', () => {
  test('이 블록이 쓰는 설치뿐이면 고르기 버튼이 없다', async () => {
    const mine = gh({ g_id: 5, account_login: 'mine-login' })
    await show(blockOf(mine), [mine])
    expect(screen.queryByText('이미 연결한 계정에서 고르기')).toBeNull()
  })

  test('이 블록이 쓰지 않는 설치만 목록에 나오고, 고르면 블록에 잇고 목록을 다시 받는다', async () => {
    const mine = gh({ g_id: 5, account_login: 'mine-login' })
    const other = gh({ g_id: 6, account_login: 'other-login', status: 'suspended', account_type: 'Organization' })
    const third = gh({ g_id: 7, account_login: 'third-login' })
    accountApi.setConnectionGithub.mockResolvedValue({})
    await show(blockOf(mine), [mine, other, third])
    await fireEvent.press(btn('운영 계정 GitHub 이미 연결한 계정에서 고르기'))
    expect(screen.getByTestId('picker-modal')).toBeTruthy()
    expect(screen.getByText('운영 계정에 이을 GitHub 계정')).toBeTruthy()
    expect(screen.getAllByText('other-login')).toHaveLength(1)
    expect(screen.getAllByText('third-login')).toHaveLength(1)
    expect(screen.getAllByText('mine-login')).toHaveLength(1)
    expect(screen.getByText('일시 중지 · 조직')).toBeTruthy()
    await fireEvent.press(screen.getByText('other-login'))
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(accountApi.setConnectionGithub).toHaveBeenCalledWith(1, 6)
    expect(accountApi.setConnectionGithub).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('picker-modal')).toBeNull()
  })

  test('다른 작업 중에는 항목이 잠기고 눌러도 보내지 않으며 창도 닫히지 않는다 (최종 검토 4)', async () => {
    let resolve
    accountApi.checkGithub.mockReturnValue(new Promise((r) => { resolve = r }))
    accountApi.setConnectionGithub.mockResolvedValue({})
    const mine = gh({ g_id: 5, account_login: 'mine-login' })
    const other = gh({ g_id: 6, account_login: 'other-login' })
    await show(blockOf(mine), [mine, other])
    await fireEvent.press(btn('운영 계정 GitHub 이미 연결한 계정에서 고르기'))
    const item = () => btn('운영 계정에 이을 GitHub 계정: other-login, 연결됨 · 개인')
    expect(item()).toBeEnabled()
    await fireEvent.press(btn('운영 계정 GitHub 연결 확인'))
    expect(item()).toBeDisabled()
    await fireEvent.press(screen.getByText('other-login'))
    expect(accountApi.setConnectionGithub).not.toHaveBeenCalled()
    expect(screen.getByTestId('picker-modal')).toBeTruthy()
    await act(async () => { resolve(CHECK) })
    expect(item()).toBeEnabled()
    await fireEvent.press(screen.getByText('other-login'))
    await waitFor(() => expect(accountApi.setConnectionGithub).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('picker-modal')).toBeNull()
  })

  test('연결 전 블록에서도 모든 설치가 나오고, 닫으면 아무것도 보내지 않는다', async () => {
    await show(blockOf(null), [gh({ g_id: 5, account_login: 'one' }), gh({ g_id: 6, account_login: 'two' })])
    await fireEvent.press(btn('운영 계정 GitHub 이미 연결한 계정에서 고르기'))
    expect(screen.getByText('one')).toBeTruthy()
    expect(screen.getByText('two')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정에 이을 GitHub 계정 닫기' }))
    expect(screen.queryByTestId('picker-modal')).toBeNull()
    expect(accountApi.setConnectionGithub).not.toHaveBeenCalled()
  })
})

describe('GitHub 상자 - 설치 뒤 돌아왔을 때 자동 확인', () => {
  const start = async (block) => {
    accountApi.getGithubInstallUrl.mockResolvedValue({ url: INSTALL })
    const view = await show(block)
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    await waitFor(() => expect(setNotice).toHaveBeenCalledWith(expect.stringContaining(NOTICE)))
    return view
  }

  test('계정 추가를 누른 뒤 블록에 설치가 새로 생기면 확인을 한 번 하고 알린다', async () => {
    accountApi.checkGithub.mockResolvedValue(CHECK)
    const view = await start(blockOf(null))
    expect(accountApi.checkGithub).not.toHaveBeenCalled()
    await view.rerender(el(blockOf(gh())))
    await waitFor(() => expect(setNotice).toHaveBeenLastCalledWith(githubCheckNotice(CHECK)))
    expect(accountApi.checkGithub).toHaveBeenCalledTimes(1)
    expect(accountApi.checkGithub).toHaveBeenCalledWith(5)
    // 이후 목록이 다시 와도 (같은 설치) 또 확인하지 않는다
    await view.rerender(el(blockOf(gh({ repository_selection: 'selected' }))))
    await view.rerender(el(blockOf(gh({ updated_at: 'later' }))))
    expect(accountApi.checkGithub).toHaveBeenCalledTimes(1)
  })

  test('확인이 실패하면 서버 메시지를 보인다', async () => {
    accountApi.checkGithub.mockRejectedValue(new Error('GitHub 연결이 끊겼습니다.'))
    const view = await start(blockOf(null))
    await view.rerender(el(blockOf(gh())))
    expect(await screen.findByText('GitHub 연결이 끊겼습니다.')).toBeTruthy()
    expect(accountApi.checkGithub).toHaveBeenCalledTimes(1)
  })

  test('아직 설치가 안 생겼으면 확인하지 않고, 나중에 생기면 그때 한 번 한다', async () => {
    accountApi.checkGithub.mockResolvedValue(CHECK)
    const view = await start(blockOf(null))
    await view.rerender(el(blockOf(null)))
    await view.rerender(el(blockOf(null)))
    expect(accountApi.checkGithub).not.toHaveBeenCalled()
    await view.rerender(el(blockOf(gh({ g_id: 8 }))))
    await waitFor(() => expect(accountApi.checkGithub).toHaveBeenCalledTimes(1))
    expect(accountApi.checkGithub).toHaveBeenCalledWith(8)
  })

  test('계정 추가를 누르지 않았으면 설치가 생겨도 확인하지 않는다 (다른 곳에서 이은 경우)', async () => {
    const view = await show(blockOf(null))
    await view.rerender(el(blockOf(gh())))
    expect(accountApi.checkGithub).not.toHaveBeenCalled()
    expect(setNotice).not.toHaveBeenCalledWith(expect.stringContaining('연결 확인됨'))
  })

  test('이미 설치가 있던 블록은 설치 주소를 열어도 자동 확인하지 않는다', async () => {
    const view = await start(blockOf(gh({ g_id: 5 })))
    await view.rerender(el(blockOf(gh({ g_id: 6 }))))
    expect(accountApi.checkGithub).not.toHaveBeenCalled()
  })

  test('주소 열기가 거절되면 기다리지 않는다 (https 아님)', async () => {
    accountApi.getGithubInstallUrl.mockResolvedValue({ url: 'ftp://x' })
    const view = await show(blockOf(null))
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    await screen.findByText('주소를 열 수 없습니다')
    await view.rerender(el(blockOf(gh())))
    expect(accountApi.checkGithub).not.toHaveBeenCalled()
  })

  test('기다리는 동안 목록에서 직접 고르면 기다림을 끝낸다 (자동 확인 없음)', async () => {
    accountApi.setConnectionGithub.mockResolvedValue({})
    const view = await start(blockOf(null))
    await view.rerender(el(blockOf(null), [gh({ g_id: 6, account_login: 'other' })]))
    await fireEvent.press(btn('운영 계정 GitHub 이미 연결한 계정에서 고르기'))
    await fireEvent.press(screen.getByText('other'))
    await waitFor(() => expect(reload).toHaveBeenCalled())
    await view.rerender(el(blockOf(gh({ g_id: 6 }))))
    expect(accountApi.checkGithub).not.toHaveBeenCalled()
  })

  test('StrictMode 에서도 열기·확인은 한 번만 한다', async () => {
    accountApi.getGithubInstallUrl.mockResolvedValue({ url: INSTALL })
    accountApi.checkGithub.mockResolvedValue(CHECK)
    const wrap = (b) => <StrictMode>{el(b)}</StrictMode>
    const view = await render(wrap(blockOf(null)))
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    await waitFor(() => expect(setNotice).toHaveBeenCalledWith(NOTICE))
    await view.rerender(wrap(blockOf(gh())))
    await waitFor(() => expect(accountApi.checkGithub).toHaveBeenCalledTimes(1))
    expect(Linking.openURL).toHaveBeenCalledTimes(1)
  })

  test('언마운트한 뒤에는 확인 결과를 알리지 않는다', async () => {
    let resolve
    accountApi.checkGithub.mockReturnValue(new Promise((r) => { resolve = r }))
    const view = await start(blockOf(null))
    await view.rerender(el(blockOf(gh())))
    await waitFor(() => expect(accountApi.checkGithub).toHaveBeenCalledTimes(1))
    setNotice.mockClear()
    await view.unmount()
    await act(async () => { resolve(CHECK) })
    expect(setNotice).not.toHaveBeenCalled()
  })
})

describe('GitHub 상자 - 돌아왔는데 설치가 없을 때 (최종 검토 2, 앱 전용)', () => {
  const start = async (block, tick = 0) => {
    accountApi.getGithubInstallUrl.mockResolvedValue({ url: INSTALL })
    const view = await render(el(block, [], tick))
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    await waitFor(() => expect(setNotice).toHaveBeenCalledWith(expect.stringContaining(NOTICE)))
    return view
  }

  test('기다리는 중에 돌아왔는데도 설치가 없으면 안내를 한 번 보이고 확인은 하지 않는다', async () => {
    const view = await start(blockOf(null))
    setNotice.mockClear()
    await view.rerender(el(blockOf(null), [], 1))
    expect(setNotice).toHaveBeenCalledTimes(1)
    expect(setNotice).toHaveBeenCalledWith(NOT_YET)
    expect(accountApi.checkGithub).not.toHaveBeenCalled()
    // 같은 복귀에서 목록만 다시 와도 또 보이지 않는다
    await view.rerender(el(blockOf(null), [], 1))
    expect(setNotice).toHaveBeenCalledTimes(1)
  })

  test('기다림은 그대로라서 다음 복귀에서 설치가 생기면 확인한다 (복귀마다 안내는 한 번)', async () => {
    accountApi.checkGithub.mockResolvedValue(CHECK)
    const view = await start(blockOf(null))
    await view.rerender(el(blockOf(null), [], 1))
    await view.rerender(el(blockOf(null), [], 2))
    expect(setNotice.mock.calls.filter(([m]) => m === NOT_YET)).toHaveLength(2)
    await view.rerender(el(blockOf(gh()), [], 3))
    await waitFor(() => expect(accountApi.checkGithub).toHaveBeenCalledTimes(1))
    expect(setNotice).not.toHaveBeenLastCalledWith(NOT_YET)
    expect(setNotice.mock.calls.filter(([m]) => m === NOT_YET)).toHaveLength(2)
  })

  test('설치 화면을 연 적이 없으면 돌아와도 안내하지 않는다', async () => {
    const view = await show(blockOf(null))
    await view.rerender(el(blockOf(null), [], 1))
    expect(setNotice).not.toHaveBeenCalled()
  })

  test('돌아왔는데 설치가 생겼으면 안내 대신 확인한다', async () => {
    accountApi.checkGithub.mockResolvedValue(CHECK)
    const view = await start(blockOf(null))
    await view.rerender(el(blockOf(gh()), [], 1))
    await waitFor(() => expect(accountApi.checkGithub).toHaveBeenCalledTimes(1))
    expect(setNotice).not.toHaveBeenCalledWith(NOT_YET)
  })

  test('이미 설치가 있던 블록은 돌아와도 안내하지 않는다', async () => {
    const view = await start(blockOf(gh()))
    await view.rerender(el(blockOf(gh()), [], 1))
    expect(setNotice).not.toHaveBeenCalledWith(NOT_YET)
  })

  test('열기가 거절되면 기다리지 않으므로 돌아와도 안내하지 않는다', async () => {
    accountApi.getGithubInstallUrl.mockResolvedValue({ url: 'ftp://x' })
    const view = await show(blockOf(null))
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    await screen.findByText('주소를 열 수 없습니다')
    await view.rerender(el(blockOf(null), [], 1))
    expect(setNotice).not.toHaveBeenCalledWith(NOT_YET)
  })

  test('열기가 끝나기 전에 돌아온 것도 알아본다 (openURL 이 복귀 뒤에 끝나는 경우)', async () => {
    let resolveOpen
    Linking.openURL.mockReturnValue(new Promise((r) => { resolveOpen = r }))
    accountApi.getGithubInstallUrl.mockResolvedValue({ url: INSTALL })
    accountApi.checkGithub.mockResolvedValue(CHECK)
    const view = await show(blockOf(null))
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledTimes(1))
    // 아직 openURL 이 끝나지 않았는데 앱이 돌아와 목록에 설치가 생겼다
    await view.rerender(el(blockOf(gh()), [], 1))
    expect(accountApi.checkGithub).not.toHaveBeenCalled()
    await act(async () => { resolveOpen(true) })
    await waitFor(() => expect(accountApi.checkGithub).toHaveBeenCalledTimes(1))
    expect(accountApi.checkGithub).toHaveBeenCalledWith(5)
  })

  test('열기가 끝나기 전에 돌아왔는데 설치가 없으면 열기가 끝난 뒤 안내한다', async () => {
    let resolveOpen
    Linking.openURL.mockReturnValue(new Promise((r) => { resolveOpen = r }))
    accountApi.getGithubInstallUrl.mockResolvedValue({ url: INSTALL })
    const view = await show(blockOf(null))
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledTimes(1))
    await view.rerender(el(blockOf(null), [], 1))
    await act(async () => { resolveOpen(true) })
    await waitFor(() => expect(setNotice).toHaveBeenLastCalledWith(NOT_YET))
  })

  test('열기에 실패하면 기다림을 되돌린다', async () => {
    Linking.openURL.mockRejectedValue(new Error('no browser'))
    accountApi.getGithubInstallUrl.mockResolvedValue({ url: INSTALL })
    const view = await show(blockOf(null))
    await fireEvent.press(btn('운영 계정 GitHub 계정 추가'))
    await screen.findByText('주소를 열 수 없습니다')
    await view.rerender(el(blockOf(gh()), [], 1))
    expect(accountApi.checkGithub).not.toHaveBeenCalled()
  })
})

describe('GitHub 상자 - 접근성과 터치 크기', () => {
  test('모든 버튼 이름에 블록 이름이 들어 있고 높이는 44 이상이다', async () => {
    await show(blockOf(gh(), 1, '내 블록'), [gh({ g_id: 6, account_login: 'o' })])
    const names = ['GitHub 계정 추가', 'GitHub 연결 확인', 'GitHub 이미 연결한 계정에서 고르기', 'GitHub 연결 해제']
    for (const n of names) {
      const b = screen.getByRole('button', { name: `내 블록 ${n}` })
      expect(StyleSheet.flatten(b.props.style).minHeight).toBeGreaterThanOrEqual(44)
    }
  })
})
