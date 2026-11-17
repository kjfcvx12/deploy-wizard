import { NETWORK_ERROR_TEXT } from '@shared/ui/api.js'

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
  try {
    await refresh()
  } catch (e) {
    if (config.auth_required) return { error: true }
    if (!live()) return { error: false }
    // 끈 서버: 쿠키가 더는 쓸 수 없다는 확실한 답(401·403·404)이면 힌트도 지운다
    if ([401, 403, 404].includes(e?.status)) clearHint()
    markBooted('signed_out')
    return { error: false }
  }
  if (!live()) return { error: false }
  // 갱신이 성공했거나 서버가 쿠키를 거절한 확실한 결과일 때만 첫 확인을 끝낸다
  markBooted(getStatus())
  return { error: false }
}
