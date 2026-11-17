import test, { beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import './useAlias.mjs'

const { request, onUnauthorized, resetUnauthorizedForTest, UNAUTHORIZED_THROTTLE_MS } = await import('../../shared/ui/api.js')
const session = await import('../../shared/ui/session.js')

const realFetch = globalThis.fetch
let status

// 가짜 응답을 만든다
const answer = (code, body) => ({ status: code, ok: code >= 200 && code < 300, json: async () => body })

// 지연된 알림이 끝나도록 한 틱 기다린다
const settle = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  status = 401
  globalThis.fetch = async () => answer(status, { detail: '로그인이 필요합니다' })
  session.resetSessionForTest()
  resetUnauthorizedForTest()
})
afterEach(() => {
  globalThis.fetch = realFetch
  mock.restoreAll()
})

test('401 on a token-less request while signed_out fires the handler once and keeps the original error', async () => {
  session.markBooted('signed_out')
  let fired = 0
  onUnauthorized(() => { fired += 1 })
  await assert.rejects(request('/api/deploys'), (e) => e.status === 401 && e.message === '로그인이 필요합니다')
  await settle()
  assert.equal(fired, 1)
})

test('throttled to one call per 5 seconds, then fires again', async () => {
  session.markBooted('signed_out')
  let now = 1_000_000
  mock.method(Date, 'now', () => now)
  let fired = 0
  onUnauthorized(async () => { fired += 1 })
  for (let i = 0; i < 5; i += 1) await request('/api/deploys').catch(() => {})
  await settle()
  assert.equal(fired, 1)
  now += UNAUTHORIZED_THROTTLE_MS - 1
  await request('/api/deploys').catch(() => {})
  await settle()
  assert.equal(fired, 1)
  now += 2
  await request('/api/deploys').catch(() => {})
  await settle()
  assert.equal(fired, 2)
})

test('never concurrent: a still-running handler blocks another call even after the throttle window', async () => {
  session.markBooted('signed_out')
  let now = 1_000_000
  mock.method(Date, 'now', () => now)
  let fired = 0
  let release
  onUnauthorized(() => { fired += 1; return new Promise((resolve) => { release = resolve }) })
  await request('/api/deploys').catch(() => {})
  now += UNAUTHORIZED_THROTTLE_MS * 3
  await request('/api/deploys').catch(() => {})
  assert.equal(fired, 1)
  release()
  await settle()
  await request('/api/deploys').catch(() => {})
  assert.equal(fired, 2)
})

test('a failing handler does not break the request or later calls', async () => {
  session.markBooted('signed_out')
  let now = 1_000_000
  mock.method(Date, 'now', () => now)
  let fired = 0
  onUnauthorized(async () => { fired += 1; throw new Error('boom') })
  await assert.rejects(request('/api/deploys'), (e) => e.status === 401)
  await settle()
  now += UNAUTHORIZED_THROTTLE_MS
  await request('/api/deploys').catch(() => {})
  assert.equal(fired, 2)
})

test('unsubscribe stops notifications', async () => {
  session.markBooted('signed_out')
  let fired = 0
  const off = onUnauthorized(() => { fired += 1 })
  off()
  await request('/api/deploys').catch(() => {})
  assert.equal(fired, 0)
})

test('does not fire when the request carried a token, for public calls, or for non-401 answers', async () => {
  let fired = 0
  onUnauthorized(() => { fired += 1 })
  // 토큰을 보낸 요청은 갱신 경로로 간다
  session.setSession({ access_token: 'T', user: { u_id: 1 }, expires_in: 900 })
  session.setRefresher(async () => { throw Object.assign(new Error('x'), { status: 401 }) })
  await request('/api/deploys').catch(() => {})
  // 공개 호출(auth:false)
  await request('/api/auth/google', { auth: false }).catch(() => {})
  // 401 이 아닌 응답
  session.clearSession('logout')
  status = 500
  await request('/api/deploys').catch(() => {})
  await settle()
  assert.equal(fired, 0)
})
