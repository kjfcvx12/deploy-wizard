// 공용 fetch 래퍼 - 에러는 FastAPI의 detail(한국어)을 그대로 던진다
export async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

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
