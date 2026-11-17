import * as SecureStore from 'expo-secure-store'

// 리프레시 토큰 원문을 두는 보안 저장소 키 - 원문은 여기에만 두고 AsyncStorage·화면·로그에는 넣지 않는다
export const REFRESH_KEY = 'dw-refresh'

// 저장된 리프레시 토큰 (없거나 읽지 못하면 null) - 던지지 않는다
export async function readRefreshToken() {
  try {
    const raw = await SecureStore.getItemAsync(REFRESH_KEY)
    return typeof raw === 'string' && raw ? raw : null
  } catch {
    return null
  }
}

// 리프레시 토큰을 저장한다 - 성공하면 true, 실패하면 false (던지지 않는다)
export async function writeRefreshToken(raw) {
  if (typeof raw !== 'string' || !raw) return false
  try {
    await SecureStore.setItemAsync(REFRESH_KEY, raw)
    return true
  } catch {
    return false
  }
}

// 저장된 리프레시 토큰을 지운다 - 실패해도 던지지 않는다
export async function clearRefreshToken() {
  try {
    await SecureStore.deleteItemAsync(REFRESH_KEY)
  } catch {
    // 지우지 못해도 세션은 이미 메모리에서 지웠다
  }
}
