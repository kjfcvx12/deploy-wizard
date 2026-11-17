import AsyncStorage from '@react-native-async-storage/async-storage'
import { clearUserScopedData } from '../auth/userData'
import { PICKED_BLOCK_KEY } from '../accounts/pickedBlock'

beforeEach(async () => {
  await AsyncStorage.clear()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('clearUserScopedData', () => {
  test('고른 블록은 지우고 기기 단위 값(안내 카드 닫음)은 남긴다', async () => {
    expect(PICKED_BLOCK_KEY).toBe('dw-picked-block')
    await AsyncStorage.setItem('dw-picked-block', '3')
    await AsyncStorage.setItem('dw-push-card-dismissed', '1')
    await expect(clearUserScopedData()).resolves.toBeUndefined()
    expect(await AsyncStorage.getItem('dw-picked-block')).toBeNull()
    expect(await AsyncStorage.getItem('dw-push-card-dismissed')).toBe('1')
  })

  test('저장소가 막혀도 던지지 않는다', async () => {
    AsyncStorage.removeItem.mockRejectedValueOnce(new Error('blocked'))
    await expect(clearUserScopedData()).resolves.toBeUndefined()
  })
})
