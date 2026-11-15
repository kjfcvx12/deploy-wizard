import { StyleSheet } from 'react-native'
import { render, screen, fireEvent } from '@testing-library/react-native'
import NotificationKinds from '../components/ops/NotificationKinds'
import { NOTIFICATION_KIND_LABEL, NOTIFICATION_KINDS } from '../ops/constants'
import { KIND_HINT } from '../ops/notificationSettings'

const ALL = [...NOTIFICATION_KINDS]
const LABELS = Object.values(NOTIFICATION_KIND_LABEL)
const FOOT = '끈 종류는 앱 안 알림 목록에도 남지 않습니다'

const draw = async (props = {}) => {
  const onToggle = jest.fn()
  const view = await render(<NotificationKinds kinds={ALL} busy={false} onToggle={onToggle} {...props} />)
  return { onToggle, ...view }
}
const tile = (label) => screen.getByRole('switch', { name: `${label} 알림` })

describe('알림 종류 - 타일', () => {
  test('7개 종류가 switch 로 그려지고 이름은 "<라벨> 알림" 이다', async () => {
    await draw()
    expect(screen.getAllByRole('switch')).toHaveLength(7)
    for (const label of LABELS) expect(tile(label)).toBeTruthy()
    expect(screen.getByRole('header', { name: '받을 알림' })).toBeTruthy()
  })

  test('켜진 종류만 checked 다', async () => {
    await draw({ kinds: ['deploy_failed', 'new_commit'] })
    expect(tile('배포 실패').props.accessibilityState.checked).toBe(true)
    expect(tile('새 커밋').props.accessibilityState.checked).toBe(true)
    expect(tile('문제 감지').props.accessibilityState.checked).toBe(false)
  })

  test('타일을 누르면 onToggle(kind) 를 한 번 부른다', async () => {
    const { onToggle } = await draw()
    await fireEvent.press(tile('복구 완료'))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('incident_recovered')
  })

  test('busy 면 모든 타일이 busy 상태다 (잠금은 부모가 맡는다)', async () => {
    await draw({ busy: true })
    for (const label of LABELS) expect(tile(label).props.accessibilityState.busy).toBe(true)
  })

  test('타일 높이는 44 이상이다', async () => {
    await draw()
    const style = StyleSheet.flatten(tile('문제 감지').props.style)
    expect(style.minHeight).toBeGreaterThanOrEqual(44)
  })
})

describe('알림 종류 - 설명 접기', () => {
  test('처음에는 설명 글이 안 보이고 accessibilityHint 로는 항상 있다', async () => {
    await draw()
    expect(screen.queryByText(new RegExp(KIND_HINT.incident_opened))).toBeNull()
    expect(tile('문제 감지').props.accessibilityHint).toBe(KIND_HINT.incident_opened)
    expect(screen.getByRole('button', { name: '설명 보기' }).props.accessibilityState.expanded).toBe(false)
  })

  test('설명 보기 를 누르면 7줄 설명이 모두 보이고 버튼 글이 설명 닫기 로 바뀌며 expanded 가 true', async () => {
    await draw()
    await fireEvent.press(screen.getByRole('button', { name: '설명 보기' }))
    for (const kind of NOTIFICATION_KINDS) {
      expect(screen.getByText(`${NOTIFICATION_KIND_LABEL[kind]} — ${KIND_HINT[kind]}`)).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: '설명 보기' })).toBeNull()
    expect(screen.getByRole('button', { name: '설명 닫기' }).props.accessibilityState.expanded).toBe(true)
  })

  test('다시 누르면 접힌다', async () => {
    await draw()
    await fireEvent.press(screen.getByRole('button', { name: '설명 보기' }))
    await fireEvent.press(screen.getByRole('button', { name: '설명 닫기' }))
    expect(screen.queryByText(new RegExp(KIND_HINT.incident_opened))).toBeNull()
    expect(screen.getByRole('button', { name: '설명 보기' })).toBeTruthy()
  })

  test('설명 토글 버튼은 44pt 이상이다', async () => {
    await draw()
    expect(StyleSheet.flatten(screen.getByRole('button', { name: '설명 보기' }).props.style).minHeight).toBeGreaterThanOrEqual(44)
  })

  test('끈 종류는 앱 안 알림 목록에도 남지 않습니다 글이 접힘/펼침 모두에서 보인다', async () => {
    await draw()
    expect(screen.getByText(FOOT)).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: '설명 보기' }))
    expect(screen.getByText(FOOT)).toBeTruthy()
  })
})
