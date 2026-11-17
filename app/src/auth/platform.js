import { Platform } from 'react-native'

// 앱의 Platform.OS -> 서버 LOGIN_PLATFORMS 이름. 여기 없는 것은 로그인을 지원하지 않는다
const LOGIN_PLATFORM_BY_OS = {
  web: 'web',
  android: 'android',
  // iOS 추가 시: ios: 'ios' 한 줄 (서버 LOGIN_PLATFORMS 와 같이)
}

// 이 기기의 로그인 플랫폼 이름 - 지원하지 않으면 null
export function loginPlatform(os = Platform.OS) {
  return Object.prototype.hasOwnProperty.call(LOGIN_PLATFORM_BY_OS, os) ? LOGIN_PLATFORM_BY_OS[os] : null
}
