import { Platform } from 'react-native'
import { getAccessToken, getSessionStatus, refreshSession } from './auth/session'

// 서버 호출 - 웹의 shared/ui/api.js · features/*/ui/api.js 와 같은 의미 (앱은 app/ 밖을 가져오지 않는다)
// 기본 주소는 EXPO_PUBLIC_API_BASE_URL (빌드 때 코드에 박힌다), 없으면 로컬 서버
export const BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8081'
const TIMEOUT_MS = 15000
const NETWORK_ERROR = '서버에 연결할 수 없습니다'

// 401 이어도 갱신·재시도하지 않는 경로 - 로그인·갱신·로그아웃 자체와 공개 설정 (무한 반복 방지)
export const AUTH_NO_RETRY_PATHS = ['/api/auth/google', '/api/auth/refresh', '/api/auth/logout', '/api/auth/config']

// 같은 알림을 다시 보내기까지 기다리는 시간(ms) - 주기적으로 부르는 화면이 설정 요청을 쏟아내지 않게
export const UNAUTHORIZED_THROTTLE_MS = 5000

const unauthorizedHandlers = new Set()
let unauthorizedLastAt = -Infinity
let unauthorizedBusy = false

// 로그인한 적 없는 상태에서 401 을 받았을 때(서버가 로그인 필수로 바뀐 듯) 알려 달라고 등록한다 - 해제 함수를 돌려준다
export function onUnauthorized(fn) {
  unauthorizedHandlers.add(fn)
  return () => { unauthorizedHandlers.delete(fn) }
}

// 등록된 핸들러를 부른다 - 5초에 한 번, 이전 호출이 끝나기 전에는 다시 부르지 않는다
function notifyUnauthorized() {
  if (unauthorizedBusy || unauthorizedHandlers.size === 0) return
  const now = Date.now()
  if (now - unauthorizedLastAt < UNAUTHORIZED_THROTTLE_MS) return
  unauthorizedLastAt = now
  unauthorizedBusy = true
  const runs = [...unauthorizedHandlers].map((fn) => Promise.resolve().then(fn))
  Promise.allSettled(runs).then(() => { unauthorizedBusy = false })
}

// 테스트용: 알림 상태를 처음으로 되돌린다
export function resetUnauthorizedForTest() {
  unauthorizedHandlers.clear()
  unauthorizedLastAt = -Infinity
  unauthorizedBusy = false
}

// 쿼리를 뗀 경로
const barePath = (path) => String(path).split(/[?#]/)[0]

// 쿼리를 뗀 경로가 갱신 제외 목록에 있는지
const isNoRetryPath = (path) => AUTH_NO_RETRY_PATHS.includes(barePath(path))

// 웹 번들의 로그인 호출은 httpOnly 리프레시 쿠키를 주고받아야 한다 - 다른 경로에는 쿠키를 싣지 않는다
const needsCookie = (path) => Platform.OS === 'web' && barePath(path).startsWith('/api/auth/')

// 공용 fetch 래퍼 - 401 이면 세션을 한 번 갱신하고 한 번만 다시 보낸다. 옵션 auth:false 면 토큰·재시도 없음
export async function request(path, options = {}) {
  const useAuth = options.auth !== false
  const sentToken = useAuth ? getAccessToken() : null
  try {
    return await send(path, options, sentToken)
  } catch (original) {
    if (original?.status !== 401 || !useAuth || isNoRetryPath(path)) throw original
    // 토큰 없이 나갔고 이미 로그아웃 상태면 갱신하지 않는다 (첫 확인 중인 unknown 은 저장된 리프레시로 갱신해 본다)
    if (!sentToken && getSessionStatus() === 'signed_out') {
      // 서버가 도중에 로그인 필수로 바뀌었을 수 있다 - 화면이 설정을 다시 읽게 알린다
      notifyUnauthorized()
      throw original
    }
    // 이 요청이 나간 뒤 다른 요청이 이미 갱신했으면 다시 갱신하지 않고 새 토큰으로 보낸다. 갱신이 연결 실패로 던지면 그 오류가 나간다(로그아웃 아님)
    const current = getAccessToken()
    const refreshed = current && current !== sentToken ? true : await refreshSession()
    if (!refreshed) throw original
    return send(path, options, getAccessToken())
  }
}

// 한 번 보내고 읽는다 - 토큰이 있으면 Authorization, 에러는 FastAPI의 detail(한국어)을 그대로 던진다
async function send(path, options, token) {
  const { headers, body, auth, ...rest } = options
  const merged = { 'Content-Type': 'application/json' }
  if (token) merged.Authorization = `Bearer ${token}`
  Object.assign(merged, headers || {})
  const init = { ...rest, headers: merged, body: body ? JSON.stringify(body) : undefined }
  if (needsCookie(path)) init.credentials = 'include'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    let response
    try {
      response = await fetch(`${BASE_URL}${path}`, { ...init, signal: controller.signal })
    } catch (e) {
      throw new Error(NETWORK_ERROR)
    }

    if (response.status === 204) return null

    let data = null
    try {
      data = await response.json()
    } catch (e) {
      // 성공(2xx)인데 본문이 잘렸거나 JSON 이 아니면, 또는 읽는 중 시간이 다 되면 성공으로 넘기지 않는다 (204 는 위에서 null)
      if (response.ok || controller.signal.aborted) throw new Error(NETWORK_ERROR)
      data = null
    }

    if (!response.ok) {
      const detail = data?.detail
      const message = Array.isArray(detail) ? detail.map((d) => d.msg).join(', ') : detail
      // 화면이 404 같은 상태를 가려낼 수 있게 상태코드를 붙인다 (메시지는 그대로)
      throw Object.assign(new Error(message || `요청 실패 (${response.status})`), { status: response.status })
    }

    return data
  } finally {
    clearTimeout(timer)
  }
}

// features/deploys/router.py 와 1:1
export const deployApi = {
  getAll: () => request('/api/deploys'),
  getOne: (d_id) => request(`/api/deploys/${d_id}`),
  getLogs: (d_id, after = 0) => request(`/api/deploys/${d_id}/logs?after=${after}`),
  getIssues: (d_id) => request(`/api/deploys/${d_id}/issues`),
  getHealth: (d_id) => request(`/api/deploys/${d_id}/health`),
  getRemote: (repo_url, github_installation_id) => request(
    `/api/deploys/remote?repo_url=${encodeURIComponent(repo_url)}` +
    (github_installation_id ? `&github_installation_id=${github_installation_id}` : '')),
  create: (repo_url, branch, aws_account_id, github_installation_id) => request('/api/deploys', {
    method: 'POST',
    body: { repo_url, branch: branch || null, aws_account_id: aws_account_id || null, github_installation_id: github_installation_id || null },
  }),
  redeploy: (d_id) => request(`/api/deploys/${d_id}/redeploy`, { method: 'POST' }),
  stop: (d_id) => request(`/api/deploys/${d_id}/stop`, { method: 'POST' }),
  start: (d_id) => request(`/api/deploys/${d_id}/start`, { method: 'POST' }),
  remove: (d_id) => request(`/api/deploys/${d_id}`, { method: 'DELETE' }),
  // 보낸 항목만 바뀐다 ({ auto_redeploy, auto_recover })
  patchSettings: (d_id, body) => request(`/api/deploys/${d_id}/settings`, { method: 'PATCH', body }),
}

// 쿼리 문자열을 만든다 - 값이 없는(null, undefined, 빈 글자) 항목은 뺀다 (RN 의 URLSearchParams 는 믿을 수 없어 직접 만든다)
const queryString = (params) => {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

// features/incidents/router.py 와 1:1 (읽기 전용 - 인시던트는 서버가 만들고 닫는다)
export const incidentApi = {
  getAll: ({ status, d_id, after } = {}) => request(`/api/incidents${queryString({ status, d_id, after })}`),
  getOne: (i_id) => request(`/api/incidents/${i_id}`),
  getForDeploy: (d_id, after) => request(`/api/deploys/${d_id}/incidents${queryString({ after })}`),
}

// 헬스체크 이력 (features/deploys/router.py) - hours 는 1~168
export const healthApi = {
  getHistory: (d_id, hours = 24) => request(`/api/deploys/${d_id}/health-history?hours=${hours}`),
}

// features/notifications/router.py 와 1:1
export const notificationApi = {
  getAll: ({ after, unread } = {}) => request(`/api/notifications${queryString({ after, unread: unread ? 'true' : null })}`),
  getUnreadCount: () => request('/api/notifications/unread-count'),
  read: (n_id) => request(`/api/notifications/${n_id}/read`, { method: 'POST' }),
  readAll: () => request('/api/notifications/read-all', { method: 'POST' }),
  getSettings: () => request('/api/notifications/settings'),
  patchSettings: (body) => request('/api/notifications/settings', { method: 'PATCH', body }),
}

// features/notifications/router.py 의 기기 등록 - 푸시 토큰은 여기로만 보낸다 (화면·로그에 내지 않는다)
export const deviceApi = {
  register: ({ expo_token, platform }) => request('/api/devices', { method: 'POST', body: { expo_token, platform } }),
  remove: (p_d_id) => request(`/api/devices/${p_d_id}`, { method: 'DELETE' }),
}

// features/envvars/router.py 와 1:1 (값은 쓰기 전용 - 응답에 나오지 않는다)
export const envApi = {
  getAll: (d_id) => request(`/api/deploys/${d_id}/env`),
  put: (d_id, name, body) => request(`/api/deploys/${d_id}/env/${encodeURIComponent(name)}`, { method: 'PUT', body }),
  clearValue: (d_id, name) => request(`/api/deploys/${d_id}/env/${encodeURIComponent(name)}/value`, { method: 'DELETE' }),
  continueDeploy: (d_id) => request(`/api/deploys/${d_id}/env/continue`, { method: 'POST' }),
}

// features/advice/router.py 와 1:1 (배포 기록을 만들지 않는 읽기 전용 분석)
export const adviceApi = {
  analyze: ({ repo_url, branch, aws_account_id, github_installation_id }) => request('/api/deploys/advice', {
    method: 'POST',
    body: { repo_url, branch: branch || null, aws_account_id: aws_account_id || null, github_installation_id: github_installation_id || null },
  }),
}

// features/accounts/router.py 와 1:1 (웹 features/accounts/ui/api.js 와 같은 주소·본문)
export const accountApi = {
  // 연결 블록 - AWS 계정 하나 + GitHub 설치 하나
  getConnections: () => request('/api/accounts/connections'),
  createConnection: (label) => request('/api/accounts/connections', { method: 'POST', body: { label } }),
  createConnectionAws: (c_id) => request(`/api/accounts/connections/${c_id}/aws`, { method: 'POST' }),
  setConnectionAws: (c_id, aws_account_id) => request(`/api/accounts/connections/${c_id}`, { method: 'PATCH', body: { aws_account_id } }),
  setConnectionGithub: (c_id, github_installation_id) => request(`/api/accounts/connections/${c_id}`, { method: 'PATCH', body: { github_installation_id } }),
  deleteConnection: (c_id) => request(`/api/accounts/connections/${c_id}`, { method: 'DELETE' }),

  listAws: () => request('/api/accounts/aws'),
  createAws: (label, region) => request('/api/accounts/aws', { method: 'POST', body: { label, region: region || null } }),
  attachRole: (a_id, role_arn) => request(`/api/accounts/aws/${a_id}/role-arn`, { method: 'PATCH', body: { role_arn } }),
  reverifyAws: (a_id) => request(`/api/accounts/aws/${a_id}/reverify`, { method: 'POST' }),
  getTemplateStatus: (a_id) => request(`/api/accounts/aws/${a_id}/template-status`),
  deleteTemplateFiles: (a_id) => request(`/api/accounts/aws/${a_id}/template-files`, { method: 'DELETE' }),
  deleteAws: (a_id) => request(`/api/accounts/aws/${a_id}`, { method: 'DELETE' }),

  listGithub: () => request('/api/accounts/github'),
  getGithubInstallUrl: (c_id) => request('/api/accounts/github/install-url' + (c_id ? `?c_id=${c_id}` : '')),
  getGithubRepositories: (g_id) => request(`/api/accounts/github/${g_id}/repositories`),
  checkGithub: (g_id) => request(`/api/accounts/github/${g_id}/check`),
  deleteGithub: (g_id) => request(`/api/accounts/github/${g_id}`, { method: 'DELETE' }),
}

// 갱신·로그아웃 본문 - 네이티브는 보안 저장소의 원문을 본문으로, 웹 번들은 쿠키라 본문이 없다
const refreshBody = (refresh_token) => (Platform.OS !== 'web' && refresh_token ? { refresh_token } : undefined)

// features/auth/router.py 와 1:1 - 설정·로그인·갱신·로그아웃은 공개라 토큰을 붙이지 않고 401 재시도도 하지 않는다. 앱은 개인 토큰 화면을 두지 않는다
export const authApi = {
  getConfig: () => request('/api/auth/config', { auth: false }),
  loginGoogle: (id_token, platform) => request('/api/auth/google', { method: 'POST', body: { id_token, platform }, auth: false }),
  refresh: (refresh_token) => request('/api/auth/refresh', { method: 'POST', body: refreshBody(refresh_token), auth: false }),
  logout: (refresh_token) => request('/api/auth/logout', { method: 'POST', body: refreshBody(refresh_token), auth: false }),

  getMe: () => request('/api/me'),
  deleteMe: () => request('/api/me', { method: 'DELETE', body: { confirm: true } }),
}
