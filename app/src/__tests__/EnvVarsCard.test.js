import { AccessibilityInfo } from 'react-native'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native'
import { envApi } from '../api'
import EnvVarsCard from '../components/EnvVarsCard'

jest.mock('../api', () => ({
  envApi: { getAll: jest.fn(), put: jest.fn(), clearValue: jest.fn(), continueDeploy: jest.fn() },
}))

// 웹 계획의 UI 확인용 행과 같은 모양
const row = (name, extra = {}) => ({
  name, required: true, has_default: false, kind: 'config', source: 'code', source_hint: 'app/config.py:12',
  status: 'detected', has_value: false, needs_redeploy: false, ...extra,
})
const fixture = () => [
  row('MY_THING_URL', { kind: 'unknown' }),
  row('DATABASE_URL', { kind: 'database', source_hint: 'app/db.py:3' }),
  row('LOG_LEVEL'),
  row('PAGE_SIZE', { required: false, has_default: true }),
  row('OLD_FLAG', { status: 'skipped', source_hint: null }),
]

// 서버를 흉내 낸다 - put 은 행을 바꾸고, 목록은 그 상태를 돌려준다
let rows
let putBodies
beforeEach(() => {
  rows = fixture()
  putBodies = []
  envApi.getAll.mockReset().mockImplementation(async () => rows.map((r) => ({ ...r })))
  envApi.put.mockReset().mockImplementation(async (d_id, name, body) => {
    putBodies.push({ name, body })
    const target = rows.find((r) => r.name === name)
    if (!target) {
      const added = row(name, { kind: body.kind })
      rows.push(added)
      return added
    }
    if (body.value !== undefined) { target.status = 'set'; target.has_value = true }
    if (body.skip === true) target.status = 'skipped'
    if (body.skip === false) target.status = 'detected'
    if (body.kind) target.kind = body.kind
    return { ...target }
  })
  envApi.clearValue.mockReset().mockImplementation(async (d_id, name) => {
    const target = rows.find((r) => r.name === name)
    target.status = 'detected'
    target.has_value = false
    return { ...target }
  })
  envApi.continueDeploy.mockReset().mockResolvedValue({ status: 'queued' })
  jest.spyOn(console, 'error')
})

afterEach(() => {
  expect(console.error).not.toHaveBeenCalled()
  jest.restoreAllMocks()
})

const deploy = (status = 'needs_input') => ({ d_id: 7, status })
const open = async (props = {}) => {
  const onContinued = jest.fn()
  const onRedeploy = jest.fn()
  const ui = (d) => <EnvVarsCard onContinued={onContinued} onRedeploy={onRedeploy} deploy={d} />
  const view = await render(ui(props.deploy || deploy()))
  await screen.findByText('환경변수')
  return { onContinued, onRedeploy, view, ui }
}
const button = (name) => screen.getByRole('button', { name })
const isDisabled = (name) => !!button(name).props.accessibilityState?.disabled
const input = (name) => screen.getByLabelText(`${name} 값`)

describe('환경변수 카드 - 묶음과 안내', () => {
  test('머리말, 항상 보이는 경고, 묶음 제목과 개수', async () => {
    await open()
    expect(screen.getByText('코드에서 필요한 값을 찾았습니다. 값은 이 화면에서만 입력하고, 한 번 저장하면 다시 보여 드리지 않습니다.')).toBeTruthy()
    expect(screen.getByText('자동으로 찾지 못한 변수가 있을 수 있습니다. 배포 후 앱이 시작하지 못하면 알려 드립니다.')).toBeTruthy()
    expect(screen.getByText('꼭 필요해 보이는 것')).toBeTruthy()
    expect(screen.getByText('종류를 모르는 것')).toBeTruthy()
    expect(screen.getByText(/기본값이 있어 비워도 되는 것/)).toBeTruthy()
    expect(screen.getByText(/입력 완료/)).toBeTruthy()
    // 필수 두 개(DATABASE_URL, LOG_LEVEL), 모르는 종류 한 개
    expect(screen.getAllByText('(2)').length).toBeGreaterThan(0)
    expect(screen.getByText('MY_THING_URL')).toBeTruthy()
    expect(screen.getByText('DATABASE_URL')).toBeTruthy()
  })

  test('접힌 묶음은 눌러야 열린다', async () => {
    await open()
    expect(screen.queryByText('PAGE_SIZE')).toBeNull()
    expect(screen.queryByText('OLD_FLAG')).toBeNull()
    await fireEvent.press(screen.getByText(/기본값이 있어 비워도 되는 것/))
    expect(screen.getByText('PAGE_SIZE')).toBeTruthy()
    await fireEvent.press(screen.getByText(/입력 완료/))
    expect(screen.getByText('OLD_FLAG')).toBeTruthy()
    expect(screen.getByText('건너뜀')).toBeTruthy()
    expect(button('OLD_FLAG 건너뛰기 취소')).toBeTruthy()
  })

  test('행이 없고 needs_input 이 아니면 아무것도 그리지 않는다', async () => {
    rows = []
    await render(<EnvVarsCard deploy={deploy('running')} onContinued={jest.fn()} onRedeploy={jest.fn()} />)
    await waitFor(() => expect(envApi.getAll).toHaveBeenCalled())
    expect(screen.queryByText('환경변수')).toBeNull()
  })

  test('행이 없어도 needs_input 이면 안내와 이어서 배포를 보여 준다', async () => {
    rows = []
    await open()
    expect(screen.getByText('입력할 환경변수를 찾지 못했습니다. [이어서 배포]를 눌러 계속하세요.')).toBeTruthy()
    expect(isDisabled('이어서 배포')).toBe(false)
  })

  test('running 에서는 이어서 배포 줄이 없다', async () => {
    await open({ deploy: deploy('running') })
    expect(screen.queryByText('이어서 배포')).toBeNull()
  })

  test('상태가 바뀌면 목록을 다시 받는다', async () => {
    const { view, ui } = await open()
    expect(envApi.getAll).toHaveBeenCalledTimes(1)
    await view.rerender(ui(deploy('queued')))
    await waitFor(() => expect(envApi.getAll).toHaveBeenCalledTimes(2))
  })

  test('목록을 못 받으면 제목과 오류만 보인다', async () => {
    envApi.getAll.mockRejectedValue(new Error('서버에 연결할 수 없습니다'))
    await render(<EnvVarsCard deploy={deploy()} onContinued={jest.fn()} onRedeploy={jest.fn()} />)
    expect(await screen.findByText('서버에 연결할 수 없습니다')).toBeTruthy()
    expect(screen.getByText('환경변수')).toBeTruthy()
    expect(screen.queryByText('이어서 배포')).toBeNull()
  })
})

describe('환경변수 카드 - 값 입력', () => {
  test('저장하면 value 를 보내고 성공한 뒤에만 입력창을 비운다', async () => {
    await open()
    expect(isDisabled('LOG_LEVEL 저장')).toBe(true)
    await fireEvent.changeText(input('LOG_LEVEL'), 'info')
    expect(input('LOG_LEVEL').props.value).toBe('info')
    expect(input('LOG_LEVEL').props.maxLength).toBe(2000)
    expect(input('LOG_LEVEL').props.autoComplete).toBe('off')
    await fireEvent.press(button('LOG_LEVEL 저장'))
    expect(envApi.put).toHaveBeenCalledWith(7, 'LOG_LEVEL', { value: 'info' })
    await waitFor(() => expect(screen.queryByLabelText('LOG_LEVEL 값')).toBeNull())
    // 입력 완료 묶음으로 옮겨졌다
    await fireEvent.press(screen.getByText(/입력 완료/))
    expect(screen.getByText('입력됨')).toBeTruthy()
    expect(button('LOG_LEVEL 값 지우기')).toBeTruthy()
  })

  test('저장이 실패하면 입력한 값은 그대로 남고 오류에는 값이 없다', async () => {
    envApi.put.mockRejectedValueOnce(new Error('요청 실패 (500)'))
    await open()
    await fireEvent.changeText(input('LOG_LEVEL'), 'sk-secret-123')
    await fireEvent.press(button('LOG_LEVEL 저장'))
    expect(await screen.findByText('요청 실패 (500)')).toBeTruthy()
    expect(input('LOG_LEVEL').props.value).toBe('sk-secret-123')
    expect(screen.queryByText(/sk-secret/)).toBeNull()
  })

  test('저장 뒤에는 값이 어떤 글자에도 남지 않는다', async () => {
    await open()
    await fireEvent.changeText(input('LOG_LEVEL'), 'sk-secret-123')
    await fireEvent.press(button('LOG_LEVEL 저장'))
    await waitFor(() => expect(screen.queryByLabelText('LOG_LEVEL 값')).toBeNull())
    await fireEvent.press(screen.getByText(/입력 완료/))
    expect(screen.queryByText(/sk-secret/)).toBeNull()
    expect(JSON.stringify(screen.toJSON())).not.toContain('sk-secret')
    expect(JSON.stringify(envApi.getAll.mock.calls)).not.toContain('sk-secret')
  })

  test('config 행의 건너뛰기는 skip:true 를 보낸다', async () => {
    await open()
    await fireEvent.press(button('LOG_LEVEL 건너뛰기'))
    expect(envApi.put).toHaveBeenCalledWith(7, 'LOG_LEVEL', { skip: true })
  })

  test('값 지우기와 건너뛰기 취소', async () => {
    rows[2].status = 'set'
    rows[2].has_value = true
    await open()
    await fireEvent.press(screen.getByText(/입력 완료/))
    await fireEvent.press(button('LOG_LEVEL 값 지우기'))
    expect(envApi.clearValue).toHaveBeenCalledWith(7, 'LOG_LEVEL')
    await waitFor(() => expect(input('LOG_LEVEL')).toBeTruthy())
    await fireEvent.press(button('OLD_FLAG 건너뛰기 취소'))
    expect(envApi.put).toHaveBeenCalledWith(7, 'OLD_FLAG', { skip: false })
  })
})

describe('환경변수 카드 - 종류별 규칙', () => {
  test('시크릿 종류 행에는 입력창이 없고 건너뛰기만 있다', async () => {
    await open()
    expect(screen.queryByLabelText('DATABASE_URL 값')).toBeNull()
    expect(screen.queryByLabelText('DATABASE_URL 저장')).toBeNull()
    expect(screen.getAllByText('이 종류의 값은 아직 저장할 수 없습니다. 지금은 건너뛰기만 됩니다.')).toHaveLength(1)
    await fireEvent.press(button('DATABASE_URL 건너뛰기'))
    expect(envApi.put).toHaveBeenCalledWith(7, 'DATABASE_URL', { skip: true })
  })

  test.each(['database', 'cache', 'external_api', 'secret'])('%s 종류에는 입력창이 없다', async (kind) => {
    rows = [row('SOME_KEY', { kind })]
    await open()
    expect(screen.queryByLabelText('SOME_KEY 값')).toBeNull()
    expect(screen.queryByText('저장')).toBeNull()
    expect(button('SOME_KEY 건너뛰기')).toBeTruthy()
  })

  test('모르는 종류 행: 종류 버튼 다섯 개와 건너뛰기, 입력창은 없다', async () => {
    await open()
    expect(screen.queryByLabelText('MY_THING_URL 값')).toBeNull()
    for (const label of ['데이터베이스 주소', '캐시 주소', '외부 서비스 키', '비밀값', '일반 설정']) {
      expect(button(`MY_THING_URL 종류: ${label}`)).toBeTruthy()
    }
    await fireEvent.press(button('MY_THING_URL 건너뛰기'))
    expect(envApi.put).toHaveBeenCalledWith(7, 'MY_THING_URL', { skip: true })
  })

  test('종류 버튼은 kind 를 보내고 그 행이 필수 묶음으로 옮겨 입력창이 생긴다', async () => {
    await open()
    await fireEvent.press(button('MY_THING_URL 종류: 일반 설정'))
    expect(envApi.put).toHaveBeenCalledWith(7, 'MY_THING_URL', { kind: 'config' })
    expect(await screen.findByLabelText('MY_THING_URL 값')).toBeTruthy()
    expect(screen.queryByText('종류를 모르는 것')).toBeNull()
  })

  test('다섯 종류에 없는 kind 는 모르는 종류로 다룬다 (입력창 없음)', async () => {
    rows = [row('WEIRD', { kind: 'zzz' })]
    await open()
    expect(screen.queryByLabelText('WEIRD 값')).toBeNull()
    expect(button('WEIRD 종류: 일반 설정')).toBeTruthy()
    expect(button('WEIRD 건너뛰기')).toBeTruthy()
    expect(screen.getByText('알 수 없음')).toBeTruthy()
  })
})

describe('환경변수 카드 - 직접 추가', () => {
  test('새 이름은 kind 와 함께 보낸다', async () => {
    await open()
    await fireEvent.changeText(screen.getByLabelText('추가할 변수 이름'), 'API_BASE_URL')
    await fireEvent.press(screen.getByRole('radio', { name: '캐시 주소' }))
    await fireEvent.press(button('변수 직접 추가'))
    expect(envApi.put).toHaveBeenCalledWith(7, 'API_BASE_URL', { kind: 'cache' })
    await waitFor(() => expect(screen.getByLabelText('추가할 변수 이름').props.value).toBe(''))
  })

  test('이미 목록에 있는 이름은 메시지만 보이고 요청이 없다', async () => {
    await open()
    await fireEvent.changeText(screen.getByLabelText('추가할 변수 이름'), 'LOG_LEVEL')
    await fireEvent.press(button('변수 직접 추가'))
    expect(screen.getByText('이미 목록에 있는 변수입니다')).toBeTruthy()
    expect(envApi.put).not.toHaveBeenCalled()
    // 고치면 메시지가 사라진다
    await fireEvent.changeText(screen.getByLabelText('추가할 변수 이름'), 'LOG_LEVEL2')
    expect(screen.queryByText('이미 목록에 있는 변수입니다')).toBeNull()
  })

  test('규칙에 어긋난 이름은 서버 호출 없이 거절한다', async () => {
    await open()
    await fireEvent.changeText(screen.getByLabelText('추가할 변수 이름'), '1ABC')
    await fireEvent.press(button('변수 직접 추가'))
    expect(screen.getByText('이름은 영문자나 _로 시작하고, 영문자·숫자·_만 100자까지 쓸 수 있습니다.')).toBeTruthy()
    expect(envApi.put).not.toHaveBeenCalled()
  })

  test('이름이 비어 있으면 추가 버튼이 잠긴다', async () => {
    await open()
    expect(isDisabled('변수 직접 추가')).toBe(true)
  })
})

describe('환경변수 카드 - 이어서 배포', () => {
  test('필수 행이 모두 입력 또는 건너뜀이 되기 전까지 잠기고 이유가 보인다', async () => {
    await open()
    expect(isDisabled('이어서 배포')).toBe(true)
    expect(screen.getByText('필수 환경변수에 값이 없습니다')).toBeTruthy()
    await fireEvent.press(button('MY_THING_URL 건너뛰기'))
    await fireEvent.press(button('DATABASE_URL 건너뛰기'))
    await fireEvent.changeText(input('LOG_LEVEL'), 'info')
    await fireEvent.press(button('LOG_LEVEL 저장'))
    await waitFor(() => expect(isDisabled('이어서 배포')).toBe(false))
    expect(screen.queryByText('필수 환경변수에 값이 없습니다')).toBeNull()
  })

  test('409 는 이유를 보여 주고 입력한 글자는 그대로, 다음에 성공하면 onContinued', async () => {
    rows = [row('DATABASE_URL', { kind: 'config' }), row('X', { required: false })]
    envApi.continueDeploy.mockRejectedValueOnce(new Error('필수 환경변수에 값이 없습니다 :DATABASE_URL'))
    const { onContinued } = await open()
    // 필수가 없는 상태로 만들어 버튼을 연다 (서버는 여전히 409 를 줄 수 있다)
    await fireEvent.press(button('DATABASE_URL 건너뛰기'))
    await waitFor(() => expect(isDisabled('이어서 배포')).toBe(false))
    await fireEvent.press(screen.getByText(/기본값이 있어 비워도 되는 것/))
    await fireEvent.changeText(input('X'), 'keep-me')
    await fireEvent.press(button('이어서 배포'))
    expect(await screen.findByText('필수 환경변수에 값이 없습니다 :DATABASE_URL')).toBeTruthy()
    expect(onContinued).not.toHaveBeenCalled()
    expect(input('X').props.value).toBe('keep-me')
    await fireEvent.press(button('이어서 배포'))
    await waitFor(() => expect(onContinued).toHaveBeenCalledTimes(1))
    expect(envApi.continueDeploy).toHaveBeenCalledWith(7)
    expect(screen.queryByText('필수 환경변수에 값이 없습니다 :DATABASE_URL')).toBeNull()
  })
})

describe('환경변수 카드 - 다시 배포 안내', () => {
  const redeployRows = () => {
    rows = [row('LOG_LEVEL')]
    envApi.put.mockImplementation(async (d_id, name, body) => {
      putBodies.push({ name, body })
      rows[0].status = 'set'
      return { ...rows[0], status: 'set', has_value: true, needs_redeploy: true }
    })
  }

  test('needs_redeploy 이고 진행 중이 아니면 안내와 다시 배포 버튼, 누르면 onRedeploy 와 함께 사라진다', async () => {
    redeployRows()
    const { onRedeploy } = await open({ deploy: deploy('running') })
    await fireEvent.changeText(input('LOG_LEVEL'), 'debug')
    await fireEvent.press(button('LOG_LEVEL 저장'))
    expect(await screen.findByText('다시 배포해야 적용됩니다')).toBeTruthy()
    await fireEvent.press(button('다시 배포'))
    expect(onRedeploy).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('다시 배포해야 적용됩니다')).toBeNull()
  })

  test('진행 중이면 문구만 보이고 다시 배포 버튼은 없다', async () => {
    redeployRows()
    await open({ deploy: deploy('building') })
    await fireEvent.changeText(input('LOG_LEVEL'), 'debug')
    await fireEvent.press(button('LOG_LEVEL 저장'))
    expect(await screen.findByText('다시 배포해야 적용됩니다')).toBeTruthy()
    expect(screen.queryByText('다시 배포')).toBeNull()
  })
})

describe('환경변수 카드 - 요청 순서', () => {
  test('상태 때문에 시작한 느린 목록이 나중에 도착해도 더 새로운 변경 뒤 목록을 덮어쓰지 않는다', async () => {
    const stale = fixture()
    let release
    const { view, ui } = await open({ deploy: deploy('running') })
    envApi.getAll.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(stale) }))
    await view.rerender(ui(deploy('failed')))
    await waitFor(() => expect(release).toBeDefined())
    // 느린 목록이 오기 전에 LOG_LEVEL 을 건너뛴다
    await fireEvent.press(button('LOG_LEVEL 건너뛰기'))
    await waitFor(() => expect(screen.queryByLabelText('LOG_LEVEL 값')).toBeNull())
    await act(async () => { release() })
    expect(screen.queryByLabelText('LOG_LEVEL 값')).toBeNull()
  })
})

describe('환경변수 카드 - 접근성', () => {
  test('저장·건너뛰기 버튼 이름에 변수 이름이 들어 있다', async () => {
    await open()
    expect(button('LOG_LEVEL 저장')).toBeTruthy()
    expect(button('LOG_LEVEL 건너뛰기')).toBeTruthy()
    expect(button('DATABASE_URL 건너뛰기')).toBeTruthy()
    expect(input('LOG_LEVEL')).toBeTruthy()
  })

  test('변경이 끝나면 제목으로 읽기 초점을 옮긴다', async () => {
    const spy = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {})
    await open()
    await fireEvent.press(button('LOG_LEVEL 건너뛰기'))
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.anything(), 'focus'))
  })
})
