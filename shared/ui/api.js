import { getAccessToken, getSessionStatus, refreshSession } from './session.js'

export const NETWORK_ERROR_TEXT = '서버에 연결할 수 없습니다. 서버가 켜져 있는지 확인해 주세요'

// 401 이어도 갱신·재시도하지 않는 경로 - 로그인·갱신·로그아웃 자체와 공개 설정 (무한 반복 방지)
export const AUTH_NO_RETRY_PATHS = ['/api/auth/google', '/api/auth/refresh', '/api/auth/logout', '/api/auth/config']

// 쿼리를 뗀 경로가 갱신 제외 목록에 있는지
function isNoRetryPath(path) {
  const bare = String(path).split(/[?#]/)[0]
  return AUTH_NO_RETRY_PATHS.includes(bare)
}

// 한 번 보낸다 - 토큰이 있으면 Authorization 을 붙이고, 연결 자체가 안 되면 한국어 안내와 status 0
async function send(path, options, token) {
  const { headers, body, auth, ...rest } = options
  const merged = { 'Content-Type': 'application/json' }
  if (token) merged.Authorization = `Bearer ${token}`
  Object.assign(merged, headers)
  try {
    return await fetch(path, {
      ...rest,
      headers: merged,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    const failure = new Error(NETWORK_ERROR_TEXT)
    failure.status = 0
    throw failure
  }
}

// 응답을 읽는다 - 에러는 FastAPI의 detail(한국어)을 그대로 던진다
async function read(response) {
  if (response.status === 204) return null

  const data = await response.json().catch(() => null)

  if (!response.ok) {
    const detail = data?.detail
    const message = Array.isArray(detail) ? detail.map((d) => d.msg).join(', ') : detail
    const error = new Error(message || `요청 실패 (${response.status})`)
    // 화면이 404 같은 상태를 구분할 수 있게 HTTP 상태를 같이 둔다
    error.status = response.status
    throw error
  }

  return data
}

// 공용 fetch 래퍼 - 401 이면 세션을 한 번 갱신하고 한 번만 다시 보낸다. 옵션 auth:false 면 토큰·재시도 없음
export async function request(path, options = {}) {
  const useAuth = options.auth !== false
  const sentToken = useAuth ? getAccessToken() : null
  const response = await send(path, options, sentToken)

  if (response.status !== 401 || !useAuth || isNoRetryPath(path)) return read(response)

  // 원래 401 오류 - 갱신이 안 되면 이것을 던진다
  const original = await read(response).then(() => null, (e) => e)
  // 토큰 없이 나갔고 이미 로그아웃 상태면 갱신하지 않는다 (첫 확인 중인 unknown 은 쿠키로 갱신해 본다)
  if (!sentToken && getSessionStatus() === 'signed_out') throw original
  // 이 요청이 나간 뒤 다른 요청이 이미 갱신했으면 다시 갱신하지 않고 새 토큰으로 보낸다
  const current = getAccessToken()
  const refreshed = current && current !== sentToken ? true : await refreshSession()
  if (!refreshed) throw original
  return read(await send(path, options, getAccessToken()))
}
