// Google 로그인 오류 - 문장은 우리가 정한 한국어뿐이다 (라이브러리 원문·토큰은 싣지 않는다)
export class Google_Sign_In_Error extends Error {
  constructor(message) {
    super(message)
    this.name = 'Google_Sign_In_Error'
  }
}

export const DEV_BUILD_TEXT = '개발 빌드에서만 Google 로그인을 할 수 있습니다 (Expo Go 는 지원하지 않습니다)'
export const NO_PLAY_SERVICES_TEXT = '이 기기에서 Google Play 서비스를 쓸 수 없습니다'
export const GENERIC_SIGN_IN_TEXT = 'Google 로그인을 하지 못했습니다. 잠시 뒤 다시 시도해 주세요'
export const NOT_CONFIGURED_TEXT = 'Google 로그인이 아직 설정되지 않았습니다 (서버의 GOOGLE_CLIENT_ID_WEB)'
