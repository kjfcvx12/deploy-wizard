import { PICKED_BLOCK_KEY } from '@features/accounts/ui/pickedBlock.js'

// 이 브라우저가 로그인한 적 있다는 표시 - 값은 '1' 뿐이고 비밀이 아니다 (시작할 때 갱신을 시도할지 정하는 힌트)
export const HAD_SESSION_KEY = 'dw-had-session'

// 사용자마다 달라지는 브라우저 저장값 - 로그아웃·계정 삭제 때 지운다
const USER_SCOPED_KEYS = [PICKED_BLOCK_KEY, HAD_SESSION_KEY]

// localStorage 를 꺼낸다 - 막힌 브라우저면 null
const defaultStorage = () => {
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

// 사용자별 저장값을 지운다 - 저장소가 없거나 막혀도 던지지 않는다
export function clearUserScopedStorage(storage) {
  const target = storage === undefined ? defaultStorage() : storage
  if (!target || typeof target.removeItem !== 'function') return
  for (const key of USER_SCOPED_KEYS) {
    try {
      target.removeItem(key)
    } catch {
      // 저장이 막힌 브라우저 - 지울 것이 없다
    }
  }
}

// 로그인한 적이 있다고 표시했는지
export function hadSessionHint() {
  try {
    return window.localStorage.getItem(HAD_SESSION_KEY) === '1'
  } catch {
    return false
  }
}

// 로그인했다고 표시한다
export function rememberSessionHint() {
  try {
    window.localStorage.setItem(HAD_SESSION_KEY, '1')
  } catch {
    // 저장이 막힌 브라우저 - 새로고침하면 로그인 화면으로 갈 수 있다
  }
}
