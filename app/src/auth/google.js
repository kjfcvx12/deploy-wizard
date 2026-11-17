import {
  Google_Sign_In_Error, DEV_BUILD_TEXT, NO_PLAY_SERVICES_TEXT, GENERIC_SIGN_IN_TEXT, NOT_CONFIGURED_TEXT,
} from './googleError'

export { Google_Sign_In_Error }

// 네이티브 라이브러리를 처음 쓸 때 한 번만 가져온다 - Expo Go 처럼 네이티브 모듈이 없으면 가져오는 순간 던지므로 개발 빌드 안내로 바꾼다
let nativeLib = null
function loadNative() {
  if (nativeLib) return nativeLib
  try {
    nativeLib = require('@react-native-google-signin/google-signin')
  } catch {
    throw new Google_Sign_In_Error(DEV_BUILD_TEXT)
  }
  return nativeLib
}

// 라이브러리 오류가 취소(code SIGN_IN_CANCELLED)인지
function isCancelError(error, statusCodes) {
  return error != null && typeof error === 'object' && error.code === statusCodes.SIGN_IN_CANCELLED
}

// 라이브러리 오류가 Play 서비스 없음인지
function isNoPlayServicesError(error, statusCodes) {
  return error != null && typeof error === 'object' && error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE
}

// signIn 결과 모양(17.0.0: { type:'success', data:{ idToken } } | { type:'cancelled' })은 여기서만 푼다 - 'cancelled' | idToken 문자열 | null
function pickResult(result) {
  if (result?.type === 'cancelled') return 'cancelled'
  if (result?.type === 'success' && typeof result.data?.idToken === 'string' && result.data.idToken) return result.data.idToken
  return null
}

// 기기의 Google 계정 선택 창으로 로그인해 id_token 을 돌려준다 - 취소는 { cancelled:true }, 오류는 한국어 Google_Sign_In_Error
export async function googleSignIn({ webClientId } = {}) {
  if (typeof webClientId !== 'string' || !webClientId) throw new Google_Sign_In_Error(NOT_CONFIGURED_TEXT)
  const { GoogleSignin, statusCodes } = loadNative()
  try {
    // 서버는 안드로이드 로그인의 aud 로 웹 클라이언트 ID 를 받는다 (백엔드 Ruling 13) - 다른 ID 는 넘기지 않는다
    GoogleSignin.configure({ webClientId })
    const hasPlay = await GoogleSignin.hasPlayServices()
    if (hasPlay === false) throw new Google_Sign_In_Error(NO_PLAY_SERVICES_TEXT)
    const picked = pickResult(await GoogleSignin.signIn())
    if (picked === 'cancelled') return { cancelled: true }
    if (!picked) throw new Google_Sign_In_Error(GENERIC_SIGN_IN_TEXT)
    return { idToken: picked }
  } catch (error) {
    if (error instanceof Google_Sign_In_Error) throw error
    if (isCancelError(error, statusCodes)) return { cancelled: true }
    if (isNoPlayServicesError(error, statusCodes)) throw new Google_Sign_In_Error(NO_PLAY_SERVICES_TEXT)
    throw new Google_Sign_In_Error(GENERIC_SIGN_IN_TEXT)
  }
}

// 로그아웃 때 호출 - 다음 로그인에 계정 선택 창이 다시 뜨게 한다. 실패해도 던지지 않는다
export async function googleSignOut() {
  try {
    await loadNative().GoogleSignin.signOut()
  } catch {
    // 로그아웃은 실패해도 앱 로그아웃을 막지 않는다
  }
}
