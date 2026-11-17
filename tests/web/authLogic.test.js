import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import './useAlias.mjs'

const { normalizeConfig, CONFIG_OFF, routeDecision, safeNext, loginErrorText } = await import('../../features/auth/ui/authLogic.js')
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
