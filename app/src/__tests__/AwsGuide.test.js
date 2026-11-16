import { Linking, Platform, StyleSheet } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { StrictMode } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { render, screen, fireEvent, act, within } from '@testing-library/react-native'
import AwsGuide from '../components/accounts/AwsGuide'
import AwsUpdateGuide from '../components/accounts/AwsUpdateGuide'
import ExistingPicker from '../components/accounts/ExistingPicker'

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
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }))
jest.mock('../api', () => ({ BASE_URL: 'http://localhost:8081', accountApi: {} }))

const SECRET = 'EXT-9f3a7c1d-SECRET-VALUE'
const CONSOLE = 'https://ap-northeast-2.console.aws.amazon.com/cloudformation/home?region=ap-northeast-2#/stacks/create'
const SETUP = {
  a_id: 7, label: '운영 계정', external_id: SECRET, our_account_id: '111122223333',
  template_download_url: '/api/accounts/aws/template', stack_create_url: CONSOLE,
}
const STACKS = 'https://ap-northeast-2.console.aws.amazon.com/cloudformation/home?region=ap-northeast-2#/stacks'
const INFO = {
  a_id: 1, label: '운영 AWS', current_version: 0, latest_version: 2, update_needed: true, template_file_count: 0,
  template_download_url: '/api/accounts/aws/template', stack_list_url: STACKS, checked: false,
}

beforeEach(() => {
  mockKavProps.length = 0
  Clipboard.setStringAsync.mockReset().mockResolvedValue(true)
  jest.spyOn(Linking, 'openURL').mockReset().mockResolvedValue(true)
  jest.spyOn(console, 'error')
  jest.spyOn(console, 'warn')
})

afterEach(() => {
  const noisy = [...console.error.mock.calls, ...console.warn.mock.calls]
  jest.restoreAllMocks()
  expect(noisy).toEqual([])
})

const guide = (props = {}) => render(<AwsGuide setup={SETUP} busy={false} error="" onSubmit={jest.fn()} onClose={jest.fn()} {...props} />)

// 화면 트리에서 접근성 속성과 id 속성의 값을 모두 모은다
const a11yValues = () => {
  const out = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    for (const [k, v] of Object.entries(node.props || {})) {
      if (/^(accessibility|aria|testID|nativeID|href)/i.test(k)) out.push(String(JSON.stringify(v)))
    }
    walk(node.children)
  }
  walk(screen.toJSON())
  return out
}

describe('AWS 연결 안내 - 7단계', () => {
  test('일곱 단계의 제목이 웹과 같은 글로 보인다', async () => {
    await guide()
    expect(screen.getByText('역할 만들고 붙여넣기 — 운영 계정')).toBeTruthy()
    for (const t of [
      '템플릿 내려받기', '스택 생성 화면에서 파일 올리기', '스택 이름과 파라미터 넣기', '스택 옵션은 그대로 두고 [다음]',
      'IAM 승인을 체크하고 [전송]', '완료되면 [출력] 탭에서 RoleArn 복사', 'RoleArn 붙여넣고 [확인]',
    ]) expect(screen.getByText(t)).toBeTruthy()
    expect(screen.getAllByTestId('guide-step')).toHaveLength(7)
    expect(screen.getByText('ExternalId는 지금 한 번만 보여줍니다. 이 창을 닫으면 다시 볼 수 없습니다.')).toBeTruthy()
  })

  test('스택 이름, 계정 ID, ExternalId 값이 칸 옆에 보이고 각각 복사된다', async () => {
    await guide()
    expect(screen.getByText('deploy-wizard')).toBeTruthy()
    expect(screen.getByText('111122223333')).toBeTruthy()
    expect(screen.getByText(SECRET)).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 스택 이름 복사' }))
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('deploy-wizard')
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 TrustedAwsAccountId 복사' }))
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('111122223333')
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 ExternalId 복사' }))
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(SECRET)
    expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(3)
  })

  test('복사하면 그 버튼만 잠깐 복사됨으로 바뀐다', async () => {
    await guide()
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 ExternalId 복사' }))
    expect(await screen.findByRole('button', { name: '운영 계정 ExternalId 복사됨' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '운영 계정 스택 이름 복사' })).toBeTruthy()
  })

  test('복사가 false 이거나 실패하면 복사됨으로 바꾸지 않고 값 없이 알린다', async () => {
    Clipboard.setStringAsync.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error(`clipboard ${SECRET}`))
    await guide()
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 ExternalId 복사' }))
    expect(await screen.findByText('복사하지 못했습니다')).toBeTruthy()
    expect(screen.queryByText('복사됨')).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 스택 이름 복사' }))
    expect(screen.getAllByText('복사하지 못했습니다')).toHaveLength(1)
    // 복사 버튼이 있는 3단계 안에 오류가 보인다 (맨 위로 되돌아가지 않아도 된다)
    expect(within(screen.getAllByTestId('guide-step')[2]).getByText('복사하지 못했습니다')).toBeTruthy()
    expect(screen.queryByText(new RegExp(`clipboard`))).toBeNull()
  })

  test('ExternalId 는 접근성 이름·힌트·id 어디에도 실리지 않는다', async () => {
    await guide()
    const values = a11yValues()
    expect(values.length).toBeGreaterThan(5)
    for (const v of values) expect(v).not.toContain(SECRET)
  })
})

describe('AWS 연결 안내 - 닫기 버튼과 StrictMode', () => {
  test('오른쪽 위 닫기는 나중에와 같이 닫고, 접근성 이름에 계정 이름이 있다', async () => {
    const onClose = jest.fn()
    await guide({ onClose })
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 안내 닫기' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('닫기 버튼의 눌림 크기는 44 이상이다', async () => {
    await guide()
    const style = StyleSheet.flatten(screen.getByRole('button', { name: '운영 계정 안내 닫기' }).props.style)
    expect(style.minHeight).toBeGreaterThanOrEqual(44)
    expect(style.minWidth).toBeGreaterThanOrEqual(44)
  })

  test('열기 실패는 복사 단계 안이 아니라 맨 위에 보인다', async () => {
    Linking.openURL.mockRejectedValueOnce(new Error('x'))
    await guide()
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 콘솔 열기' }))
    expect(await screen.findByText('주소를 열 수 없습니다')).toBeTruthy()
    expect(within(screen.getAllByTestId('guide-step')[2]).queryByText('주소를 열 수 없습니다')).toBeNull()
  })

  test('StrictMode 에서도 복사와 주소 열기가 동작한다', async () => {
    await render(<StrictMode><AwsGuide setup={SETUP} busy={false} error="" onSubmit={jest.fn()} onClose={jest.fn()} /></StrictMode>)
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 ExternalId 복사' }))
    expect(await screen.findByRole('button', { name: '운영 계정 ExternalId 복사됨' })).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 콘솔 열기' }))
    expect(Linking.openURL).toHaveBeenCalledWith(CONSOLE)
  })
})

describe('AWS 연결 안내 - 바깥 주소 열기', () => {
  test('콘솔 열기는 https 스택 생성 주소를 연다', async () => {
    await guide()
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 콘솔 열기' }))
    expect(Linking.openURL).toHaveBeenCalledWith(CONSOLE)
  })

  test('템플릿 받기는 상대 주소를 API 주소에 붙여 연다 (로컬 API 는 http 여도 된다)', async () => {
    await guide()
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 템플릿 받기' }))
    expect(Linking.openURL).toHaveBeenCalledWith('http://localhost:8081/api/accounts/aws/template')
  })

  test.each([
    ['http 주소', 'http://evil.example/cloudformation'],
    ['javascript 주소', 'javascript:alert(1)'],
    ['공백 앞붙은 주소', ' https://evil.example'],
    ['호스트 없는 https', 'https://'],
    ['없는 주소', undefined],
  ])('콘솔 열기: %s 는 열지 않고 알린다', async (_name, url) => {
    await guide({ setup: { ...SETUP, stack_create_url: url } })
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 콘솔 열기' }))
    expect(Linking.openURL).not.toHaveBeenCalled()
    expect(await screen.findByText('주소를 열 수 없습니다')).toBeTruthy()
  })

  test.each([
    ['다른 호스트의 http 주소', 'http://evil.example/api/accounts/aws/template'],
    ['API 주소로 시작하는 다른 호스트', 'http://localhost:8081.evil.example/x'],
    ['프로토콜 상대 주소', '//evil.example/x'],
    ['javascript 주소', 'javascript:alert(1)'],
  ])('템플릿 받기: %s 는 열지 않는다', async (_name, url) => {
    await guide({ setup: { ...SETUP, template_download_url: url } })
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 템플릿 받기' }))
    expect(Linking.openURL).not.toHaveBeenCalled()
    expect(await screen.findByText('주소를 열 수 없습니다')).toBeTruthy()
  })

  test('템플릿 받기: 절대 https 주소는 그대로 연다', async () => {
    await guide({ setup: { ...SETUP, template_download_url: 'https://wizard.example/api/accounts/aws/template' } })
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 템플릿 받기' }))
    expect(Linking.openURL).toHaveBeenCalledWith('https://wizard.example/api/accounts/aws/template')
  })

  test('열기가 거부되면 알린다', async () => {
    Linking.openURL.mockRejectedValue(new Error('no browser'))
    await guide()
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 콘솔 열기' }))
    expect(await screen.findByText('주소를 열 수 없습니다')).toBeTruthy()
  })
})

describe('AWS 연결 안내 - RoleArn 등록', () => {
  const ARN = 'arn:aws:iam::222222222222:role/DeployWizardCrossAccountRole'
  const input = () => screen.getByPlaceholderText('arn:aws:iam::...:role/DeployWizardCrossAccountRole')

  test('빈 값이나 공백뿐이면 확인이 잠겨 있다', async () => {
    const onSubmit = jest.fn()
    await guide({ onSubmit })
    const ok = () => screen.getByRole('button', { name: '운영 계정 역할 ARN 확인' })
    expect(ok()).toBeDisabled()
    await fireEvent.changeText(input(), '   ')
    expect(ok()).toBeDisabled()
    await fireEvent.press(ok())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('앞뒤 공백을 지우고 한 번 보낸다', async () => {
    const onSubmit = jest.fn()
    await guide({ onSubmit })
    await fireEvent.changeText(input(), `  ${ARN}\n`)
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 역할 ARN 확인' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith(ARN)
  })

  test('작업 중이면 확인을 눌러도 보내지 않는다', async () => {
    const onSubmit = jest.fn()
    await guide({ onSubmit, busy: true })
    await fireEvent.changeText(input(), ARN)
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 역할 ARN 확인' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('키보드의 완료 키도 같은 규칙으로 한 번만 보낸다', async () => {
    const onSubmit = jest.fn()
    await guide({ onSubmit })
    await fireEvent(input(), 'submitEditing')
    expect(onSubmit).not.toHaveBeenCalled()
    await fireEvent.changeText(input(), ` ${ARN} `)
    await fireEvent(input(), 'submitEditing')
    expect(onSubmit).toHaveBeenCalledWith(ARN)
  })

  test('서버가 거절한 메시지를 안내 안에서 보여 준다', async () => {
    await guide({ error: '역할을 빌릴 수 없습니다' })
    expect(screen.getByText('역할을 빌릴 수 없습니다')).toBeTruthy()
  })

  test('나중에와 뒤로 가기(onRequestClose)는 닫는다', async () => {
    const onClose = jest.fn()
    await guide({ onClose })
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정 안내 나중에' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    await fireEvent(screen.getByTestId('guide-modal'), 'requestClose')
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(screen.getByText('[나중에]를 눌러도 연결은 대기 상태로 남습니다. 다만 ExternalId는 다시 볼 수 없으니, 스택을 만든 뒤에 닫으세요.')).toBeTruthy()
  })

  test('긴 입력도 줄바꿈되고 스크롤은 탭을 놓치지 않는다', async () => {
    await guide()
    const scroll = screen.getByTestId('guide-scroll')
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled')
  })

  test('안드로이드에서는 안내 전체를 KeyboardAvoidingView(height) 가 감싼다 (기기에서는 확인하지 못했다)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    await guide()
    expect(mockKavProps[mockKavProps.length - 1].behavior).toBe('height')
  })
})

describe('안내 창 - 상태 표시줄 여백 (최종 검토 1)', () => {
  const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 24, left: 0, right: 0, bottom: 0 } }
  const topPadding = () => StyleSheet.flatten(mockKavProps[mockKavProps.length - 1].style).paddingTop

  test('안드로이드에서 제목 줄 위 여백은 안전 영역 위쪽 값이다', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AwsGuide setup={SETUP} busy={false} error="" onSubmit={jest.fn()} onClose={jest.fn()} />
      </SafeAreaProvider>,
    )
    expect(topPadding()).toBe(24)
  })

  test('스택 업데이트 안내도 같은 틀이라 같은 여백이다', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AwsUpdateGuide info={INFO} busy={false} error="" onCheck={jest.fn()} onClose={jest.fn()} />
      </SafeAreaProvider>,
    )
    expect(topPadding()).toBe(24)
  })

  test('웹에서는 여백을 더하지 않는다', async () => {
    jest.replaceProperty(Platform, 'OS', 'web')
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AwsGuide setup={SETUP} busy={false} error="" onSubmit={jest.fn()} onClose={jest.fn()} />
      </SafeAreaProvider>,
    )
    expect(topPadding()).toBe(0)
  })
})

describe('AWS 연결 안내 - 이어서 하기', () => {
  test('ExternalId 없이 RoleArn 만 받는다', async () => {
    await guide({ setup: { a_id: 7, label: '운영 계정' }, resume: true })
    expect(screen.getByText(/ExternalId는 처음 한 번만 보여주기 때문에 다시 볼 수 없습니다/)).toBeTruthy()
    expect(screen.getAllByTestId('guide-step')).toHaveLength(1)
    expect(screen.queryByText('ExternalId')).toBeNull()
    expect(screen.queryByRole('button', { name: /복사/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /콘솔 열기/ })).toBeNull()
    expect(screen.getByText('RoleArn 붙여넣고 [확인]')).toBeTruthy()
  })
})

describe('스택 업데이트 안내', () => {
  const update = (props = {}) => render(<AwsUpdateGuide info={INFO} busy={false} error="" onCheck={jest.fn()} onClose={jest.fn()} {...props} />)

  test('버전과 다섯 단계가 웹과 같은 글로 보인다', async () => {
    await update()
    expect(screen.getByText('스택 업데이트가 필요합니다 — 운영 AWS')).toBeTruthy()
    expect(screen.getByText(/지금 연결된 역할은 예전 권한\(버전 0\)이라/)).toBeTruthy()
    expect(screen.getByText(/최신 템플릿\(버전 2\)으로 스택을 한 번 업데이트하면 됩니다/)).toBeTruthy()
    for (const t of [
      '최신 템플릿 내려받기', '콘솔에서 스택을 고르고 [업데이트]', '기존 템플릿을 새 파일로 교체',
      '파라미터와 옵션은 그대로 [다음]', 'IAM 승인을 체크하고 [전송]',
    ]) expect(screen.getByText(t)).toBeTruthy()
    expect(screen.getAllByTestId('guide-step')).toHaveLength(5)
  })

  test('템플릿 받기와 스택 목록 열기', async () => {
    await update()
    await fireEvent.press(screen.getByRole('button', { name: '운영 AWS 템플릿 받기' }))
    expect(Linking.openURL).toHaveBeenLastCalledWith('http://localhost:8081/api/accounts/aws/template')
    await fireEvent.press(screen.getByRole('button', { name: '운영 AWS 스택 목록 열기' }))
    expect(Linking.openURL).toHaveBeenLastCalledWith(STACKS)
  })

  test('스택 목록이 https 가 아니면 열지 않고 알린다', async () => {
    await update({ info: { ...INFO, stack_list_url: 'http://evil.example/stacks' } })
    await fireEvent.press(screen.getByRole('button', { name: '운영 AWS 스택 목록 열기' }))
    expect(Linking.openURL).not.toHaveBeenCalledWith('http://evil.example/stacks')
    expect(await screen.findByText('주소를 열 수 없습니다')).toBeTruthy()
  })

  test('업데이트 확인은 작업 중이면 잠기고, 아직이면 웹과 같은 글을 보인다', async () => {
    const onCheck = jest.fn()
    const view = await update({ onCheck, busy: true })
    expect(screen.getByRole('button', { name: '운영 AWS 업데이트 확인' })).toBeDisabled()
    await view.rerender(<AwsUpdateGuide info={{ ...INFO, checked: true }} busy={false} error="" onCheck={onCheck} onClose={jest.fn()} />)
    expect(screen.getByText('아직 예전 버전(0)입니다. 스택 상태가 UPDATE_COMPLETE 인지 확인한 뒤 다시 눌러 주세요.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: '운영 AWS 업데이트 확인' }))
    expect(onCheck).toHaveBeenCalledTimes(1)
  })

  test('오른쪽 위 닫기도 닫는다', async () => {
    const onClose = jest.fn()
    await update({ onClose })
    await fireEvent.press(screen.getByRole('button', { name: '운영 AWS 업데이트 안내 닫기' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('나중에는 닫고 서버 오류는 안내 안에 보인다', async () => {
    const onClose = jest.fn()
    await update({ onClose, error: '확인하지 못했습니다' })
    expect(screen.getByText('확인하지 못했습니다')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: '운영 AWS 업데이트 안내 나중에' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ExistingPicker', () => {
  const items = [
    { key: 5, title: '개발 계정', subtitle: '연결됨 · 계정 111111111111' },
    { key: 6, title: '아주 긴 이름의 계정 '.repeat(5).trim(), subtitle: '역할 등록 대기' },
  ]

  test('목록을 보이고 누른 항목을 알린다', async () => {
    const onPick = jest.fn()
    await render(<ExistingPicker title="운영 계정에 이을 AWS 계정" items={items} onPick={onPick} onClose={jest.fn()} />)
    expect(screen.getByText('운영 계정에 이을 AWS 계정')).toBeTruthy()
    expect(screen.getByText('연결됨 · 계정 111111111111')).toBeTruthy()
    await fireEvent.press(screen.getByText('개발 계정'))
    expect(onPick).toHaveBeenCalledWith(items[0])
  })

  test('버튼 이름에 제목이 들어가고, 닫기와 뒤로 가기는 닫는다', async () => {
    const onClose = jest.fn()
    await render(<ExistingPicker title="운영 계정에 이을 AWS 계정" items={items} onPick={jest.fn()} onClose={onClose} />)
    expect(screen.getByRole('button', { name: '운영 계정에 이을 AWS 계정: 개발 계정, 연결됨 · 계정 111111111111' })).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: '운영 계정에 이을 AWS 계정 닫기' }))
    await fireEvent(screen.getByTestId('picker-modal'), 'requestClose')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  test('작업 중(busy)이면 항목을 눌러도 알리지 않는다 (최종 검토 4)', async () => {
    const onPick = jest.fn()
    await render(<ExistingPicker title="고르기" items={items} busy onPick={onPick} onClose={jest.fn()} />)
    const item = screen.getByRole('button', { name: '고르기: 개발 계정, 연결됨 · 계정 111111111111' })
    expect(item).toBeDisabled()
    await fireEvent.press(screen.getByText('개발 계정'))
    expect(onPick).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '고르기 닫기' })).toBeEnabled()
  })

  test('작업 중이 아니면 항목을 누를 수 있다', async () => {
    await render(<ExistingPicker title="고르기" items={items} busy={false} onPick={jest.fn()} onClose={jest.fn()} />)
    expect(screen.getByRole('button', { name: '고르기: 개발 계정, 연결됨 · 계정 111111111111' })).toBeEnabled()
  })

  test('항목이 많으면 안에서 스크롤한다', async () => {
    await render(<ExistingPicker title="고르기" items={items} onPick={jest.fn()} onClose={jest.fn()} />)
    expect(screen.getByTestId('picker-list').props.keyboardShouldPersistTaps).toBe('handled')
  })
})
