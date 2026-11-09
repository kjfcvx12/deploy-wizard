import { Text } from 'react-native'
import { render, screen, fireEvent } from '@testing-library/react-native'
import BlockCard from '../components/accounts/BlockCard'

const block = { c_id: 3, label: '운영 계정', aws: null, github: null }

describe('BlockCard', () => {
  test('이름과 선택, 블록 삭제 버튼을 보여 준다', async () => {
    await render(<BlockCard block={block} picked={false} busy={false} onPick={jest.fn()} onDelete={jest.fn()} />)
    expect(screen.getByText('운영 계정')).toBeTruthy()
    expect(screen.getByText('선택')).toBeTruthy()
    expect(screen.getByText('블록 삭제')).toBeTruthy()
  })

  test('선택과 블록 삭제를 누르면 그 블록으로 부른다', async () => {
    const onPick = jest.fn()
    const onDelete = jest.fn()
    await render(<BlockCard block={block} picked={false} busy={false} onPick={onPick} onDelete={onDelete} />)
    await fireEvent.press(screen.getByText('선택'))
    await fireEvent.press(screen.getByText('블록 삭제'))
    expect(onPick).toHaveBeenCalledWith(block)
    expect(onDelete).toHaveBeenCalledWith(block)
  })

  test('고른 블록은 선택됨으로 보이고 누를 수 없다', async () => {
    const onPick = jest.fn()
    await render(<BlockCard block={block} picked busy={false} onPick={onPick} onDelete={jest.fn()} />)
    expect(screen.queryByText('선택')).toBeNull()
    await fireEvent.press(screen.getByText('선택됨'))
    expect(onPick).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '운영 계정 선택됨' })).toBeDisabled()
  })

  test('두 버튼의 접근성 이름에 블록 이름이 들어간다', async () => {
    await render(<BlockCard block={block} picked={false} busy={false} onPick={jest.fn()} onDelete={jest.fn()} />)
    expect(screen.getByRole('button', { name: '운영 계정 선택' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '운영 계정 블록 삭제' })).toBeEnabled()
  })

  test('작업 중이면 두 버튼이 모두 잠긴다', async () => {
    const onPick = jest.fn()
    const onDelete = jest.fn()
    await render(<BlockCard block={block} picked={false} busy onPick={onPick} onDelete={onDelete} />)
    await fireEvent.press(screen.getByText('선택'))
    await fireEvent.press(screen.getByText('블록 삭제'))
    expect(onPick).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
  })

  test('children 은 카드 안에 그려진다', async () => {
    await render(
      <BlockCard block={block} picked={false} busy={false} onPick={jest.fn()} onDelete={jest.fn()}>
        <Text>상자 자리</Text>
      </BlockCard>,
    )
    expect(screen.getByText('상자 자리')).toBeTruthy()
  })
})
