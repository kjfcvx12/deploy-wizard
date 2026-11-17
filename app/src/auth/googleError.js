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
export const DEVELOPER_ERROR_TEXT = 'Google 로그인 설정이 맞지 않습니다 (앱 서명 SHA-1·OAuth 클라이언트 확인)'
// 안드로이드 DEVELOPER_ERROR 의 오류 코드 - 17.0.0 의 네이티브 모듈이 문자열 '10' 으로 거절한다 (statusCodes 에는 없다)
export const DEVELOPER_ERROR_CODE = '10'
