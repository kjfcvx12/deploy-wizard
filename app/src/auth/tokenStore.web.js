// 웹 번들: 리프레시 토큰은 서버가 굽는 httpOnly 쿠키라 JS 가 저장하지 않는다 (expo-secure-store 는 웹을 지원하지 않는다)
export const REFRESH_KEY = 'dw-refresh'

// 웹은 저장된 원문이 없다
export async function readRefreshToken() {
  return null
}

// 웹은 저장하지 않는다
export async function writeRefreshToken() {
  return false
}

// 웹은 지울 것이 없다 (쿠키는 서버의 로그아웃이 지운다)
export async function clearRefreshToken() {}
