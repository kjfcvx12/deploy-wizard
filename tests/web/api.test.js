import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import './useAlias.mjs'

const { request, NETWORK_ERROR_TEXT, AUTH_NO_RETRY_PATHS } = await import('../../shared/ui/api.js')
const session = await import('../../shared/ui/session.js')
const { deployApi } = await import('../../features/deploys/ui/api.js')
const { incidentApi } = await import('../../features/incidents/ui/api.js')
const { notificationApi } = await import('../../features/notifications/ui/api.js')

const realFetch = globalThis.fetch
let calls
let reply

// 가짜 응답을 만든다
const answer = (status, body) => ({
  status, ok: status >= 200 && status < 300,
  json: async () => { if (body === undefined) throw new Error('not json'); return body },
})

beforeEach(() => {
  calls = []
  reply = answer(200, {})
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return reply }
  session.resetSessionForTest()
})
afterEach(() => { globalThis.fetch = realFetch })

test('request: 404 throws Error with status and server detail', async () => {
  reply = answer(404, { detail: '해당 id의 인시던트가 없습니다' })
  await assert.rejects(request('/api/incidents/99'), (e) => {
    assert.ok(e instanceof Error)
    assert.equal(e.status, 404)
    assert.equal(e.message, '해당 id의 인시던트가 없습니다')
    return true
  })
})

test('request: non-JSON error still has status', async () => {
  reply = answer(502, undefined)
  await assert.rejects(request('/x'), (e) => e.status === 502 && e.message === '요청 실패 (502)')
})

test('request: 422 array detail joined', async () => {
  reply = answer(422, { detail: [{ msg: 'a' }, { msg: 'b' }] })
  await assert.rejects(request('/x'), (e) => e.status === 422 && e.message === 'a, b')
})

test('request: fetch rejection becomes Korean message with status 0', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  await assert.rejects(request('/api/deploys'), (e) => {
    assert.ok(e instanceof Error)
    assert.equal(e.status, 0)
    assert.equal(e.message, NETWORK_ERROR_TEXT)
    assert.match(e.message, /서버에 연결할 수 없습니다/)
    assert.doesNotMatch(e.message, /Failed to fetch/)
    return true
  })
})

test('request: 5xx JSON body without detail falls back to status text', async () => {
  reply = answer(500, { error: 'boom' })
  await assert.rejects(request('/x'), (e) => e.status === 500 && e.message === '요청 실패 (500)')
})

test('request: 204 gives null', async () => {
  reply = answer(204, undefined)
  assert.equal(await request('/x'), null)
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 호출 순서대로 다른 응답을 준다 (마지막 응답은 계속 반복)
const replies = (...list) => {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return list.length > 1 ? list.shift() : list[0]
  }
}

// 토큰에 따라 401/200 을 고르는 가짜 서버
const serverAccepting = (good) => {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return options.headers.Authorization === `Bearer ${good}` ? answer(200, { ok: url }) : answer(401, { detail: '로그인이 필요합니다' })
  }
}

test('request: no token no Authorization header', async () => {
  await request('/api/deploys')
  await request('/api/deploys', { method: 'POST', body: { a: 1 } })
  assert.deepEqual(calls[0].options.headers, { 'Content-Type': 'application/json' })
  assert.deepEqual(calls[1].options.headers, { 'Content-Type': 'application/json' })
  assert.equal('auth' in calls[1].options, false)
})

test('request: no token 401 without refresher throws original', async () => {
  reply = answer(401, { detail: '로그인이 필요합니다' })
  await assert.rejects(request('/api/deploys'), (e) => e.status === 401 && e.message === '로그인이 필요합니다')
  assert.equal(calls.length, 1)
})

test('signed_out user: 401 does not call refresher', async () => {
  session.markBooted('signed_out')
  let refreshes = 0
  session.setRefresher(async () => { refreshes += 1; return { access_token: 'A2', user: {}, expires_in: 900 } })
  const seen = []
  session.subscribeSession((state) => seen.push(state))
  reply = answer(401, { detail: '로그인이 필요합니다' })
  await assert.rejects(request('/api/deploys'), (e) => e.status === 401 && e.message === '로그인이 필요합니다')
  assert.equal(refreshes, 0)
  assert.equal(calls.length, 1)
  assert.equal(seen.length, 0)
  assert.equal(session.getSessionStatus(), 'signed_out')
})

test('unknown status 401 still tries cookie refresh', async () => {
  let refreshes = 0
  session.setRefresher(async () => { refreshes += 1; return { access_token: 'A2', user: { u_id: 1 }, expires_in: 900 } })
  replies(answer(401, { detail: '만료' }), answer(200, { v: 2 }))
  assert.deepEqual(await request('/api/deploys'), { v: 2 })
  assert.equal(refreshes, 1)
  assert.equal(calls[1].options.headers.Authorization, 'Bearer A2')
})

test('request: bearer attached and headers merged', async () => {
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  await request('/api/deploys', { method: 'POST', body: { a: 1 }, headers: { 'X-Test': 'y' } })
  assert.deepEqual(calls[0].options.headers, {
    'Content-Type': 'application/json', Authorization: 'Bearer A1', 'X-Test': 'y',
  })
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.body, JSON.stringify({ a: 1 }))
})

test('request: auth false sends no Authorization', async () => {
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  let refreshes = 0
  session.setRefresher(async () => { refreshes += 1; return { access_token: 'A2', user: {}, expires_in: 900 } })
  reply = answer(401, { detail: 'x' })
  await assert.rejects(request('/api/anything', { auth: false }), (e) => e.status === 401)
  assert.equal(calls[0].options.headers.Authorization, undefined)
  assert.equal('auth' in calls[0].options, false)
  assert.equal(refreshes, 0)
})

test('request: 401 refreshes then retries once', async () => {
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  let refreshes = 0
  session.setRefresher(async () => { refreshes += 1; return { access_token: 'A2', user: { u_id: 1 }, expires_in: 900 } })
  replies(answer(401, { detail: '만료' }), answer(200, { v: 1 }))
  assert.deepEqual(await request('/api/deploys'), { v: 1 })
  assert.equal(calls.length, 2)
  assert.equal(refreshes, 1)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer A1')
  assert.equal(calls[1].options.headers.Authorization, 'Bearer A2')
})

test('request: 401 after retry is thrown', async () => {
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  let refreshes = 0
  session.setRefresher(async () => { refreshes += 1; return { access_token: 'A2', user: { u_id: 1 }, expires_in: 900 } })
  reply = answer(401, { detail: '권한 없음' })
  await assert.rejects(request('/api/deploys'), (e) => e.status === 401 && e.message === '권한 없음')
  assert.equal(calls.length, 2)
  assert.equal(refreshes, 1)
})

test('request: failed refresh throws original 401 and signs out', async () => {
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  session.setRefresher(async () => { throw Object.assign(new Error('refresh 거절'), { status: 401 }) })
  reply = answer(401, { detail: '원래 오류' })
  await assert.rejects(request('/api/deploys'), (e) => e.status === 401 && e.message === '원래 오류')
  assert.equal(calls.length, 1)
  assert.equal(session.getSessionStatus(), 'signed_out')
})

test('request: offline refresh keeps session', async () => {
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  session.setRefresher(async () => { throw Object.assign(new Error(NETWORK_ERROR_TEXT), { status: 0 }) })
  reply = answer(401, { detail: '만료' })
  await assert.rejects(request('/api/deploys'), (e) => e.status === 0)
  assert.equal(session.getAccessToken(), 'A1')
  assert.equal(session.getSessionStatus(), 'signed_in')
})

test('request: auth paths never refresh', async () => {
  assert.deepEqual([...AUTH_NO_RETRY_PATHS].sort(), ['/api/auth/config', '/api/auth/google', '/api/auth/logout', '/api/auth/refresh'])
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  let refreshes = 0
  session.setRefresher(async () => { refreshes += 1; return { access_token: 'A2', user: {}, expires_in: 900 } })
  reply = answer(401, { detail: '거절' })
  for (const path of AUTH_NO_RETRY_PATHS) {
    await assert.rejects(request(path, { method: 'POST' }), (e) => e.status === 401)
    await assert.rejects(request(`${path}?x=1`), (e) => e.status === 401)
  }
  assert.equal(refreshes, 0)
  assert.equal(calls.length, AUTH_NO_RETRY_PATHS.length * 2)
})

test('request: five concurrent 401 share one refresh', async () => {
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  let refreshes = 0
  session.setRefresher(async () => { refreshes += 1; await wait(30); return { access_token: 'A2', user: { u_id: 1 }, expires_in: 900 } })
  serverAccepting('A2')
  const paths = ['/a', '/b', '/c', '/d', '/e']
  const results = await Promise.all(paths.map((p) => request(p)))
  assert.deepEqual(results, paths.map((p) => ({ ok: p })))
  assert.equal(refreshes, 1)
  assert.equal(calls.length, 10)
})

test('request: stale 401 after another refresh retries without refreshing again', async () => {
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  let refreshes = 0
  session.setRefresher(async () => { refreshes += 1; return { access_token: 'A2', user: { u_id: 1 }, expires_in: 900 } })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    if (url === '/slow' && options.headers.Authorization === 'Bearer A1') await gate
    return options.headers.Authorization === 'Bearer A2' ? answer(200, { ok: url }) : answer(401, { detail: '만료' })
  }
  const slow = request('/slow')
  assert.deepEqual(await request('/fast'), { ok: '/fast' })
  release()
  assert.deepEqual(await slow, { ok: '/slow' })
  assert.equal(refreshes, 1)
})

test('deployApi settings and health history', async () => {
  await deployApi.patchSettings(2, { auto_recover: false })
  assert.equal(calls[0].url, '/api/deploys/2/settings')
  assert.equal(calls[0].options.method, 'PATCH')
  assert.equal(calls[0].options.body, JSON.stringify({ auto_recover: false }))
  await deployApi.getHealthHistory(2)
  assert.equal(calls[1].url, '/api/deploys/2/health-history?hours=24')
  await deployApi.getHealthHistory(2, 6)
  assert.equal(calls[2].url, '/api/deploys/2/health-history?hours=6')
})

test('deployApi.create: 옵션 없이는 기존과 같은 본문', async () => {
  await deployApi.create('https://github.com/a/b', 'main', 3, 5)
  assert.equal(calls[0].url, '/api/deploys')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.body, JSON.stringify({
    repo_url: 'https://github.com/a/b', branch: 'main', aws_account_id: 3, github_installation_id: 5,
  }))
  await deployApi.create('https://github.com/a/b', '', '', '')
  assert.equal(calls[1].options.body, JSON.stringify({
    repo_url: 'https://github.com/a/b', branch: null, aws_account_id: null, github_installation_id: null,
  }))
  await deployApi.create('https://github.com/a/b', 'main', 3, 5, {})
  assert.equal(calls[2].options.body, calls[0].options.body)
  await deployApi.create('https://github.com/a/b', 'main', 3, 5, null)
  assert.equal(calls[3].options.body, calls[0].options.body)
})

test('deployApi.create: 옵션은 서버 필드 이름 그대로 병합', async () => {
  const options = {
    cpu: '1024', memory: '2048', planned_hours: 8,
    min_tasks: 1, max_tasks: 3, scale_metric: 'AVERAGE_CPU', scale_target: 70,
  }
  await deployApi.create('https://github.com/a/b', 'main', 3, 5, options)
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    repo_url: 'https://github.com/a/b', branch: 'main', aws_account_id: 3, github_installation_id: 5, ...options,
  })
  await deployApi.create('https://github.com/a/b', 'main', '', '', { planned_hours: 4 })
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    repo_url: 'https://github.com/a/b', branch: 'main', aws_account_id: null, github_installation_id: null, planned_hours: 4,
  })
})

test('incidentApi.getOne', async () => {
  await incidentApi.getOne(7)
  assert.equal(calls[0].url, '/api/incidents/7')
  assert.equal(calls[0].options.method, undefined)
})

test('notificationApi.getAll query parts only when set', async () => {
  await notificationApi.getAll()
  await notificationApi.getAll({})
  await notificationApi.getAll({ after: 50 })
  await notificationApi.getAll({ unread: true })
  await notificationApi.getAll({ after: 50, unread: true })
  await notificationApi.getAll({ unread: false, after: 0 })
  assert.deepEqual(calls.map((c) => c.url), [
    '/api/notifications', '/api/notifications', '/api/notifications?after=50', '/api/notifications?unread=true',
    '/api/notifications?after=50&unread=true', '/api/notifications?after=0',
  ])
})

test('notificationApi other endpoints', async () => {
  await notificationApi.getUnreadCount()
  await notificationApi.read(5)
  await notificationApi.readAll()
  await notificationApi.getSettings()
  await notificationApi.patchSettings({ notify_email: true })
  const [count, read, readAll, get, patch] = calls
  assert.equal(count.url, '/api/notifications/unread-count')
  assert.equal(read.url, '/api/notifications/5/read')
  assert.equal(read.options.method, 'POST')
  assert.equal(readAll.url, '/api/notifications/read-all')
  assert.equal(readAll.options.method, 'POST')
  assert.equal(get.url, '/api/notifications/settings')
  assert.equal(patch.url, '/api/notifications/settings')
  assert.equal(patch.options.method, 'PATCH')
  assert.equal(patch.options.body, JSON.stringify({ notify_email: true }))
})
