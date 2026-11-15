export const NETWORK_ERROR_TEXT = '서버에 연결할 수 없습니다. 서버가 켜져 있는지 확인해 주세요'

// 공용 fetch 래퍼 - 에러는 FastAPI의 detail(한국어)을 그대로 던진다. 연결 자체가 안 되면 한국어 안내와 status 0
export async function request(path, options = {}) {
  let response
  try {
    response = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
  } catch (e) {
    const failure = new Error(NETWORK_ERROR_TEXT)
    failure.status = 0
    throw failure
  }

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
