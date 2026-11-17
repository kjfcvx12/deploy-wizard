import AsyncStorage from '@react-native-async-storage/async-storage'
import { PICKED_BLOCK_KEY } from '../accounts/pickedBlock'

// 사용자가 바뀌면 남으면 안 되는 이 기기의 저장값 - 알림 안내 카드 닫음(dw-push-card-dismissed)은 기기 단위라 남긴다
const USER_SCOPED_KEYS = [PICKED_BLOCK_KEY]

// 로그아웃·계정 삭제 뒤 사용자별 저장값을 지운다 - 하나가 막혀도 나머지는 지우고, 던지지 않는다
export async function clearUserScopedData() {
  for (const key of USER_SCOPED_KEYS) {
    try {
      await AsyncStorage.removeItem(key)
    } catch {
      // 저장소가 막힌 기기 - 지울 수 없으면 둔다
    }
  }
}
