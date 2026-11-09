import { StyleSheet } from 'react-native'
import { render, screen, fireEvent } from '@testing-library/react-native'
import AdvicePanel from '../components/AdvicePanel'
import { lightColors } from '../theme'

// 웹 AdvicePanel 과 같은 모양의 분석 결과 (보통 수준, 비용 null, 지원 안 되는 데이터베이스)
const advice = {
  tier: 'medium',
  confidence: 'medium',
  cpu: null,
  memory: null,
  cost: { monthly_min: null, monthly_max: null, currency: 'USD', basis_date: null, note: '트래픽에 따라 늘어납니다' },
  reasons: ['sqlalchemy 라이브러리를 사용해 중간 사양으로 잡았습니다 (requirements.txt)'],
  needs: [
    { kind: 'database', supported: false, message: '마법사가 아직 만들어 주지 못합니다', count: null },
    { kind: 'env_vars', supported: true, message: null, count: 4 },
  ],
  unknowns: ['환경변수 FOO의 종류를 알 수 없습니다'],
  language: 'python',
  support_level: 'official',
  app_dir: 'backend',
  commit_sha: '089917e',
}

// 패널을 그리고 핸들러 목을 돌려준다
const setup = async (over = {}, props = {}) => {
  const onDeploy = jest.fn()
  const onReset = jest.fn()
  await render(<AdvicePanel advice={{ ...advice, ...over }} busy={false} onDeploy={onDeploy} onReset={onReset} {...props} />)
  return { onDeploy, onReset }
}

describe('분석 결과 패널', () => {
  test('advice 가 없으면 아무것도 그리지 않는다', async () => {
    await render(<AdvicePanel advice={null} busy={false} onDeploy={jest.fn()} onReset={jest.fn()} />)
    expect(screen.queryByText('분석 결과')).toBeNull()
  })

  test('보통 수준 결과의 내용이 웹과 같은 문구로 나온다', async () => {
    await setup()
    expect(screen.getByText('분석 결과')).toBeTruthy()
    expect(screen.getByText('python')).toBeTruthy()
    expect(screen.getByText('공식 지원')).toBeTruthy()
    expect(screen.getByText('앱 폴더: backend')).toBeTruthy()
    expect(screen.getByText('추천 수준: 보통')).toBeTruthy()
    expect(screen.getByText('확신도 보통')).toBeTruthy()
    expect(screen.getByText('왜 이렇게 추천했나')).toBeTruthy()
    expect(screen.getByText('sqlalchemy 라이브러리를 사용해 중간 사양으로 잡았습니다 (requirements.txt)')).toBeTruthy()
    expect(screen.getByText('필요한 것')).toBeTruthy()
    expect(screen.getByText('환경변수 4개 입력이 필요합니다')).toBeTruthy()
    expect(screen.getByText('분석은 읽기만 합니다. 배포를 누르기 전에는 AWS에 아무것도 만들지 않습니다.')).toBeTruthy()
  })

  test('비용이 null 이면 계산할 수 없다는 문장이고 0 은 나오지 않는다', async () => {
    await setup()
    expect(screen.getByText('예상 비용: 아직 계산할 수 없습니다 (실제 배포로 요금 구성을 확인한 뒤 표시됩니다). 트래픽에 따라 늘어납니다.')).toBeTruthy()
    expect(screen.queryByText(/0~0/)).toBeNull()
  })

  test('비용 하나만 숫자여도 계산할 수 없다는 문장이다', async () => {
    await setup({ cost: { monthly_min: 5, monthly_max: null, currency: 'USD', basis_date: null, note: null } })
    expect(screen.getByText(/아직 계산할 수 없습니다/)).toBeTruthy()
  })

  test('비용이 둘 다 숫자면 범위를 보여 준다', async () => {
    await setup({ cost: { monthly_min: 5, monthly_max: 9, currency: 'USD', basis_date: '2026-11-01', note: '참고' } })
    expect(screen.getByText(/예상 비용: 5~9 USD\/월/)).toBeTruthy()
    expect(screen.queryByText(/아직 계산할 수 없습니다/)).toBeNull()
  })

  test('지원하지 않는 필요 항목은 흐리게 하고 이유를 붙인다', async () => {
    await setup()
    const row = screen.getByText('데이터베이스 — 마법사가 아직 만들어 주지 못합니다')
    expect(StyleSheet.flatten(row.props.style).color).toBe(lightColors.muted)
    const ok = screen.getByText('환경변수 4개 입력이 필요합니다')
    expect(StyleSheet.flatten(ok.props.style).color).toBe(lightColors.text)
  })

  test('앱 폴더가 . 이면 나오지 않는다', async () => {
    await setup({ app_dir: '.' })
    expect(screen.queryByText(/앱 폴더/)).toBeNull()
  })

  test('앱 폴더가 비어 있으면 나오지 않는다', async () => {
    await setup({ app_dir: '' })
    expect(screen.queryByText(/앱 폴더/)).toBeNull()
  })

  test('실험 지원 언어는 실험 지원 배지', async () => {
    await setup({ support_level: 'experimental', language: 'go' })
    expect(screen.getByText('실험 지원')).toBeTruthy()
    expect(screen.queryByText('공식 지원')).toBeNull()
  })

  test('확신도가 낮으면 추정입니다 안내가 나온다', async () => {
    await setup({ confidence: 'low' })
    expect(screen.getByText('확신도 낮음')).toBeTruthy()
    expect(screen.getByText('추정입니다. 근거가 부족해 틀릴 수 있습니다.')).toBeTruthy()
  })

  test('확신도가 낮지 않으면 추정입니다 안내가 없다', async () => {
    await setup({ confidence: 'high' })
    expect(screen.getByText('확신도 높음')).toBeTruthy()
    expect(screen.queryByText(/추정입니다/)).toBeNull()
  })

  test('알 수 없었던 것은 접혀 있고 누르면 펼쳐진다', async () => {
    await setup()
    expect(screen.getByText('알 수 없었던 것 (1)')).toBeTruthy()
    expect(screen.queryByText('환경변수 FOO의 종류를 알 수 없습니다')).toBeNull()
    await fireEvent.press(screen.getByText('알 수 없었던 것 (1)'))
    expect(screen.getByText('환경변수 FOO의 종류를 알 수 없습니다')).toBeTruthy()
    await fireEvent.press(screen.getByText('알 수 없었던 것 (1)'))
    expect(screen.queryByText('환경변수 FOO의 종류를 알 수 없습니다')).toBeNull()
  })

  test('이유, 필요한 것, 알 수 없었던 것이 비면 그 제목을 그리지 않는다', async () => {
    await setup({ reasons: [], needs: [], unknowns: [] })
    expect(screen.queryByText('왜 이렇게 추천했나')).toBeNull()
    expect(screen.queryByText('필요한 것')).toBeNull()
    expect(screen.queryByText(/알 수 없었던 것/)).toBeNull()
    expect(screen.getByText('이 레포로 배포')).toBeTruthy()
  })

  test('목록 필드가 없어도 죽지 않는다', async () => {
    await render(<AdvicePanel advice={{ tier: 'small', confidence: 'high', language: 'node', support_level: 'official', cost: null }} busy={false} onDeploy={jest.fn()} onReset={jest.fn()} />)
    expect(screen.getByText('추천 수준: 가벼움')).toBeTruthy()
    expect(screen.getByText(/아직 계산할 수 없습니다/)).toBeTruthy()
  })

  test('긴 이유 문장도 그대로 나온다', async () => {
    const long = '아주 긴 설명 '.repeat(40).trim()
    await setup({ reasons: [long] })
    expect(screen.getByText(long)).toBeTruthy()
  })

  test('버튼이 부모 핸들러를 부른다', async () => {
    const { onDeploy, onReset } = await setup()
    await fireEvent.press(screen.getByText('이 레포로 배포'))
    await fireEvent.press(screen.getByText('다른 레포로'))
    expect(onDeploy).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  test('busy 이면 두 버튼이 눌러도 부르지 않는다', async () => {
    const { onDeploy, onReset } = await setup({}, { busy: true })
    await fireEvent.press(screen.getByText('이 레포로 배포'))
    await fireEvent.press(screen.getByText('다른 레포로'))
    expect(onDeploy).not.toHaveBeenCalled()
    expect(onReset).not.toHaveBeenCalled()
  })
})
