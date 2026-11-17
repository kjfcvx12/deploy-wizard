// 웹 features/auth/ui/authLogic.js 와 같은 의미 (앱은 app/ 밖을 가져오지 않는다) - 한쪽을 고치면 다른 쪽도 같이 고친다
import { Google_Sign_In_Error } from './googleError'

const DEFAULT_PAT_DAYS = 30
const DEFAULT_PAT_MAX_DAYS = 90
const LOGIN_FAILED_TEXT = '로그인하지 못했습니다. 잠시 뒤 다시 시도해 주세요'
// 앱의 연결 실패 문장 (api.js NETWORK_ERROR 와 같다 - 앱은 상태코드 없이 이 문장으로 던진다)
const NETWORK_ERROR_TEXT = '서버에 연결할 수 없습니다'
export const UNSUPPORTED_PLATFORM_TEXT = '이 기기에서는 아직 로그인을 지원하지 않습니다'
const LOGIN_SEGMENT = 'login'

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

// 로그인 실패를 사용자 문구로 - 우리가 정한 Google 오류·서버가 준 문구는 그대로, 연결 실패는 안내, 그 밖은 기본 문구
export function loginErrorText(error) {
  if (error instanceof Google_Sign_In_Error) return error.message
  const message = typeof error?.message === 'string' ? error.message.trim() : ''
  if (error?.status === 0 || (error?.status === undefined && message === NETWORK_ERROR_TEXT)) return NETWORK_ERROR_TEXT
  if (error?.status === undefined && message === UNSUPPORTED_PLATFORM_TEXT) return UNSUPPORTED_PLATFORM_TEXT
  const fromServer = typeof error?.status === 'number' && message && !/^요청 실패 \(\d+\)$/.test(message)
  return fromServer ? message : LOGIN_FAILED_TEXT
}

// 지금 경로를 보여줄지 정한다 - loading | error | allow | to_login | leave_login (웹 routeDecision 과 같은 표 + 로그인한 사람은 로그인 화면을 떠난다)
// holdSegment: 그 화면이 스스로 끝난 뒤의 결과(계정 삭제 결과·로그아웃 실패 안내)를 보이는 동안은 세션이 없어도 그 경로를 그대로 둔다 (그 화면만)
export function authRoute({ config, configError, status, segments, holdSegment = null }) {
  if (holdSegment && Array.isArray(segments) && segments[0] === holdSegment) return 'allow'
  const onLogin = Array.isArray(segments) && segments[0] === LOGIN_SEGMENT
  if (onLogin) return status === 'signed_in' ? 'leave_login' : 'allow'
  if (configError) return 'error'
  if (!config || status === 'unknown') return 'loading'
  if (!config.auth_required) return 'allow'
  return status === 'signed_in' ? 'allow' : 'to_login'
}

// 알림 탭으로 화면을 옮겨도 되는지 - 지금 경로를 보여도 되고(allow), 정말 들어온 상태(로그인했거나 로그인이 필요 없는 서버)일 때만
// 로그인이 필요한 서버의 로그인 화면은 allow 지만 아직 들어온 것이 아니다 - 그동안 누른 알림은 로그인 뒤에 한 번 옮긴다
export function notificationRouteAllowed({ config, configError, status, segments, holdSegment = null }) {
  if (authRoute({ config, configError, status, segments, holdSegment }) !== 'allow') return false
  if (status === 'signed_in') return true
  return Boolean(config) && !config.auth_required
}

// 시작 때 리프레시를 해 볼지 - 네이티브는 보안 저장소에 원문이 있을 때만, 웹 번들은 쿠키를 볼 수 없어 로그인이 필요하거나 할 수 있는 서버에서만
export function shouldTryRefresh({ platform, config, hasStoredRefresh }) {
  if (platform === 'web') return Boolean(config?.auth_required || config?.login_available)
  return Boolean(hasStoredRefresh)
}

// 시작 확인의 순서 (순수 - 호출은 모두 주입) - 설정 읽기 -> 필요하면 갱신 -> 첫 확인 끝내기. 연결 문제로 정하지 못하면 { error: true }
// 로그인이 필요한 서버에서는 연결 실패·5xx 를 로그아웃으로 보지 않고, 끈 서버에서는 세션이 필요 없어 어떤 갱신 실패든 로그아웃 상태로 끝낸다
export async function runBoot({ getConfig, canRefresh, refresh, getStatus, markBooted, clearStored = async () => {}, live = () => true, onConfig = () => {} }) {
  let config
  let missing = false
  try {
    config = normalizeConfig(await getConfig())
  } catch (e) {
    // 늦게 끝난 옛 시작이면 오류도 남기지 않는다
    if (e?.status !== 404) return { error: live() }
    // 옛 서버 - 로그인 끔으로 보고 갱신도 시도하지 않는다
    config = CONFIG_OFF
    missing = true
  }
  if (!live()) return { error: false }
  onConfig(config)

  // 이미 정해졌으면(첫 확인 중에 로그인 등) 더 하지 않는다
  if (getStatus() !== 'unknown') return { error: false }
  const tryRefresh = !missing && (await canRefresh(config))
  if (!live()) return { error: false }
  if (!tryRefresh) {
    markBooted('signed_out')
    return { error: false }
  }
  try {
    await refresh()
  } catch (e) {
    if (!live()) return { error: false }
    if (config.auth_required) return { error: true }
    // 끈 서버: 서버가 갱신 경로를 모른다는 확실한 답(404)이면 저장된 원문도 지운다 (401·403 은 세션이 이미 지웠다)
    if (e?.status === 404) await clearStored()
    markBooted('signed_out')
    return { error: false }
  }
  if (!live()) return { error: false }
  // 갱신이 성공했거나 서버가 원문을 거절한 확실한 결과일 때만 첫 확인을 끝낸다
  markBooted(getStatus())
  return { error: false }
}

// 로그인 화면이 무엇을 보여줄지 - redirect | error | loading | unavailable | ready, offNote 는 "로그인하지 않고 계속" 안내를 덧붙일지
export function loginViewState({ config, configError, status }) {
  if (status === 'signed_in') return { kind: 'redirect', offNote: false }
  if (configError) return { kind: 'error', offNote: false }
  if (!config || status === 'unknown') return { kind: 'loading', offNote: false }
  const offNote = !config.auth_required
  // 서버가 로그인을 열지 않았거나 웹 클라이언트 ID 가 없으면 로그인할 수 없다 (안드로이드도 웹 클라이언트 ID 로 설정한다)
  const canSignIn = config.login_available === true && Boolean(config.google_client_id_web)
  return { kind: canSignIn ? 'ready' : 'unavailable', offNote }
}

// 로그아웃한 뒤 갈 곳 - 로그인이 필요한 서버는 로그인 화면, 끈 모드는 처음 화면
export function afterLogoutPath(config) {
  return config?.auth_required ? '/login' : '/'
}

// 프로필 사진 주소 - https 만 받고 그 밖(http·javascript·빈 값)은 null
export function safePictureUrl(value) {
  if (typeof value !== 'string' || !value) return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

// 내 정보 화면이 무엇을 보일지 - ended(끝난 뒤 결과) | ready | wait(경로 보호가 덮개·이동을 맡는다) | redirect(로그인이 필요 없는 서버에서 로그인 없이 열렸다 -> 처음 화면)
// hold 는 로그아웃 중 - 세션이 지워져도 화면을 그대로 두고 이동은 로그아웃이 끝난 뒤 한 번만
export function meViewState({ config, configError, status, ended, hold }) {
  if (ended) return { kind: 'ended' }
  if (hold || status === 'signed_in') return { kind: 'ready' }
  if (configError || !config || status === 'unknown') return { kind: 'wait' }
  return config.auth_required ? { kind: 'wait' } : { kind: 'redirect', to: '/' }
}

// 실패해도 다음 단계로 가게 감싼다 - 성공하면 true
const attempt = async (fn) => {
  try {
    await fn()
    return true
  } catch {
    return false
  }
}

// 로그아웃 순서 (주입) - ① 액세스 토큰이 살아 있을 때 푸시 기기 해제 ② 서버 로그아웃(리프레시 원문은 세션을 지우기 전에 읽는다) ③ 세션 ④ 사용자 저장값 ⑤ Google
// 서버 호출이 실패해도 이 기기에서는 끝내고, 서버에서 못 끝냈는지({ serverLoggedOut: false })를 돌려준다
export async function runSignOut({ unregisterPush, readRefresh, logout, clearSession, clearUserData, googleSignOut }) {
  await attempt(unregisterPush)
  let refresh = null
  await attempt(async () => { refresh = await readRefresh() })
  const serverLoggedOut = await attempt(() => logout(refresh))
  await attempt(clearSession)
  await attempt(clearUserData)
  await attempt(googleSignOut)
  return { serverLoggedOut }
}

const DELETE_DONE_TEXT = '계정을 삭제했습니다'

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
    items.push({ d_id: dId, label: found[2] })
  }
  return { message: detail.slice(0, at), items }
}

// 계정 삭제 응답을 결과 화면용으로 다듬는다 - 남은 ECR 저장소 이름은 문자열만
export function deleteResultView(response) {
  const message = typeof response?.message === 'string' && response.message.trim() ? response.message : DELETE_DONE_TEXT
  const list = response?.leftover_ecr_repositories
  const leftovers = Array.isArray(list) ? list.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()) : []
  return { message, leftovers }
}
