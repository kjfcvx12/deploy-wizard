import { clearRefreshToken, readRefreshToken, writeRefreshToken } from './tokenStore'

// 웹 shared/ui/session.js 와 같은 의미 (앱은 app/ 밖을 가져오지 않는다). 앱에는 탭이 없어 탭 동기화는 없다
// 이 상태로 실패하면 리프레시 토큰이 더는 쓸 수 없다는 뜻 - 세션을 지운다
const REFRESH_DEAD_STATUSES = [401, 403]

// 세션 하나를 만든다 - 액세스 토큰은 메모리에만, 리프레시 원문은 보안 저장소(네이티브)에만
export function createSession() {
  let accessToken = null
  let user = null
  let expiresAt = null
  let status = 'unknown'
  let refresher = null
  let inflight = null
  // 세션이 바뀔 때마다 오른다 - 갱신 요청 중에 로그인·로그아웃이 있었는지 본다
  let version = 0
  // 로그아웃(지우기)마다 오른다 - 저장을 기다리던 setSession 이 지운 세션을 되살리지 않게
  let clearEpoch = 0
  // 보안 저장소 쓰기가 실패했을 때만 이번 실행 동안 메모리에 두는 리프레시 원문 (구독자·화면에는 주지 않는다)
  let memoryRefresh = null
  // 보안 저장소에 쓰지 못했다 - 다음 실행 때 다시 로그인해야 한다
  let storageWarning = false
  // 저장소 쓰기·지우기를 부른 순서대로 한다
  let queue = Promise.resolve()
  const subscribers = new Set()

  // 저장소 작업을 줄에 세운다 - 앞 작업이 실패해도 뒤 작업은 한다
  const enqueue = (job) => {
    const run = queue.then(job)
    queue = run.catch(() => {})
    return run
  }

  // 구독자에게 지금 상태를 알린다 - 토큰은 넣지 않는다
  const notify = (reason) => {
    const state = reason ? { status, user, storageWarning, reason } : { status, user, storageWarning }
    for (const fn of [...subscribers]) {
      try { fn(state) } catch { /* 구독자 오류가 다른 구독자를 막지 않게 */ }
    }
  }

  // 토큰 응답에서 메모리에 둘 값만 꺼낸다 - refresh_token 은 여기서 보관하지 않는다
  const apply = (token) => {
    accessToken = typeof token?.access_token === 'string' && token.access_token ? token.access_token : null
    user = token?.user ?? null
    const expiresIn = Number(token?.expires_in)
    expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null
    status = accessToken ? 'signed_in' : 'signed_out'
    version += 1
  }

  // 메모리의 세션을 비운다
  const wipe = () => {
    accessToken = null
    user = null
    expiresAt = null
    status = 'signed_out'
    version += 1
  }

  // 지금 액세스 토큰 (없으면 null)
  const getAccessToken = () => accessToken
  // 지금 사용자 (없으면 null)
  const getSessionUser = () => user
  // 지금 상태: unknown(첫 확인 전) | signed_in | signed_out
  const getSessionStatus = () => status
  // 보안 저장소 쓰기가 실패했는지 (다음 실행 때 다시 로그인)
  const getStorageWarning = () => storageWarning

  // 갱신·로그아웃 본문에 실을 리프레시 원문 - 저장에 실패했으면 메모리의 것, 아니면 보안 저장소의 것
  const getRefreshToken = async () => memoryRefresh ?? readRefreshToken()

  // 로그인·갱신 응답을 보관한다 - refresh_token 이 있으면 먼저 보안 저장소에 쓰고, 그 뒤에 메모리에 반영한다
  const setSession = (token) => {
    const raw = typeof token?.refresh_token === 'string' && token.refresh_token ? token.refresh_token : null
    const epoch = clearEpoch
    return enqueue(async () => {
      if (raw) {
        const saved = await writeRefreshToken(raw)
        // 저장을 기다리는 동안 로그아웃했으면 되살리지 않는다 (줄의 다음 지우기가 저장소도 비운다)
        if (epoch !== clearEpoch) return
        storageWarning = !saved
        // 쓰지 못했으면 원문은 이번 실행 동안 메모리에만 둔다 - 다른 저장소로 옮기지 않는다. 저장소에 남은 옛 원문은 이미 회전돼 쓸 수 없으니 지운다
        memoryRefresh = saved ? null : raw
        if (!saved) await clearRefreshToken()
      }
      if (epoch !== clearEpoch) return
      apply(token)
      notify()
    })
  }

  // 메모리·보안 저장소를 비운다 - announce 가 false 면 알리지 않는다
  const forget = (reason, announce = true) => {
    clearEpoch += 1
    memoryRefresh = null
    storageWarning = false
    wipe()
    if (announce) notify(reason)
    return enqueue(() => clearRefreshToken())
  }

  // 세션을 지운다 - reason: logout | expired | deleted. 저장소를 다 지우면 끝나는 약속을 돌려준다
  const clearSession = (reason) => forget(reason)

  // 상태 변화를 구독한다 - 해제 함수를 돌려준다
  const subscribeSession = (fn) => {
    subscribers.add(fn)
    return () => { subscribers.delete(fn) }
  }

  // 갱신 함수를 등록한다 (엔드포인트는 AuthProvider 가 안다)
  const setRefresher = (fn) => { refresher = typeof fn === 'function' ? fn : null }

  // 실제로 갱신한다 - 요청 중에 로그인·로그아웃이 있었으면 그 결과를 따른다
  const runRefresh = async (startedStatus) => {
    // 갱신 요청 중에 세션이 바뀌었는지 보려고 바로 앞에서 적어 둔다
    const callVersion = version
    let token
    try {
      token = await refresher()
    } catch (e) {
      if (REFRESH_DEAD_STATUSES.includes(e?.status)) {
        // 요청 중에 세션이 바뀌었으면 이 거절은 옛 토큰 기준이다 - 새 세션을 지우지 않는다
        if (version !== callVersion) return status === 'signed_in'
        if (startedStatus === 'signed_in') {
          await forget('expired')
        } else {
          // 로그인한 적 없는(또는 첫 확인 중인) 상태 - 만료 알림 없이 조용히. 이미 signed_out 이면 알리지도 않는다
          await forget(null, status !== 'signed_out')
        }
        return false
      }
      // 연결 실패·5xx 는 로그아웃이 아니다 - 세션을 두고 그 오류를 던진다
      throw e
    }
    // 요청 중에 로그인·로그아웃이 있었으면 늦게 온 결과로 덮지 않는다
    if (version !== callVersion) return status === 'signed_in'
    await setSession(token)
    return status === 'signed_in'
  }

  // 액세스 토큰을 갱신한다 - 진행 중인 갱신이 있으면 함께 기다린다 (한 번에 하나)
  const refreshSession = () => {
    if (inflight) return inflight
    if (!refresher) return Promise.resolve(false)
    const startedStatus = status
    inflight = runRefresh(startedStatus).finally(() => { inflight = null })
    return inflight
  }

  // 첫 확인 전 unknown 을 끝낸다 - 이미 정해진 상태는 바꾸지 않는다
  const markBooted = (next) => {
    if (status !== 'unknown') return
    status = next === 'signed_in' && accessToken ? 'signed_in' : 'signed_out'
    notify()
  }

  // 테스트용: 처음 상태로 되돌린다 (저장소는 건드리지 않는다)
  const reset = () => {
    accessToken = null
    user = null
    expiresAt = null
    status = 'unknown'
    refresher = null
    inflight = null
    version = 0
    clearEpoch = 0
    memoryRefresh = null
    storageWarning = false
    queue = Promise.resolve()
    subscribers.clear()
  }

  return {
    getAccessToken, getSessionUser, getSessionStatus, getStorageWarning, getRefreshToken,
    setSession, clearSession, subscribeSession, setRefresher, refreshSession, markBooted, reset,
    // 만료 시각(ms) - 미리 갱신할 때 쓴다
    getExpiresAt: () => expiresAt,
  }
}

const defaultSession = createSession()

export const {
  getAccessToken, getSessionUser, getSessionStatus, getStorageWarning, getRefreshToken,
  setSession, clearSession, subscribeSession, setRefresher, refreshSession, markBooted, getExpiresAt,
} = defaultSession

// 테스트용: 기본 세션을 처음 상태로 되돌린다
export const resetSessionForTest = () => defaultSession.reset()
