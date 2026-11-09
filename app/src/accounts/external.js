import { Linking } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { BASE_URL } from '../api'
import { isHttps } from './constants'

// 끝의 / 를 뗀 API 주소
const apiBase = () => String(BASE_URL || '').replace(/\/+$/, '')

// API 가 알려 준 상대 주소(/api/...)를 API 주소에 붙인다 (//호스트 같은 프로토콜 상대 주소는 붙이지 않는다)
export const resolveApiUrl = (url) => (typeof url === 'string' && /^\/(?!\/)/.test(url) ? `${apiBase()}${url}` : url)

// 열어도 되는 주소인가 - https:// 만. API 가 직접 내려주는 파일(api)은 API 주소 아래에 있으면 http 여도 된다
export const isOpenable = (url, { api = false } = {}) => (
  isHttps(url) || (api && typeof url === 'string' && !!apiBase() && url.startsWith(`${apiBase()}/`))
)

// 바깥 주소를 브라우저로 연다 - 열 수 없는 주소이거나 열기에 실패하면 false
export async function openLink(url, { api = false } = {}) {
  const target = api ? resolveApiUrl(url) : url
  if (!isOpenable(target, { api })) return false
  try {
    await Linking.openURL(target)
    return true
  } catch (e) {
    return false
  }
}

// 클립보드에 복사한다 - false 로 끝나거나 실패하면 false (값은 오류 글에 싣지 않는다)
export async function copyText(value) {
  try {
    return (await Clipboard.setStringAsync(value)) !== false
  } catch (e) {
    return false
  }
}
