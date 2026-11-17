import { NETWORK_ERROR_TEXT } from '@shared/ui/api.js'
import { toMs } from '@shared/ui/time.js'

const DEFAULT_PAT_DAYS = 30
const DEFAULT_PAT_MAX_DAYS = 90
const LOGIN_FAILED_TEXT = '로그인하지 못했습니다. 잠시 뒤 다시 시도해 주세요'

// 옛 서버(/api/auth/config 가 404)나 로그인을 끈 서버로 보는 설정
export const CONFIG_OFF = Object.freeze({
  auth_required: false,
  login_available: false,
  platforms: Object.freeze([]),
  google_client_id_web: null,
  pat_default_days: DEFAULT_PAT_DAYS,
  pat_max_days: DEFAULT_PAT_MAX_DAYS,
})

// 양의 정수만 받고 아니면 기본값
const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback)

// 서버 설정 응답을 안전하게 다듬는다 - 모르는 키는 버리고 타입이 틀리면 끔 쪽 기본값
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const clientId = typeof source.google_client_id_web === 'string' ? source.google_client_id_web.trim() : ''
  return {
    auth_required: source.auth_required === true,
    login_available: source.login_available === true,
    platforms: Array.isArray(source.platforms) ? source.platforms.filter((p) => typeof p === 'string') : [],
    google_client_id_web: clientId || null,
    pat_default_days: positiveInt(source.pat_default_days, DEFAULT_PAT_DAYS),
    pat_max_days: positiveInt(source.pat_max_days, DEFAULT_PAT_MAX_DAYS),
  }
}

// 경로가 로그인 화면인지 (쿼리·해시 제외, 대소문자 무시)
const isLoginPath = (path) => {
  const bare = String(path ?? '').split(/[?#]/)[0].toLowerCase()
  return bare === '/login' || bare === '/login/'
}

// 이 경로를 지금 보여줄지 정한다 - loading | error | allow | login
export function routeDecision({ config, configError, status, path }) {
  if (isLoginPath(path)) return 'allow'
  if (configError) return 'error'
  if (!config || status === 'unknown') return 'loading'
  if (!config.auth_required) return 'allow'
  return status === 'signed_in' ? 'allow' : 'login'
}

// 로그인 뒤 돌아갈 곳 - 같은 사이트 안의 경로만, 아니면 '/' (열린 리다이렉트 방지)
export function safeNext(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '/'
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  // 역슬래시나 제어 문자(탭·줄바꿈)는 브라우저가 슬래시로 바꿔 읽을 수 있다
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return '/'
  if (isLoginPath(raw)) return '/'
  return raw
}

// 로그인 실패를 사용자 문구로 - 서버가 준 문구가 있으면 그대로, 연결 실패는 안내, 그 밖은 기본 문구
export function loginErrorText(error) {
  if (error?.status === 0) return NETWORK_ERROR_TEXT
  const message = typeof error?.message === 'string' ? error.message.trim() : ''
  const fromServer = typeof error?.status === 'number' && message && !/^요청 실패 \(\d+\)$/.test(message)
  return fromServer ? message : LOGIN_FAILED_TEXT
}

// 시작 확인의 순서를 정한다 (순수 - 호출은 모두 주입) - 설정 읽기 -> 필요하면 갱신 -> 첫 확인 끝내기. 연결 문제로 정하지 못하면 { error: true }
// 로그인이 필요한 서버에서는 연결 실패·5xx 를 로그아웃으로 보지 않고, 끈 서버에서는 세션이 필요 없어 어떤 갱신 실패든 로그아웃 상태로 끝낸다
export async function runBoot({ getConfig, refresh, getStatus, markBooted, hasHint, clearHint, live = () => true, onConfig = () => {} }) {
  let config
  let missing = false
  try {
    config = normalizeConfig(await getConfig())
  } catch (e) {
    if (e?.status !== 404) return { error: true }
    // 옛 서버 - 로그인 끔으로 보고 갱신도 시도하지 않는다
    config = CONFIG_OFF
    missing = true
  }
  if (!live()) return { error: false }
  onConfig(config)

  // 다른 탭의 로그인 등으로 이미 정해졌으면 더 하지 않는다
  if (getStatus() !== 'unknown') return { error: false }
  // 로그인이 필요 없고 로그인한 적도 없으면(또는 옛 서버면) 갱신하지 않는다
  if (missing || (!config.auth_required && !hasHint())) {
    markBooted('signed_out')
    return { error: false }
  }
  let refreshed
  try {
    refreshed = await refresh()
  } catch (e) {
    if (config.auth_required) return { error: true }
    if (!live()) return { error: false }
    // 끈 서버: 쿠키가 더는 쓸 수 없다는 확실한 답(401·403·404)이면 힌트도 지운다
    if ([401, 403, 404].includes(e?.status)) clearHint()
    markBooted('signed_out')
    return { error: false }
  }
  if (!live()) return { error: false }
  // 끈 서버: 갱신이 확실한 거절(401·403)을 삼키고 false 로 끝났으면 힌트도 지운다
  if (!config.auth_required && refreshed === false) clearHint()
  // 갱신이 성공했거나 서버가 쿠키를 거절한 확실한 결과일 때만 첫 확인을 끝낸다
  markBooted(getStatus())
  return { error: false }
}

// 설정 다시 읽기가 실패했을 때 오류 표시를 켤지 - 가장 새 읽기이고 아직 아는 설정이 없을 때만 (아니면 영영 불러오는 중에 머문다)
export const reloadFailureFlagsError = ({ config, latest }) => latest === true && !config

const DELETE_DONE_TEXT = '계정을 삭제했습니다'
const ME_PATH = '/me'

// 서버 409 문구("먼저 …: #3 my-app, #5 other")를 문구와 서비스 목록으로 나눈다 - 형식이 다르면 항목 없이 원문 그대로
export function parseLiveDeploys(detail) {
  if (typeof detail !== 'string') return { message: '', items: [] }
  const raw = { message: detail, items: [] }
  const at = detail.indexOf(': #')
  if (at < 0) return raw
  const items = []
  for (const piece of detail.slice(at + 2).split(', ')) {
    // 서비스 이름·레포 주소에는 공백과 쉼표가 없다
    const found = /^#(\d+) ([^\s,]+)$/.exec(piece)
    const dId = found ? Number(found[1]) : 0
    if (!found || !Number.isSafeInteger(dId) || dId < 1) return raw
    // 같은 서비스가 두 번 나와도 한 번만 (목록 key 가 겹치지 않게)
    if (!items.some((item) => item.d_id === dId)) items.push({ d_id: dId, label: found[2] })
  }
  return { message: detail.slice(0, at), items }
}

// 계정 삭제 응답을 결과 화면용으로 다듬는다 - 남은 ECR 저장소 이름은 문자열만
export function deleteResultView(response) {
  const message = typeof response?.message === 'string' && response.message.trim() ? response.message : DELETE_DONE_TEXT
  const list = response?.leftover_ecr_repositories
  // 같은 이름은 한 번만 (목록 key 가 겹치지 않게)
  const leftovers = Array.isArray(list) ? [...new Set(list.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()))] : []
  return { message, leftovers }
}

// 사진 주소는 https 만 그린다 (그 밖의 주소·스킴은 사진 없이)
export function safePictureUrl(value) {
  if (typeof value !== 'string' || !value) return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

// 로그인 화면 주소 - 돌아올 경로는 한 번만 인코딩한다
export function loginPathFor(path) {
  return '/login?next=' + encodeURIComponent(path)
}

// 상단 바의 로그인·내 정보 링크 - 로그인했으면 내 정보, 로그인이 가능할 때만 로그인, 아니면 없음 (끔 모드 화면은 그대로)
export function authNavLinkView({ config, status, path }) {
  if (status === 'signed_in') return { label: '내 정보', to: ME_PATH }
  if (status === 'signed_out' && config?.login_available) return { label: '로그인', to: loginPathFor(path) }
  return null
}

// 내 정보 화면이 무엇을 보일지 - ended(끝난 뒤 결과 화면)는 세션이 없어도 보이고, hold 는 로그아웃 중 이동을 기다린다
export function meViewState({ config, configError, status, ended, hold }) {
  if (ended) return { kind: 'ended' }
  if (hold) return { kind: 'hold' }
  if (configError) return { kind: 'error' }
  if (!config || status === 'unknown') return { kind: 'loading' }
  if (status === 'signed_in') return { kind: 'ready' }
  // 로그인할 수 없는 끄기 모드에서는 내 정보가 없으니 처음 화면으로
  return { kind: 'redirect', to: config.auth_required || config.login_available ? loginPathFor(ME_PATH) : '/' }
}

// 로그아웃한 뒤 갈 곳 - 로그인이 필요한 서버는 로그인 화면, 끈 모드는 처음 화면
export function afterLogoutPath(config) {
  return config?.auth_required ? '/login' : '/'
}

// 상단 바의 알림·계정 연결 링크를 그릴지 - 로그인했거나 로그인이 필요 없는 서버일 때만 (세션 없이 알림을 읽으려 하지 않게)
export const topbarNavVisible = ({ config, status }) => status === 'signed_in' || (!!config && config.auth_required === false)

// 서버 로그아웃만 다시 시도한다 (주입) - 됐으면 true, 또 실패하면 false
export async function retryServerLogout(logout) {
  try {
    await logout()
    return true
  } catch {
    return false
  }
}

// 로그아웃 순서 (주입) - 서버 호출이 실패해도 이 브라우저에서는 끝내고, 서버에서 못 끝냈는지 알려 준다
export async function runSignOut({ logout, clearSession, clearStorage }) {
  let serverLoggedOut = true
  try {
    await logout()
  } catch {
    serverLoggedOut = false
  }
  clearSession()
  clearStorage()
  return { serverLoggedOut }
}

const TOKEN_NAME_ERROR = '이름은 1~50자로 적어 주세요'
const DAY_MS = 86400000

// 개인 토큰 만들기 폼 검사 - 이름은 앞뒤 공백을 뗀 1~50자, 기간은 비우면 서버 기본이고 아니면 1~최대 정수
export function validateTokenForm({ name, days }, config) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  const length = [...trimmed].length
  if (length < 1 || length > 50) return { body: null, error: TOKEN_NAME_ERROR }
  const max = positiveInt(config?.pat_max_days, DEFAULT_PAT_MAX_DAYS)
  const raw = typeof days === 'string' ? days.trim() : ''
  if (!raw) return { body: { name: trimmed }, error: null }
  const value = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN
  if (!(value >= 1 && value <= max)) return { body: null, error: `기간은 1~${max}일입니다` }
  return { body: { name: trimmed, expires_in_days: value }, error: null }
}

// 만료 문구 - 남은 날은 올림(1초라도 남으면 1일), 지났거나 같으면 만료됨, 없으면 만료 없음. 날짜는 브라우저의 현지 날짜
export function tokenExpiryText(expiresAt, now = Date.now()) {
  if (expiresAt === null || expiresAt === undefined) return '만료 없음'
  const at = toMs(expiresAt)
  if (Number.isNaN(at)) return '만료일을 읽을 수 없습니다'
  const current = now instanceof Date ? now.getTime() : now
  if (at <= current) return '만료됨'
  const left = Math.ceil((at - current) / DAY_MS)
  const d = new Date(at)
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일까지 (${left}일 남음)`
}

// MCP 등록에 붙여 넣을 환경변수 한 줄 (원문이 들어 있으니 로그에 남기지 않는다)
export const mcpEnvLine = (token) => `WIZARD_API_TOKEN=${token}`

// 클립보드에 복사 - 됐으면 true, 클립보드가 없거나 거절하면 false (이유와 텍스트는 밖으로 내보내지 않는다)
export async function copyText(text, clipboard) {
  if (typeof clipboard?.writeText !== 'function') return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
