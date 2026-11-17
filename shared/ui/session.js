import { tabSync as defaultTabSync } from './tabSync.js'

// 갱신을 탭 사이에서 하나로 묶는 잠금 이름
const REFRESH_LOCK = 'dw-auth-refresh'
// 이 상태로 실패하면 리프레시 토큰이 더는 쓸 수 없다는 뜻 - 세션을 지운다
const REFRESH_DEAD_STATUSES = [401, 403]

// 세션 하나(탭 하나)를 만든다 - 액세스 토큰은 메모리에만, 리프레시 토큰은 쿠키라 여기서 다루지 않는다
export function createSession({ tabSync = defaultTabSync } = {}) {
  let accessToken = null
  let user = null
  let status = 'unknown'
  let refresher = null
  let inflight = null
  // 세션이 바뀔 때마다 오른다 - 잠금을 기다리는 동안 다른 탭이 새 세션을 보냈는지 본다
  let version = 0
  // 이 탭이 직접 세션을 바꾼 마지막 시각(ms) - 이보다 옛 session 방송은 늦게 도착한 것이라 무시한다
  let lastLocalAt = 0
  const subscribers = new Set()

  // 구독자에게 지금 상태를 알린다 - 토큰은 넣지 않는다
  const notify = (reason) => {
    const state = reason ? { status, user, reason } : { status, user }
    for (const fn of [...subscribers]) {
      try { fn(state) } catch { /* 구독자 오류가 다른 구독자를 막지 않게 */ }
    }
  }

  // 토큰 응답에서 필요한 값만 꺼내 보관한다 - refresh_token 은 읽지도 않는다
  const apply = (token) => {
    accessToken = typeof token?.access_token === 'string' && token.access_token ? token.access_token : null
    user = token?.user ?? null
    const expiresIn = Number(token?.expires_in)
    status = accessToken ? 'signed_in' : 'signed_out'
    version += 1
    return { access_token: accessToken, user, expires_in: Number.isFinite(expiresIn) ? expiresIn : null }
  }

  // 세션을 비운다
  const wipe = () => {
    accessToken = null
    user = null
    status = 'signed_out'
    version += 1
  }

  // 방송 없이 조용히 로그아웃 상태로 - 이미 그 상태면 다시 알리지 않는다
  const quietSignOut = () => {
    lastLocalAt = Date.now()
    if (status === 'signed_out') return
    wipe()
    notify()
  }

  // 지금 액세스 토큰 (없으면 null)
  const getAccessToken = () => accessToken
  // 지금 사용자 (없으면 null)
  const getSessionUser = () => user
  // 지금 상태: unknown(첫 확인 전) | signed_in | signed_out
  const getSessionStatus = () => status

  // 로그인·갱신 응답을 보관하고 다른 탭에 알린다
  const setSession = (token) => {
    // access_token 이 없는 응답은 죽은 갱신으로 본다 - 로그인했던 탭은 만료 알림과 방송, 아니면 조용히
    if (!(typeof token?.access_token === 'string' && token.access_token)) {
      if (status === 'signed_in') clearSession('expired')
      else quietSignOut()
      return
    }
    const at = Date.now()
    lastLocalAt = at
    const kept = apply(token)
    notify()
    tabSync.post({ type: 'session', ...kept, at })
  }

  // 세션을 지우고 다른 탭에도 알린다 - reason: logout | expired | deleted
  const clearSession = (reason) => {
    lastLocalAt = Date.now()
    wipe()
    notify(reason)
    tabSync.post({ type: 'signed_out', reason })
  }

  // 상태 변화를 구독한다 - 해제 함수를 돌려준다
  const subscribeSession = (fn) => {
    subscribers.add(fn)
    return () => { subscribers.delete(fn) }
  }

  // 갱신 함수를 등록한다 (엔드포인트는 features/auth/ui 가 안다)
  const setRefresher = (fn) => { refresher = typeof fn === 'function' ? fn : null }

  // 잠금 안에서 실제로 갱신한다 - 기다리는 동안 다른 탭이 세션을 바꿨으면 네트워크 없이 그 결과를 쓴다
  const refreshLocked = async (startedVersion, startedStatus) => {
    if (version !== startedVersion) return status === 'signed_in'
    if (!refresher) return false
    // 갱신 요청 중에 다른 탭(또는 이 탭의 로그인)이 새 세션을 만들었는지 보려고 바로 앞에서 적어 둔다
    const callVersion = version
    let token
    try {
      token = await refresher()
    } catch (e) {
      if (REFRESH_DEAD_STATUSES.includes(e?.status)) {
        // 요청 중에 세션이 바뀌었으면 이 거절은 옛 쿠키 기준이다 - 새 세션을 지우지 않는다
        if (version !== callVersion) return status === 'signed_in'
        if (startedStatus === 'signed_in') {
          clearSession('expired')
        } else {
          // 로그인한 적 없는(또는 첫 확인 중인) 탭 - 만료 알림·다른 탭 방송 없이 조용히 로그아웃 상태로
          quietSignOut()
        }
        return false
      }
      throw e
    }
    setSession(token)
    return status === 'signed_in'
  }

  // 액세스 토큰을 갱신한다 - 탭 안에서는 진행 중인 갱신을 함께 기다리고, 탭 사이에서는 잠금으로 하나만
  const refreshSession = () => {
    if (inflight) return inflight
    if (!refresher) return Promise.resolve(false)
    const startedVersion = version
    const startedStatus = status
    inflight = tabSync.runExclusive(REFRESH_LOCK, () => refreshLocked(startedVersion, startedStatus))
      .finally(() => { inflight = null })
    return inflight
  }

  // 첫 확인 전 unknown 을 끝낸다 - 이미 정해진 상태는 바꾸지 않는다
  const markBooted = (next) => {
    if (status !== 'unknown') return
    status = next === 'signed_in' && accessToken ? 'signed_in' : 'signed_out'
    notify()
  }

  // 테스트용: 처음 상태로 되돌린다 (다른 탭에 알리지 않는다)
  const reset = () => {
    accessToken = null
    user = null
    status = 'unknown'
    refresher = null
    inflight = null
    version = 0
    lastLocalAt = 0
    subscribers.clear()
    offMessage()
  }

  // 다른 탭이 보낸 메시지를 반영한다 - 다시 보내지 않는다. 이 탭이 직접 바꾼 시각보다 옛 session 방송은 늦게 온 것이라 버린다
  const offMessage = tabSync.onMessage((message) => {
    if (message?.type === 'session' && typeof message.access_token === 'string' && message.access_token) {
      if (typeof message.at === 'number' && message.at < lastLocalAt) return
      apply(message)
      notify()
    } else if (message?.type === 'signed_out') {
      wipe()
      notify(message.reason)
    }
  })

  return {
    getAccessToken, getSessionUser, getSessionStatus, setSession, clearSession,
    subscribeSession, setRefresher, refreshSession, markBooted, reset,
  }
}

const defaultSession = createSession()

export const {
  getAccessToken, getSessionUser, getSessionStatus, setSession, clearSession,
  subscribeSession, setRefresher, refreshSession, markBooted,
} = defaultSession

// 테스트용: 기본 세션을 처음 상태로 되돌린다
export const resetSessionForTest = () => defaultSession.reset()
