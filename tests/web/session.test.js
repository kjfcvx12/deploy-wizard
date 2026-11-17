import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { createTabSync } = await import('../../shared/ui/tabSync.js')
const session = await import('../../shared/ui/session.js')
const { createSession, resetSessionForTest } = session

// 이름별 Promise 사슬로 navigator.locks 를 흉내 낸다
const fakeLocks = () => {
  const tails = new Map()
  return {
    request(name, fn) {
      const prev = tails.get(name) || Promise.resolve()
      const run = prev.then(() => fn({ name }))
      tails.set(name, run.catch(() => {}))
      return run
    },
  }
}

// 두 인스턴스를 잇는 메모리 버스 - 보낸 쪽에는 돌아오지 않는다 (BroadcastChannel 과 같다)
const fakeBus = () => {
  const members = []
  const sent = []
  const make = () => {
    const listeners = new Set()
    const channel = {
      postMessage(data) {
        sent.push(data)
        for (const other of members) if (other !== channel) other.deliver(data)
      },
      addEventListener(type, fn) { if (type === 'message') listeners.add(fn) },
      removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn) },
      deliver(data) { for (const fn of listeners) fn({ data }) },
    }
    members.push(channel)
    return channel
  }
  return { make, sent }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 갱신기가 실패할 때 쓰는 오류
const failure = (status) => Object.assign(new Error(`실패 ${status}`), { status })

beforeEach(() => { resetSessionForTest() })

test('refresh single flight', async () => {
  let calls = 0
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  session.setRefresher(async () => { calls += 1; await wait(50); return { access_token: 'A2', user: { u_id: 1 }, expires_in: 900 } })
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => session.refreshSession()))
  assert.equal(calls, 1)
  assert.deepEqual(results, [true, true, true, true, true])
  assert.equal(session.getAccessToken(), 'A2')
  assert.equal(session.getSessionStatus(), 'signed_in')
})

test('refresh 401 clears session', async () => {
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  const seen = []
  session.subscribeSession((state) => seen.push(state))
  session.setRefresher(async () => { throw failure(401) })
  assert.equal(await session.refreshSession(), false)
  assert.equal(session.getSessionStatus(), 'signed_out')
  assert.equal(session.getAccessToken(), null)
  assert.equal(session.getSessionUser(), null)
  assert.equal(seen.at(-1).status, 'signed_out')
  assert.equal(seen.at(-1).reason, 'expired')
})

test('refresh 403 clears session too', async () => {
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  session.setRefresher(async () => { throw failure(403) })
  assert.equal(await session.refreshSession(), false)
  assert.equal(session.getSessionStatus(), 'signed_out')
})

test('refresh offline keeps session', async () => {
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  session.setRefresher(async () => { throw failure(0) })
  await assert.rejects(session.refreshSession(), (e) => e.status === 0)
  assert.equal(session.getAccessToken(), 'A1')
  assert.equal(session.getSessionStatus(), 'signed_in')
  session.setRefresher(async () => { throw failure(503) })
  await assert.rejects(session.refreshSession(), (e) => e.status === 503)
  assert.equal(session.getAccessToken(), 'A1')
})

test('refresh without refresher is false and keeps state', async () => {
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  assert.equal(await session.refreshSession(), false)
  assert.equal(session.getAccessToken(), 'A1')
})

test('two tabs refresh once', async () => {
  const locks = fakeLocks()
  const bus = fakeBus()
  const tabA = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  const tabB = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  let calls = 0
  let n = 1
  const refresher = async () => { calls += 1; await wait(30); n += 1; return { access_token: `A${n}`, user: { u_id: 1 }, expires_in: 900 } }
  tabA.setRefresher(refresher)
  tabB.setRefresher(refresher)
  const [a, b] = await Promise.all([tabA.refreshSession(), tabB.refreshSession()])
  assert.equal(calls, 1)
  assert.equal(a, true)
  assert.equal(b, true)
  assert.equal(tabA.getAccessToken(), 'A2')
  assert.equal(tabB.getAccessToken(), 'A2')
  assert.equal(tabB.getSessionStatus(), 'signed_in')
})

test('login in other tab during pending refresh is not logged out', async () => {
  const locks = fakeLocks()
  const bus = fakeBus()
  const tabA = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  const tabB = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  let reject
  tabA.setRefresher(() => new Promise((_, no) => { reject = no }))
  const pending = tabA.refreshSession()
  await wait(5)
  tabB.setSession({ access_token: 'B1', user: { u_id: 1 }, expires_in: 900 })
  assert.equal(tabA.getAccessToken(), 'B1')
  bus.sent.length = 0
  reject(failure(401))
  assert.equal(await pending, true)
  assert.equal(tabB.getSessionStatus(), 'signed_in')
  assert.equal(tabB.getAccessToken(), 'B1')
  assert.equal(tabA.getSessionStatus(), 'signed_in')
  assert.equal(bus.sent.filter((m) => m.type === 'signed_out').length, 0)
})

test('unknown status 401 refresh failing quietly', async () => {
  const locks = fakeLocks()
  const bus = fakeBus()
  const tabA = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  const tabB = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  const seen = []
  tabA.subscribeSession((state) => seen.push(state))
  tabA.setRefresher(async () => { throw failure(401) })
  assert.equal(tabA.getSessionStatus(), 'unknown')
  assert.equal(await tabA.refreshSession(), false)
  assert.equal(tabA.getSessionStatus(), 'signed_out')
  assert.deepEqual(seen, [{ status: 'signed_out', user: null }])
  assert.equal(bus.sent.length, 0)
  assert.equal(tabB.getSessionStatus(), 'unknown')
  // 이미 signed_out 이면 다시 알리지 않는다
  assert.equal(await tabA.refreshSession(), false)
  assert.equal(seen.length, 1)
  assert.equal(bus.sent.length, 0)
})

test('signed_in 401 refresh failing still expires', async () => {
  const locks = fakeLocks()
  const bus = fakeBus()
  const tabA = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  const tabB = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  tabA.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  const seen = []
  tabB.subscribeSession((state) => seen.push(state))
  bus.sent.length = 0
  tabA.setRefresher(async () => { throw failure(401) })
  assert.equal(await tabA.refreshSession(), false)
  assert.equal(tabA.getSessionStatus(), 'signed_out')
  assert.deepEqual(bus.sent, [{ type: 'signed_out', reason: 'expired' }])
  assert.equal(tabB.getSessionStatus(), 'signed_out')
  assert.equal(seen.at(-1).reason, 'expired')
})

test('signed_out broadcast', () => {
  const locks = fakeLocks()
  const bus = fakeBus()
  const tabA = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  const tabB = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  tabA.markBooted('signed_out')
  tabB.markBooted('signed_out')
  const seen = []
  tabB.subscribeSession((state) => seen.push(state))
  bus.sent.length = 0
  tabA.clearSession('logout')
  assert.equal(tabB.getSessionStatus(), 'signed_out')
  assert.equal(seen.at(-1).reason, 'logout')
  assert.equal(bus.sent.length, 1)
  assert.deepEqual(bus.sent[0], { type: 'signed_out', reason: 'logout' })
})

test('session broadcast reaches other tab without echo', () => {
  const locks = fakeLocks()
  const bus = fakeBus()
  const tabA = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  const tabB = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  tabA.setSession({ access_token: 'A9', user: { u_id: 3 }, expires_in: 900 })
  assert.equal(tabB.getAccessToken(), 'A9')
  assert.deepEqual(tabB.getSessionUser(), { u_id: 3 })
  assert.equal(bus.sent.length, 1)
  assert.equal(bus.sent[0].type, 'session')
})

test('setSession ignores refresh_token', () => {
  const locks = fakeLocks()
  const bus = fakeBus()
  const tabA = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  const tabB = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  const seen = []
  tabA.subscribeSession((state) => seen.push(state))
  tabB.subscribeSession((state) => seen.push(state))
  tabA.setSession({ access_token: 'A1', refresh_token: 'dwr_x', token_type: 'bearer', user: { u_id: 1 }, expires_in: 900 })
  const dump = JSON.stringify([
    tabA.getAccessToken(), tabA.getSessionUser(), tabA.getSessionStatus(),
    tabB.getAccessToken(), tabB.getSessionUser(), tabB.getSessionStatus(),
    seen, bus.sent,
  ])
  assert.doesNotMatch(dump, /dwr_x/)
  assert.equal(bus.sent.length, 1)
  assert.equal('refresh_token' in bus.sent[0], false)
})

test('subscribers never get the access token', () => {
  const seen = []
  session.subscribeSession((state) => seen.push(state))
  session.setSession({ access_token: 'secretA', user: { u_id: 1 }, expires_in: 900 })
  session.clearSession('logout')
  assert.doesNotMatch(JSON.stringify(seen), /secretA/)
  assert.deepEqual(seen.map((s) => s.status), ['signed_in', 'signed_out'])
})

test('markBooted ends unknown only once', () => {
  assert.equal(session.getSessionStatus(), 'unknown')
  session.markBooted('signed_out')
  assert.equal(session.getSessionStatus(), 'signed_out')
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  session.markBooted('signed_out')
  assert.equal(session.getSessionStatus(), 'signed_in')
})

test('unsubscribe stops notifications', () => {
  const seen = []
  const off = session.subscribeSession((state) => seen.push(state))
  off()
  session.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  assert.equal(seen.length, 0)
})

// 같은 탭에서 로그아웃한 뒤 늦게 도착한 옛 session 메시지는 무시한다
test('late older session message does not re-sign-in after local sign-out', async () => {
  const locks = fakeLocks()
  const bus = fakeBus()
  const tabB = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  const sender = bus.make()
  tabB.setSession({ access_token: 'B1', user: { u_id: 1 }, expires_in: 900 })
  await wait(5)
  tabB.clearSession('logout')
  assert.equal(tabB.getSessionStatus(), 'signed_out')
  sender.postMessage({ type: 'session', access_token: 'OLD', user: { u_id: 1 }, expires_in: 900, at: Date.now() - 1000 })
  assert.equal(tabB.getSessionStatus(), 'signed_out')
  assert.equal(tabB.getAccessToken(), null)
  // 로그아웃보다 나중에 만든 session 메시지(다른 탭의 새 로그인)는 받는다
  sender.postMessage({ type: 'session', access_token: 'NEW', user: { u_id: 1 }, expires_in: 900, at: Date.now() + 1000 })
  assert.equal(tabB.getSessionStatus(), 'signed_in')
  assert.equal(tabB.getAccessToken(), 'NEW')
})

// access_token 이 없는 응답은 죽은 갱신으로 본다 - 로그인했던 탭은 만료 알림과 방송
test('setSession without access_token on signed_in tab expires and broadcasts', () => {
  const locks = fakeLocks()
  const bus = fakeBus()
  const tabA = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  const tabB = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  tabA.setSession({ access_token: 'A1', user: { u_id: 1 }, expires_in: 900 })
  const seen = []
  tabA.subscribeSession((state) => seen.push(state))
  bus.sent.length = 0
  tabA.setSession({ user: { u_id: 1 }, expires_in: 900 })
  assert.equal(tabA.getSessionStatus(), 'signed_out')
  assert.equal(tabA.getAccessToken(), null)
  assert.deepEqual(seen, [{ status: 'signed_out', user: null, reason: 'expired' }])
  assert.deepEqual(bus.sent, [{ type: 'signed_out', reason: 'expired' }])
  assert.equal(tabB.getSessionStatus(), 'signed_out')
})

// 로그인한 적 없는 탭은 조용히 signed_out (방송 없음)
test('setSession without access_token on unknown tab is quiet', () => {
  const locks = fakeLocks()
  const bus = fakeBus()
  const tabA = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  const seen = []
  tabA.subscribeSession((state) => seen.push(state))
  tabA.setSession({ expires_in: 900 })
  assert.equal(tabA.getSessionStatus(), 'signed_out')
  assert.deepEqual(seen, [{ status: 'signed_out', user: null }])
  assert.equal(bus.sent.length, 0)
})

// reset 은 채널 수신기를 떼어 낸다 - 다음 시험에 이전 시험의 수신기가 남지 않게
test('reset detaches the message listener', () => {
  const locks = fakeLocks()
  const bus = fakeBus()
  const tab = createSession({ tabSync: createTabSync({ locks, channel: bus.make() }) })
  const sender = bus.make()
  tab.reset()
  sender.postMessage({ type: 'session', access_token: 'X', user: { u_id: 1 }, expires_in: 900, at: Date.now() })
  assert.equal(tab.getAccessToken(), null)
  assert.equal(tab.getSessionStatus(), 'unknown')
})

// 방송이 setTimeout(0) 으로 늦게 도착하는 버스 - 잠금이 방송보다 먼저 넘어가는 경로
test('lock granted before broadcast: second tab refreshes again and is not treated as reuse', async () => {
  const locks = fakeLocks()
  const members = []
  const make = () => {
    const listeners = new Set()
    const channel = {
      postMessage(data) {
        for (const other of members) if (other !== channel) setTimeout(() => other.deliver(data), 0)
      },
      addEventListener(type, fn) { if (type === 'message') listeners.add(fn) },
      removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn) },
      deliver(data) { for (const fn of listeners) fn({ data }) },
    }
    members.push(channel)
    return channel
  }
  const tabA = createSession({ tabSync: createTabSync({ locks, channel: make() }) })
  const tabB = createSession({ tabSync: createTabSync({ locks, channel: make() }) })
  let calls = 0
  let n = 1
  const refresher = async () => { calls += 1; await wait(30); n += 1; return { access_token: `A${n}`, user: { u_id: 1 }, expires_in: 900 } }
  tabA.setRefresher(refresher)
  tabB.setRefresher(refresher)
  const [a, b] = await Promise.all([tabA.refreshSession(), tabB.refreshSession()])
  await wait(20)
  assert.equal(calls, 2)
  assert.equal(a, true)
  assert.equal(b, true)
  assert.equal(tabA.getAccessToken(), 'A3')
  assert.equal(tabB.getAccessToken(), 'A3')
  assert.equal(tabB.getSessionStatus(), 'signed_in')
})

test('tabSync without locks/channel', async () => {
  const sync = createTabSync({ locks: undefined, channel: undefined })
  assert.equal(await sync.runExclusive('x', async () => 42), 42)
  assert.doesNotThrow(() => sync.post({ type: 'session' }))
  const off = sync.onMessage(() => {})
  assert.equal(typeof off, 'function')
  assert.doesNotThrow(() => off())
})

test('tabSync uses locks and channel', async () => {
  const locks = fakeLocks()
  const bus = fakeBus()
  const a = createTabSync({ locks, channel: bus.make() })
  const b = createTabSync({ locks, channel: bus.make() })
  const got = []
  const off = b.onMessage((m) => got.push(m))
  a.post({ type: 'ping' })
  off()
  a.post({ type: 'ping2' })
  assert.deepEqual(got, [{ type: 'ping' }])
  const order = []
  await Promise.all([
    a.runExclusive('n', async () => { order.push('a1'); await wait(20); order.push('a2') }),
    b.runExclusive('n', async () => { order.push('b1') }),
  ])
  assert.deepEqual(order, ['a1', 'a2', 'b1'])
})
