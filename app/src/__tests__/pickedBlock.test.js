import AsyncStorage from '@react-native-async-storage/async-storage'
import { readPickedBlock, writePickedBlock } from '../accounts/pickedBlock'

beforeEach(async () => {
  jest.restoreAllMocks()
  await AsyncStorage.clear()
})

describe('고른 연결 블록 저장', () => {
  test('쓰고 읽으면 같은 숫자', async () => {
    await writePickedBlock(7)
    await expect(readPickedBlock()).resolves.toBe(7)
    await expect(AsyncStorage.getItem('dw-picked-block')).resolves.toBe('7')
  })

  test('저장된 게 없으면 null', async () => {
    await expect(readPickedBlock()).resolves.toBeNull()
  })

  test.each(['abc', '', '0', 'NaN', '-', '-5', '1.5', 'Infinity', '{"a":1}'])('엉뚱한 값 %j 는 null', async (garbage) => {
    await AsyncStorage.setItem('dw-picked-block', garbage)
    await expect(readPickedBlock()).resolves.toBeNull()
  })

  test('읽기가 실패해도 던지지 않고 null', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValue(new Error('storage down'))
    await expect(readPickedBlock()).resolves.toBeNull()
  })

  test('쓰기가 실패해도 던지지 않는다', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('storage full'))
    await expect(writePickedBlock(7)).resolves.toBeUndefined()
  })
})
