import {
  CONFIG_OFF, normalizeConfig, loginErrorText, parseLiveDeploys, deleteResultView, authRoute, runBoot,
  shouldTryRefresh, loginViewState, afterLogoutPath, runSignOut, UNSUPPORTED_PLATFORM_TEXT,
} from '../auth/logic'
import { Google_Sign_In_Error, GENERIC_SIGN_IN_TEXT } from '../auth/googleError'

const GOOD = {
  auth_required: true,
  login_available: true,
  platforms: ['web', 'android'],
  google_client_id_web: 'web-client.apps.googleusercontent.com',
  pat_default_days: 30,
  pat_max_days: 90,
}
const ON = { ...GOOD, auth_required: true }
const OFF = { ...GOOD, auth_required: false }
const LOGIN_FAILED = '로그인하지 못했습니다. 잠시 뒤 다시 시도해 주세요'
const LIVE_TEXT = '먼저 멈추거나 삭제해야 하는 서비스가 있습니다: #3 my-app, #5 other'
// 상태코드가 붙은 오류
const httpError = (status, message = `요청 실패 (${status})`) => Object.assign(new Error(message), { status })

describe('normalizeConfig · CONFIG_OFF (웹 authLogic 과 같은 표)', () => {
  test('좋은 값은 그대로, 모르는 키는 버린다', () => {
    expect(normalizeConfig({ ...GOOD, secret: 'x' })).toEqual(GOOD)
  })

  test('비었거나 타입이 틀리면 안전한 끔 쪽 기본값', () => {
    const off = { auth_required: false, login_available: false, platforms: [], google_client_id_web: null, pat_default_days: 30, pat_max_days: 90 }
    expect(normalizeConfig({})).toEqual(off)
    expect(normalizeConfig(null)).toEqual(off)
    expect(normalizeConfig(undefined)).toEqual(off)
    expect(normalizeConfig([1])).toEqual(off)
    expect(normalizeConfig({ auth_required: 'yes' }).auth_required).toBe(false)
    expect(normalizeConfig({ login_available: 1 }).login_available).toBe(false)
    expect(normalizeConfig({ platforms: 'web' }).platforms).toEqual([])
    expect(normalizeConfig({ platforms: ['web', 3, null] }).platforms).toEqual(['web'])
    expect(normalizeConfig({ google_client_id_web: 5 }).google_client_id_web).toBeNull()
    expect(normalizeConfig({ google_client_id_web: '  ' }).google_client_id_web).toBeNull()
    expect(normalizeConfig({ pat_default_days: '30' }).pat_default_days).toBe(30)
    expect(normalizeConfig({ pat_max_days: 0 }).pat_max_days).toBe(90)
    expect(normalizeConfig({ pat_default_days: 7, pat_max_days: 14 }).pat_default_days).toBe(7)
  })

  test('CONFIG_OFF 는 옛 서버의 "로그인 끔" 설정이고 바꿀 수 없다', () => {
    expect(CONFIG_OFF.auth_required).toBe(false)
    expect(CONFIG_OFF.login_available).toBe(false)
    expect(CONFIG_OFF.platforms).toEqual([])
    expect(Object.isFrozen(CONFIG_OFF)).toBe(true)
  })
})

describe('loginErrorText', () => {
  test('서버 문구는 그대로, 연결 실패는 안내, 그 밖은 기본 문구', () => {
    expect(loginErrorText(httpError(403, '로그인이 허용된 계정이 아닙니다'))).toBe('로그인이 허용된 계정이 아닙니다')
    expect(loginErrorText(httpError(503, '지금은 로그인을 사용할 수 없습니다'))).toBe('지금은 로그인을 사용할 수 없습니다')
    // 앱의 연결 실패는 상태코드 없이 이 문장이다 (api.js NETWORK_ERROR)
    expect(loginErrorText(new Error('서버에 연결할 수 없습니다'))).toBe('서버에 연결할 수 없습니다')
    expect(loginErrorText(httpError(0, '서버에 연결할 수 없습니다'))).toBe('서버에 연결할 수 없습니다')
    expect(loginErrorText(httpError(500))).toBe(LOGIN_FAILED)
    expect(loginErrorText({ status: 500 })).toBe(LOGIN_FAILED)
    expect(loginErrorText(null)).toBe(LOGIN_FAILED)
    expect(loginErrorText(new Error('Network request failed SECRET'))).toBe(LOGIN_FAILED)
  })

  test('Google 어댑터의 한국어 오류와 지원 안 함 안내는 그대로', () => {
    expect(loginErrorText(new Google_Sign_In_Error(GENERIC_SIGN_IN_TEXT))).toBe(GENERIC_SIGN_IN_TEXT)
    expect(UNSUPPORTED_PLATFORM_TEXT).toBe('이 기기에서는 아직 로그인을 지원하지 않습니다')
  })
})

describe('parseLiveDeploys · deleteResultView (웹과 같은 표)', () => {
  test('서버 409 문구를 문구와 항목으로 나눈다', () => {
    const out = parseLiveDeploys(LIVE_TEXT)
    expect(out.message).toBe('먼저 멈추거나 삭제해야 하는 서비스가 있습니다')
    expect(out.items).toEqual([{ d_id: 3, label: 'my-app' }, { d_id: 5, label: 'other' }])
    expect(parseLiveDeploys('먼저 멈추거나 삭제해야 하는 서비스가 있습니다: #7 https://github.com/a/b').items).toEqual([{ d_id: 7, label: 'https://github.com/a/b' }])
  })

  test('형식이 다르면 항목 없이 원문 그대로, 문자열이 아니면 빈 문구', () => {
    for (const raw of ['서비스가 있습니다', '먼저 멈추세요: my-app, other', '문구: #x name', '문구: #3', '문구: #3 a, b', '문구: #0 zero', '문구: #3 a,#5 b']) {
      expect(parseLiveDeploys(raw)).toEqual({ message: raw, items: [] })
    }
    for (const raw of [undefined, null, 5, { a: 1 }, ['x']]) {
      expect(parseLiveDeploys(raw)).toEqual({ message: '', items: [] })
    }
  })

  test('deleteResultView: 문구 그대로 + 저장소 목록, 이상한 값은 안전하게', () => {
    expect(deleteResultView({ message: '계정을 삭제했습니다.', leftover_ecr_repositories: ['a', 'b'], deleted: { deploys: 1 } })).toEqual({ message: '계정을 삭제했습니다.', leftovers: ['a', 'b'] })
    expect(deleteResultView({ message: 'm' })).toEqual({ message: 'm', leftovers: [] })
    expect(deleteResultView({ message: 'm', leftover_ecr_repositories: 'a' })).toEqual({ message: 'm', leftovers: [] })
    expect(deleteResultView({ message: 'm', leftover_ecr_repositories: ['a', '', 3, null, ' '] })).toEqual({ message: 'm', leftovers: ['a'] })
    expect(deleteResultView(null)).toEqual({ message: '계정을 삭제했습니다', leftovers: [] })
  })
})

describe('authRoute', () => {
  test.each([
    [{ config: null, status: 'signed_out', segments: [] }, 'loading'],
    [{ config: null, status: 'unknown', segments: [] }, 'loading'],
    [{ config: null, configError: true, status: 'unknown', segments: [] }, 'error'],
    [{ config: OFF, configError: true, status: 'signed_out', segments: [] }, 'error'],
    [{ config: OFF, status: 'signed_out', segments: [] }, 'allow'],
    [{ config: OFF, status: 'signed_in', segments: ['deploys', '[d_id]'] }, 'allow'],
    [{ config: ON, status: 'unknown', segments: [] }, 'loading'],
    [{ config: ON, status: 'signed_out', segments: [] }, 'to_login'],
    [{ config: ON, status: 'signed_out', segments: ['deploys', '[d_id]'] }, 'to_login'],
    [{ config: ON, status: 'signed_in', segments: [] }, 'allow'],
    // 로그인 화면 자신은 늘 보인다 (로그인 화면이 불러오는 중·오류를 스스로 보인다)
    [{ config: ON, status: 'signed_out', segments: ['login'] }, 'allow'],
    [{ config: ON, status: 'unknown', segments: ['login'] }, 'allow'],
    [{ config: null, status: 'unknown', segments: ['login'] }, 'allow'],
    [{ config: null, configError: true, status: 'unknown', segments: ['login'] }, 'allow'],
    [{ config: OFF, status: 'signed_out', segments: ['login'] }, 'allow'],
    // 이미 로그인했으면 로그인 화면을 떠나 목록으로 (웹 로그인 화면도 로그인한 사람은 바로 보낸다)
    [{ config: ON, status: 'signed_in', segments: ['login'] }, 'leave_login'],
    [{ config: OFF, status: 'signed_in', segments: ['login'] }, 'leave_login'],
    // 세그먼트가 이상해도 던지지 않는다
    [{ config: ON, status: 'signed_out', segments: undefined }, 'to_login'],
    [{ config: ON, status: 'signed_out', segments: ['loginx'] }, 'to_login'],
  ])('%j -> %s', (input, expected) => {
    expect(authRoute(input)).toBe(expected)
  })
})

describe('shouldTryRefresh (시작 때 갱신해 볼지)', () => {
  test('네이티브는 저장된 리프레시가 있을 때만', () => {
    expect(shouldTryRefresh({ platform: 'android', config: ON, hasStoredRefresh: false })).toBe(false)
    expect(shouldTryRefresh({ platform: 'android', config: OFF, hasStoredRefresh: true })).toBe(true)
    expect(shouldTryRefresh({ platform: null, config: ON, hasStoredRefresh: true })).toBe(true)
  })

  test('웹 번들은 쿠키를 볼 수 없어 로그인이 필요하거나 할 수 있는 서버에서만', () => {
    expect(shouldTryRefresh({ platform: 'web', config: ON, hasStoredRefresh: false })).toBe(true)
    expect(shouldTryRefresh({ platform: 'web', config: { ...OFF, login_available: true }, hasStoredRefresh: false })).toBe(true)
    expect(shouldTryRefresh({ platform: 'web', config: { ...OFF, login_available: false }, hasStoredRefresh: false })).toBe(false)
    expect(shouldTryRefresh({ platform: 'web', config: CONFIG_OFF, hasStoredRefresh: false })).toBe(false)
  })
})

// 주입할 가짜들 - 상태는 session 처럼 unknown 에서 시작한다
const bootDeps = ({ config = ON, configError = null, stored = true, refresh = async () => true, statusAfterRefresh = 'signed_in' } = {}) => {
  const calls = { markBooted: [], refresh: 0, clearStored: 0, configs: [] }
  let status = 'unknown'
  const deps = {
    getConfig: jest.fn(async () => { if (configError) throw configError; return config }),
    canRefresh: jest.fn(async (cfg) => shouldTryRefresh({ platform: 'android', config: cfg, hasStoredRefresh: stored })),
    refresh: jest.fn(async () => {
      calls.refresh += 1
      try {
        const ok = await refresh()
        status = statusAfterRefresh
        return ok
      } catch (e) {
        // 세션처럼: 401·403 은 저장소를 지우고 signed_out 으로 바뀐 뒤 false 를 돌려준다 (던지지 않는다)
        if ([401, 403].includes(e?.status)) { status = 'signed_out'; return false }
        throw e
      }
    }),
    getStatus: () => status,
    markBooted: jest.fn((next) => { calls.markBooted.push(next); if (status === 'unknown') status = next === 'signed_in' ? 'signed_in' : 'signed_out' }),
    clearStored: jest.fn(async () => { calls.clearStored += 1 }),
    onConfig: jest.fn((cfg) => calls.configs.push(cfg)),
  }
  return { deps, calls, status: () => status }
}

describe('runBoot (시작 확인 순서)', () => {
  test('옛 서버(설정 404) -> CONFIG_OFF, 저장된 리프레시가 있어도 갱신하지 않고 signed_out', async () => {
    const { deps, calls, status } = bootDeps({ configError: httpError(404), stored: true })
    expect(await runBoot(deps)).toEqual({ error: false })
    expect(calls.configs).toEqual([CONFIG_OFF])
    expect(calls.refresh).toBe(0)
    expect(deps.canRefresh).not.toHaveBeenCalled()
    expect(calls.markBooted).toEqual(['signed_out'])
    expect(status()).toBe('signed_out')
  })

  test('끔 모드 + 저장된 리프레시 없음 -> 아무것도 보내지 않고 signed_out', async () => {
    const { deps, calls } = bootDeps({ config: { ...OFF, login_available: false }, stored: false })
    expect(await runBoot(deps)).toEqual({ error: false })
    expect(calls.refresh).toBe(0)
    expect(calls.markBooted).toEqual(['signed_out'])
  })

  test.each([
    ['401', httpError(401)],
    ['403', httpError(403)],
    ['404', httpError(404)],
    ['500', httpError(500)],
    ['503', httpError(503)],
    ['연결 실패', new Error('서버에 연결할 수 없습니다')],
  ])('끔 모드 + 갱신 실패(%s) -> 어떤 실패든 signed_out (연결 오류 화면에 갇히지 않는다), markBooted 한 번', async (_name, error) => {
    const { deps, calls, status } = bootDeps({ config: OFF, stored: true, refresh: async () => { throw error } })
    expect(await runBoot(deps)).toEqual({ error: false })
    expect(calls.markBooted).toEqual(['signed_out'])
    expect(status()).toBe('signed_out')
  })

  test('끔 모드 + 갱신 404 는 저장된 리프레시도 지운다 (서버가 갱신을 모른다), 연결 실패는 남긴다', async () => {
    const notFound = bootDeps({ config: OFF, refresh: async () => { throw httpError(404) } })
    await runBoot(notFound.deps)
    expect(notFound.calls.clearStored).toBe(1)
    const offline = bootDeps({ config: OFF, refresh: async () => { throw new Error('서버에 연결할 수 없습니다') } })
    await runBoot(offline.deps)
    expect(offline.calls.clearStored).toBe(0)
  })

  test.each([
    ['연결 실패', new Error('서버에 연결할 수 없습니다')],
    ['500', httpError(500)],
    ['503', httpError(503)],
  ])('로그인 필요 + 갱신 %s -> error (다시 시도), signed_out 으로 만들지 않는다', async (_name, error) => {
    const { deps, calls, status } = bootDeps({ config: ON, stored: true, refresh: async () => { throw error } })
    expect(await runBoot(deps)).toEqual({ error: true })
    expect(calls.markBooted).toEqual([])
    expect(status()).toBe('unknown')
  })

  test.each([['401', 401], ['403', 403]])('로그인 필요 + 갱신 %s -> signed_out (로그인으로), markBooted 한 번', async (_name, code) => {
    const { deps, calls, status } = bootDeps({ config: ON, stored: true, refresh: async () => { throw httpError(code) } })
    expect(await runBoot(deps)).toEqual({ error: false })
    expect(calls.markBooted).toEqual(['signed_out'])
    expect(status()).toBe('signed_out')
    expect(authRoute({ config: ON, configError: false, status: status(), segments: [] })).toBe('to_login')
  })

  test('로그인 필요 + 저장된 리프레시 없음 -> 갱신 없이 signed_out', async () => {
    const { deps, calls } = bootDeps({ config: ON, stored: false })
    expect(await runBoot(deps)).toEqual({ error: false })
    expect(calls.refresh).toBe(0)
    expect(calls.markBooted).toEqual(['signed_out'])
  })

  test('갱신 성공 -> markBooted(signed_in) 한 번', async () => {
    const { deps, calls, status } = bootDeps({ config: ON, stored: true })
    expect(await runBoot(deps)).toEqual({ error: false })
    expect(calls.refresh).toBe(1)
    expect(calls.markBooted).toEqual(['signed_in'])
    expect(status()).toBe('signed_in')
  })

  test.each([
    ['404 아님 4xx', httpError(422)],
    ['500', httpError(500)],
    ['연결 실패', new Error('서버에 연결할 수 없습니다')],
  ])('설정 읽기 실패(%s) -> error, 갱신도 markBooted 도 없다', async (_name, error) => {
    const { deps, calls } = bootDeps({ configError: error })
    expect(await runBoot(deps)).toEqual({ error: true })
    expect(calls.refresh).toBe(0)
    expect(calls.markBooted).toEqual([])
    expect(calls.configs).toEqual([])
  })

  test('이미 정해진 상태(다른 곳에서 로그인)면 더 하지 않는다', async () => {
    const { deps, calls } = bootDeps({ config: ON })
    deps.getStatus = () => 'signed_in'
    expect(await runBoot(deps)).toEqual({ error: false })
    expect(calls.refresh).toBe(0)
    expect(calls.markBooted).toEqual([])
  })

  test('늦게 끝난 옛 시작(live false)은 아무것도 바꾸지 않는다', async () => {
    const { deps, calls } = bootDeps({ config: ON })
    expect(await runBoot({ ...deps, live: () => false })).toEqual({ error: false })
    expect(calls.configs).toEqual([])
    expect(calls.markBooted).toEqual([])
    expect(calls.refresh).toBe(0)
  })

  test('갱신 중에 옛 시작이 되면 오류도 markBooted 도 남기지 않는다', async () => {
    let alive = true
    const { deps, calls } = bootDeps({ config: ON, refresh: async () => { alive = false; throw new Error('서버에 연결할 수 없습니다') } })
    expect(await runBoot({ ...deps, live: () => alive })).toEqual({ error: false })
    expect(calls.markBooted).toEqual([])
  })
})

describe('loginViewState', () => {
  test.each([
    [{ config: ON, status: 'signed_in' }, { kind: 'redirect', offNote: false }],
    [{ config: ON, configError: true, status: 'signed_out' }, { kind: 'error', offNote: false }],
    [{ config: null, status: 'signed_out' }, { kind: 'loading', offNote: false }],
    [{ config: ON, status: 'unknown' }, { kind: 'loading', offNote: false }],
    [{ config: ON, status: 'signed_out' }, { kind: 'ready', offNote: false }],
    [{ config: OFF, status: 'signed_out' }, { kind: 'ready', offNote: true }],
    [{ config: { ...OFF, login_available: false }, status: 'signed_out' }, { kind: 'unavailable', offNote: true }],
    [{ config: { ...ON, google_client_id_web: null }, status: 'signed_out' }, { kind: 'unavailable', offNote: false }],
  ])('%j', (input, expected) => {
    expect(loginViewState(input)).toEqual(expected)
  })
})

describe('afterLogoutPath · runSignOut', () => {
  test('로그인이 필요하면 로그인 화면, 끔 모드는 처음 화면', () => {
    expect(afterLogoutPath(ON)).toBe('/login')
    expect(afterLogoutPath(OFF)).toBe('/')
    expect(afterLogoutPath(null)).toBe('/')
  })

  test('순서: 기기 해제 -> 리프레시 읽기 -> 서버 로그아웃 -> 세션 지우기 -> 사용자 저장값 -> Google 로그아웃', async () => {
    const order = []
    const result = await runSignOut({
      unregisterPush: async () => { order.push('unregister') },
      readRefresh: async () => { order.push('read'); return 'dwr_1' },
      logout: async (rt) => { order.push(`logout:${rt}`) },
      clearSession: async () => { order.push('clear') },
      clearUserData: async () => { order.push('userData') },
      googleSignOut: async () => { order.push('google') },
    })
    expect(result).toEqual({ serverLoggedOut: true })
    expect(order).toEqual(['unregister', 'read', 'logout:dwr_1', 'clear', 'userData', 'google'])
  })

  test('서버 로그아웃·기기 해제·Google 로그아웃이 실패해도 이 기기에서는 끝내고 serverLoggedOut:false', async () => {
    const order = []
    const result = await runSignOut({
      unregisterPush: async () => { throw new Error('x') },
      readRefresh: async () => null,
      logout: async () => { throw new Error('서버에 연결할 수 없습니다') },
      clearSession: async () => { order.push('clear') },
      clearUserData: async () => { throw new Error('y') },
      googleSignOut: async () => { throw new Error('z') },
    })
    expect(result).toEqual({ serverLoggedOut: false })
    expect(order).toEqual(['clear'])
  })
})
