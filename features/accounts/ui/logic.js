import { GITHUB_CALLBACK_OK, GITHUB_CALLBACK_ERROR_TEXT } from './constants.js'

// 설치 콜백이 돌려보낸 주소(?connected=…)를 읽는다 - connected: 연결 성공, error: 보일 안내 글(없으면 null), known: 우리가 아는 값인가 (주소를 정리할지 정한다)
export function githubCallbackResult(search) {
  const value = new URLSearchParams(search || '').get('connected')
  const connected = value === GITHUB_CALLBACK_OK
  const error = Object.hasOwn(GITHUB_CALLBACK_ERROR_TEXT, value) ? GITHUB_CALLBACK_ERROR_TEXT[value] : null
  return { connected, error, known: connected || error !== null }
}
