import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import './useAlias.mjs'

const {
  normalizeConfig, CONFIG_OFF, routeDecision, safeNext, loginErrorText,
  parseLiveDeploys, deleteResultView, safePictureUrl, loginPathFor, authNavLinkView, meViewState, afterLogoutPath, runSignOut,
  validateTokenForm, tokenExpiryText, mcpEnvLine, copyText, topbarNavVisible, retryServerLogout,
} = await import('../../features/auth/ui/authLogic.js')
const { clearUserScopedStorage, HAD_SESSION_KEY } = await import('../../features/auth/ui/userData.js')
const { authApi } = await import('../../features/auth/ui/api.js')
const { NETWORK_ERROR_TEXT } = await import('../../shared/ui/api.js')
const session = await import('../../shared/ui/session.js')

const GOOD = {
  auth_required: true,
  login_available: true,
  platforms: ['android', 'web'],
  google_client_id_web: 'abc.apps.googleusercontent.com',
  pat_default_days: 30,
  pat_max_days: 90,
}

test('normalizeConfig: good values pass, unknown keys are dropped', () => {
  assert.deepEqual(normalizeConfig({ ...GOOD, secret: 'x' }), GOOD)
})

test('normalizeConfig: empty, null and wrong types fall back to the safe off config', () => {
  const off = { auth_required: false, login_available: false, platforms: [], google_client_id_web: null, pat_default_days: 30, pat_max_days: 90 }
  assert.deepEqual(normalizeConfig({}), off)
  assert.deepEqual(normalizeConfig(null), off)
  assert.deepEqual(normalizeConfig(undefined), off)
  assert.equal(normalizeConfig({ auth_required: 'yes' }).auth_required, false)
  assert.equal(normalizeConfig({ login_available: 1 }).login_available, false)
  assert.deepEqual(normalizeConfig({ platforms: 'web' }).platforms, [])
  assert.deepEqual(normalizeConfig({ platforms: ['web', 3, null] }).platforms, ['web'])
  assert.equal(normalizeConfig({ google_client_id_web: 5 }).google_client_id_web, null)
  assert.equal(normalizeConfig({ google_client_id_web: '  ' }).google_client_id_web, null)
  assert.equal(normalizeConfig({ pat_default_days: '30' }).pat_default_days, 30)
  assert.equal(normalizeConfig({ pat_max_days: 0 }).pat_max_days, 90)
  assert.equal(normalizeConfig({ pat_default_days: 7, pat_max_days: 14 }).pat_default_days, 7)
})

test('CONFIG_OFF is the old-server "login off" config', () => {
  assert.equal(CONFIG_OFF.auth_required, false)
  assert.equal(CONFIG_OFF.login_available, false)
  assert.deepEqual(CONFIG_OFF.platforms, [])
})

test('routeDecision table', () => {
  const on = { ...GOOD, auth_required: true }
  const off = { ...GOOD, auth_required: false }
  const cases = [
    [{ config: null, status: 'signed_out', path: '/' }, 'loading'],
    [{ config: null, status: 'unknown', path: '/' }, 'loading'],
    [{ config: null, configError: true, status: 'unknown', path: '/' }, 'error'],
    [{ config: off, configError: true, status: 'signed_out', path: '/' }, 'error'],
    [{ config: off, status: 'signed_out', path: '/' }, 'allow'],
    [{ config: off, status: 'signed_in', path: '/' }, 'allow'],
    [{ config: on, status: 'unknown', path: '/' }, 'loading'],
    [{ config: on, status: 'signed_out', path: '/' }, 'login'],
    [{ config: on, status: 'signed_in', path: '/' }, 'allow'],
    [{ config: on, status: 'signed_out', path: '/login' }, 'allow'],
    [{ config: on, status: 'unknown', path: '/login' }, 'allow'],
    [{ config: null, status: 'unknown', path: '/login' }, 'allow'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(routeDecision(input), expected, JSON.stringify(input))
  }
})

test('safeNext keeps same-site paths', () => {
  assert.equal(safeNext('/deploys/3'), '/deploys/3')
  assert.equal(safeNext('/accounts?connected=github'), '/accounts?connected=github')
  assert.equal(safeNext('/'), '/')
})

test('safeNext blocks open redirects and /login', () => {
  const bad = [
    '', null, undefined, 5, {}, [], 'deploys', '//evil.example', '/\\evil', '\\\\evil',
    'https://evil.example', 'http://evil.example/x', 'javascript:alert(1)', '/\t/evil.example', '/\n/evil.example',
    '/login', '/login?next=/', '/login/', '/LOGIN', '/login#x',
  ]
  for (const value of bad) assert.equal(safeNext(value), '/', String(value))
  assert.equal(safeNext('/loginx'), '/loginx')
})

test('loginErrorText: server detail, network, default', () => {
  const forbidden = Object.assign(new Error('로그인이 허용된 계정이 아닙니다'), { status: 403 })
  assert.equal(loginErrorText(forbidden), '로그인이 허용된 계정이 아닙니다')
  const unavailable = Object.assign(new Error('지금은 로그인을 사용할 수 없습니다'), { status: 503 })
  assert.equal(loginErrorText(unavailable), '지금은 로그인을 사용할 수 없습니다')
  const offline = Object.assign(new Error(NETWORK_ERROR_TEXT), { status: 0 })
  assert.equal(loginErrorText(offline), NETWORK_ERROR_TEXT)
  const fallback = '로그인하지 못했습니다. 잠시 뒤 다시 시도해 주세요'
  assert.equal(loginErrorText(Object.assign(new Error('요청 실패 (500)'), { status: 500 })), fallback)
  assert.equal(loginErrorText({ status: 500 }), fallback)
  assert.equal(loginErrorText(null), fallback)
  assert.equal(loginErrorText(new Error('Failed to fetch')), fallback)
})

// 가짜 저장소 - 값 맵과 호출 기록
const fakeStorage = (initial, { throwOn } = {}) => {
  const data = new Map(Object.entries(initial))
  return {
    data,
    removeItem(key) {
      if (throwOn === key || throwOn === '*') throw new Error('blocked')
      data.delete(key)
    },
  }
}

test('clearUserScopedStorage removes only the two user-scoped keys', () => {
  const storage = fakeStorage({ 'dw-picked-block': '3', [HAD_SESSION_KEY]: '1', 'dw-other': 'keep', 'dw-push-device': 'x' })
  clearUserScopedStorage(storage)
  assert.deepEqual([...storage.data.keys()].sort(), ['dw-other', 'dw-push-device'])
  assert.equal(HAD_SESSION_KEY, 'dw-had-session')
})

test('clearUserScopedStorage never throws and still clears the other key', () => {
  const storage = fakeStorage({ 'dw-picked-block': '3', [HAD_SESSION_KEY]: '1' }, { throwOn: 'dw-picked-block' })
  assert.doesNotThrow(() => clearUserScopedStorage(storage))
  assert.equal(storage.data.has(HAD_SESSION_KEY), false)
  assert.doesNotThrow(() => clearUserScopedStorage(fakeStorage({ a: '1' }, { throwOn: '*' })))
  assert.doesNotThrow(() => clearUserScopedStorage(undefined))
  assert.doesNotThrow(() => clearUserScopedStorage(null))
  assert.doesNotThrow(() => clearUserScopedStorage({}))
})

const realFetch = globalThis.fetch
let calls

// 가짜 응답을 만든다
const answer = (status, body) => ({
  status, ok: status >= 200 && status < 300,
  json: async () => body,
})

beforeEach(() => {
  calls = []
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return answer(200, {}) }
  session.resetSessionForTest()
})
afterEach(() => { globalThis.fetch = realFetch })

test('authApi: request shapes', async () => {
  await authApi.getConfig()
  await authApi.loginGoogle('t')
  await authApi.refresh()
  await authApi.logout()
  await authApi.getMe()
  await authApi.deleteMe()
  await authApi.listTokens()
  await authApi.createToken({ name: 'mcp', expires_in_days: 30 })
  await authApi.revokeToken(7)

  const [config, google, refresh, logout, me, del, list, create, revoke] = calls
  assert.equal(config.url, '/api/auth/config')
  assert.equal(config.options.method ?? 'GET', 'GET')
  assert.equal(google.url, '/api/auth/google')
  assert.equal(google.options.method, 'POST')
  assert.deepEqual(JSON.parse(google.options.body), { id_token: 't', platform: 'web' })
  assert.equal(refresh.url, '/api/auth/refresh')
  assert.equal(refresh.options.method, 'POST')
  assert.equal(refresh.options.body, undefined)
  assert.equal(logout.url, '/api/auth/logout')
  assert.equal(logout.options.method, 'POST')
  assert.equal(me.url, '/api/me')
  assert.equal(del.url, '/api/me')
  assert.equal(del.options.method, 'DELETE')
  assert.deepEqual(JSON.parse(del.options.body), { confirm: true })
  assert.equal(list.url, '/api/auth/tokens')
  assert.equal(create.url, '/api/auth/tokens')
  assert.equal(create.options.method, 'POST')
  assert.deepEqual(JSON.parse(create.options.body), { name: 'mcp', expires_in_days: 30 })
  assert.equal(revoke.url, '/api/auth/tokens/7')
  assert.equal(revoke.options.method, 'DELETE')
})

test('authApi: the four public calls never send Authorization, even when signed in', async () => {
  session.setSession({ access_token: 'SECRET', user: { u_id: 1 }, expires_in: 900 })
  await authApi.getConfig()
  await authApi.loginGoogle('t')
  await authApi.refresh()
  await authApi.logout()
  assert.equal(calls.length, 4)
  for (const call of calls) assert.equal(call.options.headers.Authorization, undefined, call.url)
  // 로그인한 상태의 보호 호출에는 붙는다
  await authApi.getMe()
  assert.equal(calls[4].options.headers.Authorization, 'Bearer SECRET')
})

test('authApi: a 401 from a public call does not trigger a refresh', async () => {
  let refreshCalls = 0
  session.setRefresher(async () => { refreshCalls += 1; return { access_token: 'N', user: null, expires_in: 900 } })
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return answer(401, { detail: '로그인이 필요합니다' }) }
  await assert.rejects(authApi.loginGoogle('t'), (e) => e.status === 401)
  assert.equal(refreshCalls, 0)
  assert.equal(calls.length, 1)
})

const LIVE_TEXT = '먼저 멈추거나 삭제해야 하는 서비스가 있습니다: #3 my-app, #5 other'

test('parseLiveDeploys: splits the server 409 sentence into message and items', () => {
  const out = parseLiveDeploys(LIVE_TEXT)
  assert.equal(out.message, '먼저 멈추거나 삭제해야 하는 서비스가 있습니다')
  assert.deepEqual(out.items, [{ d_id: 3, label: 'my-app' }, { d_id: 5, label: 'other' }])
})

test('parseLiveDeploys: a repo url without spaces or commas is the label', () => {
  const out = parseLiveDeploys('먼저 멈추거나 삭제해야 하는 서비스가 있습니다: #7 https://github.com/a/b')
  assert.deepEqual(out.items, [{ d_id: 7, label: 'https://github.com/a/b' }])
})

test('parseLiveDeploys: unknown formats degrade to no items and the raw text', () => {
  for (const raw of ['서비스가 있습니다', '먼저 멈추세요: my-app, other', '문구: #x name', '문구: #3', '문구: #3 a, b', '문구: #0 zero', '문구: #3 a,#5 b']) {
    const out = parseLiveDeploys(raw)
    assert.deepEqual(out.items, [], raw)
    assert.equal(out.message, raw)
  }
})

test('parseLiveDeploys: non-string input gives an empty message and no items', () => {
  for (const raw of [undefined, null, 5, { a: 1 }, ['x']]) {
    assert.deepEqual(parseLiveDeploys(raw), { message: '', items: [] })
  }
})

test('deleteResultView: message as is and the repository list', () => {
  const out = deleteResultView({ message: '계정을 삭제했습니다.', leftover_ecr_repositories: ['a', 'b'], deleted: { deploys: 1 } })
  assert.deepEqual(out, { message: '계정을 삭제했습니다.', leftovers: ['a', 'b'] })
})

test('deleteResultView: duplicate repository names are listed once (React keys stay unique)', () => {
  assert.deepEqual(deleteResultView({ message: 'm', leftover_ecr_repositories: ['a', 'b', 'a', ' b '] }).leftovers, ['a', 'b'])
})

test('parseLiveDeploys: a repeated d_id is listed once', () => {
  const out = parseLiveDeploys('먼저 멈춰야 합니다: #3 my-app, #5 other, #3 my-app')
  assert.deepEqual(out.items, [{ d_id: 3, label: 'my-app' }, { d_id: 5, label: 'other' }])
})

test('topbarNavVisible: only when signed in or the server does not require login', () => {
  assert.equal(topbarNavVisible({ config: { auth_required: true }, status: 'signed_in' }), true)
  assert.equal(topbarNavVisible({ config: { auth_required: false }, status: 'signed_out' }), true)
  assert.equal(topbarNavVisible({ config: { auth_required: true }, status: 'signed_out' }), false)
  assert.equal(topbarNavVisible({ config: { auth_required: true }, status: 'unknown' }), false)
  assert.equal(topbarNavVisible({ config: null, status: 'signed_out' }), false)
  assert.equal(topbarNavVisible({ config: null, status: 'signed_in' }), true)
})

test('retryServerLogout: true when the server call works, false when it fails', async () => {
  let calls = 0
  assert.equal(await retryServerLogout(async () => { calls += 1 }), true)
  assert.equal(await retryServerLogout(async () => { throw new Error('down') }), false)
  assert.equal(await retryServerLogout(() => { throw new Error('sync') }), false)
  assert.equal(calls, 1)
})

test('deleteResultView: no list, a non-array, junk entries and null all degrade safely', () => {
  assert.deepEqual(deleteResultView({ message: 'm' }), { message: 'm', leftovers: [] })
  assert.deepEqual(deleteResultView({ message: 'm', leftover_ecr_repositories: 'a' }), { message: 'm', leftovers: [] })
  assert.deepEqual(deleteResultView({ message: 'm', leftover_ecr_repositories: ['a', '', 3, null, ' '] }), { message: 'm', leftovers: ['a'] })
  assert.deepEqual(deleteResultView(null), { message: '계정을 삭제했습니다', leftovers: [] })
  assert.deepEqual(deleteResultView(undefined), { message: '계정을 삭제했습니다', leftovers: [] })
})

test('safePictureUrl: only https urls are shown', () => {
  assert.equal(safePictureUrl('https://lh3.googleusercontent.com/a/x=s96'), 'https://lh3.googleusercontent.com/a/x=s96')
  for (const bad of ['http://x/y.png', 'javascript:alert(1)', 'data:image/png;base64,AA', '//x/y', '', null, undefined, 5]) {
    assert.equal(safePictureUrl(bad), null, String(bad))
  }
})

test('loginPathFor: the current path is encoded exactly once', () => {
  assert.equal(loginPathFor('/me'), '/login?next=%2Fme')
  assert.equal(loginPathFor('/deploys/3?tab=a&b=1#x'), '/login?next=' + encodeURIComponent('/deploys/3?tab=a&b=1#x'))
  assert.equal(loginPathFor('/deploys/3?tab=a&b=1#x').includes('%25'), false)
})

test('authNavLinkView: signed in shows 내 정보, login link only when login is available, otherwise nothing', () => {
  const on = { ...CONFIG_OFF, login_available: true }
  assert.deepEqual(authNavLinkView({ config: on, status: 'signed_in', path: '/' }), { label: '내 정보', to: '/me' })
  assert.deepEqual(authNavLinkView({ config: CONFIG_OFF, status: 'signed_in', path: '/' }), { label: '내 정보', to: '/me' })
  assert.deepEqual(authNavLinkView({ config: on, status: 'signed_out', path: '/accounts?x=1' }), { label: '로그인', to: '/login?next=' + encodeURIComponent('/accounts?x=1') })
  assert.equal(authNavLinkView({ config: CONFIG_OFF, status: 'signed_out', path: '/' }), null)
  assert.equal(authNavLinkView({ config: null, status: 'signed_out', path: '/' }), null)
  assert.equal(authNavLinkView({ config: on, status: 'unknown', path: '/' }), null)
})

test('meViewState: result screens first, then hold, error, loading, redirect, ready', () => {
  const on = { ...CONFIG_OFF, auth_required: true, login_available: true }
  const base = { config: on, configError: false, status: 'signed_in', ended: false, hold: false }
  assert.deepEqual(meViewState(base), { kind: 'ready' })
  // 결과 화면은 세션이 없어도, 연결 오류가 있어도 보인다
  assert.deepEqual(meViewState({ ...base, status: 'signed_out', ended: true }), { kind: 'ended' })
  assert.deepEqual(meViewState({ ...base, status: 'signed_out', configError: true, ended: true }), { kind: 'ended' })
  assert.deepEqual(meViewState({ ...base, status: 'signed_out', hold: true }), { kind: 'hold' })
  assert.deepEqual(meViewState({ ...base, configError: true }), { kind: 'error' })
  assert.deepEqual(meViewState({ ...base, config: null }), { kind: 'loading' })
  assert.deepEqual(meViewState({ ...base, status: 'unknown' }), { kind: 'loading' })
  assert.deepEqual(meViewState({ ...base, status: 'signed_out' }), { kind: 'redirect', to: '/login?next=%2Fme' })
})

test('meViewState: signed out in off mode goes to login when possible, else home', () => {
  const base = { configError: false, status: 'signed_out', ended: false, hold: false }
  assert.deepEqual(meViewState({ ...base, config: { ...CONFIG_OFF, login_available: true } }), { kind: 'redirect', to: '/login?next=%2Fme' })
  assert.deepEqual(meViewState({ ...base, config: CONFIG_OFF }), { kind: 'redirect', to: '/' })
  // 로그인이 필요한 서버면 로그인을 못 해도 로그인 화면이 사정을 알려 준다
  assert.deepEqual(meViewState({ ...base, config: { ...CONFIG_OFF, auth_required: true } }), { kind: 'redirect', to: '/login?next=%2Fme' })
})

test('afterLogoutPath: login screen when login is required, home in off mode', () => {
  assert.equal(afterLogoutPath({ ...CONFIG_OFF, auth_required: true }), '/login')
  assert.equal(afterLogoutPath({ ...CONFIG_OFF, login_available: true }), '/')
  assert.equal(afterLogoutPath(CONFIG_OFF), '/')
  assert.equal(afterLogoutPath(null), '/')
})

test('runSignOut: server logout ok reports true and clears both local things', async () => {
  const seen = []
  const out = await runSignOut({ logout: async () => seen.push('logout'), clearSession: () => seen.push('session'), clearStorage: () => seen.push('storage') })
  assert.deepEqual(out, { serverLoggedOut: true })
  assert.deepEqual(seen, ['logout', 'session', 'storage'])
})

test('runSignOut: a failing server logout is tolerated and reported, local sign-out still happens', async () => {
  const seen = []
  const out = await runSignOut({
    logout: async () => { throw new Error('offline') },
    clearSession: () => seen.push('session'),
    clearStorage: () => seen.push('storage'),
  })
  assert.deepEqual(out, { serverLoggedOut: false })
  assert.deepEqual(seen, ['session', 'storage'])
})

const PAT_CFG = { pat_default_days: 30, pat_max_days: 90 }

test('validateTokenForm: trims the name, blank days means the server default (no expires_in_days)', () => {
  assert.deepEqual(validateTokenForm({ name: ' mcp ', days: '' }, PAT_CFG), { body: { name: 'mcp' }, error: null })
  assert.deepEqual(validateTokenForm({ name: 'mcp', days: '   ' }, PAT_CFG), { body: { name: 'mcp' }, error: null })
  assert.equal('expires_in_days' in validateTokenForm({ name: 'mcp', days: '' }, PAT_CFG).body, false)
})

test('validateTokenForm: name must be 1-50 characters after trimming', () => {
  const NAME_ERROR = '이름은 1~50자로 적어 주세요'
  assert.deepEqual(validateTokenForm({ name: '', days: '' }, PAT_CFG), { body: null, error: NAME_ERROR })
  assert.deepEqual(validateTokenForm({ name: '   ', days: '' }, PAT_CFG), { body: null, error: NAME_ERROR })
  assert.deepEqual(validateTokenForm({ name: 'a'.repeat(51), days: '' }, PAT_CFG), { body: null, error: NAME_ERROR })
  assert.equal(validateTokenForm({ name: 'a'.repeat(50), days: '' }, PAT_CFG).error, null)
  assert.equal(validateTokenForm({ name: ` ${'가'.repeat(50)} `, days: '' }, PAT_CFG).error, null)
  assert.equal(validateTokenForm({ name: '가'.repeat(51), days: '' }, PAT_CFG).error, NAME_ERROR)
  assert.equal(validateTokenForm({ name: undefined, days: '' }, PAT_CFG).error, NAME_ERROR)
})

test('validateTokenForm: days must be an integer from 1 to pat_max_days', () => {
  const DAYS_ERROR = '기간은 1~90일입니다'
  for (const bad of ['0', '91', '1.5', 'abc', '-3', '1e1', '+5', '０', '9'.repeat(30)]) {
    assert.deepEqual(validateTokenForm({ name: 'mcp', days: bad }, PAT_CFG), { body: null, error: DAYS_ERROR }, bad)
  }
  assert.deepEqual(validateTokenForm({ name: 'mcp', days: '90' }, PAT_CFG), { body: { name: 'mcp', expires_in_days: 90 }, error: null })
  assert.deepEqual(validateTokenForm({ name: 'mcp', days: ' 1 ' }, PAT_CFG), { body: { name: 'mcp', expires_in_days: 1 }, error: null })
  assert.equal(validateTokenForm({ name: 'mcp', days: '31' }, { pat_default_days: 7, pat_max_days: 30 }).error, '기간은 1~30일입니다')
})

test('validateTokenForm: a missing config falls back to the default max of 90 days', () => {
  assert.equal(validateTokenForm({ name: 'mcp', days: '91' }, undefined).error, '기간은 1~90일입니다')
  assert.equal(validateTokenForm({ name: 'mcp', days: '90' }, {}).error, null)
})

test('tokenExpiryText: remaining days (rounded up), expired, never', () => {
  const now = Date.parse('2026-11-17T12:00:00Z')
  // 서버는 UTC 를 Z 없이 보낸다
  assert.equal(tokenExpiryText('2026-12-17T12:00:00', now), '2026년 12월 17일까지 (30일 남음)')
  assert.equal(tokenExpiryText('2026-12-17T12:00:00Z', now), '2026년 12월 17일까지 (30일 남음)')
  assert.equal(tokenExpiryText('2026-12-17T11:59:59.123456', now), '2026년 12월 17일까지 (30일 남음)')
  // 1초라도 남았으면 1일 (올림)
  assert.equal(tokenExpiryText('2026-11-17T12:00:01', now), '2026년 11월 17일까지 (1일 남음)')
  assert.equal(tokenExpiryText('2026-11-18T12:00:01', now), '2026년 11월 18일까지 (2일 남음)')
  assert.equal(tokenExpiryText('2026-11-18T12:00:00', now), '2026년 11월 18일까지 (1일 남음)')
  // Date 로 넘겨도 같다
  assert.equal(tokenExpiryText('2026-12-17T12:00:00', new Date(now)), '2026년 12월 17일까지 (30일 남음)')
})

test('tokenExpiryText: past or equal is expired, null is never, unreadable is explained', () => {
  const now = Date.parse('2026-11-17T12:00:00Z')
  assert.equal(tokenExpiryText('2026-11-17T12:00:00', now), '만료됨')
  assert.equal(tokenExpiryText('2026-11-17T11:59:59', now), '만료됨')
  assert.equal(tokenExpiryText('2020-01-01T00:00:00', now), '만료됨')
  assert.equal(tokenExpiryText(null, now), '만료 없음')
  assert.equal(tokenExpiryText(undefined, now), '만료 없음')
  assert.equal(tokenExpiryText('not a date', now), '만료일을 읽을 수 없습니다')
})

test('mcpEnvLine: WIZARD_API_TOKEN=<token>', () => {
  assert.equal(mcpEnvLine('dwp_abc123'), 'WIZARD_API_TOKEN=dwp_abc123')
})

test('copyText: true when the clipboard accepts the text, false when missing or rejecting', async () => {
  const seen = []
  assert.equal(await copyText('hello', { writeText: async (t) => { seen.push(t) } }), true)
  assert.deepEqual(seen, ['hello'])
  assert.equal(await copyText('hello', { writeText: async () => { throw new Error('denied') } }), false)
  assert.equal(await copyText('hello', { writeText: () => { throw new Error('sync') } }), false)
  assert.equal(await copyText('hello', undefined), false)
  assert.equal(await copyText('hello', {}), false)
})
