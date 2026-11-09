import AsyncStorage from '@react-native-async-storage/async-storage'

// 고른 연결 블록 - 계정 연결 화면에서 [선택]한 블록을 새 배포 화면이 미리 골라 둔다 (이 기기에만 기억, c_id 숫자만 저장)
const PICKED_BLOCK_KEY = 'dw-picked-block'

// 저장된 블록 번호 읽기 - 없거나 이상한 값이거나 저장소가 막혔으면 null
export const readPickedBlock = async () => {
  try {
    const id = Number(await AsyncStorage.getItem(PICKED_BLOCK_KEY))
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

// 블록 번호 저장 - 저장이 막혀도 던지지 않는다 (이번 화면에서만 기억)
export const writePickedBlock = async (c_id) => {
  try {
    await AsyncStorage.setItem(PICKED_BLOCK_KEY, String(c_id))
  } catch {
    // 저장이 막힌 기기 - 이번 화면에서만 기억한다
  }
}

// 저장된 블록 번호 지우기 - 지운 블록의 번호가 다른 새 블록에 다시 쓰이는 것을 막는다. 막혀도 던지지 않는다
export const clearPickedBlock = async () => {
  try {
    await AsyncStorage.removeItem(PICKED_BLOCK_KEY)
  } catch {
    // 저장이 막힌 기기 - 지울 것도 없다
  }
}
