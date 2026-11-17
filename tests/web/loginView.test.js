import test from 'node:test'
import assert from 'node:assert/strict'
import './useAlias.mjs'

const { loginViewState, createCredentialHandler } = await import('../../features/auth/ui/loginView.js')
const { CONFIG_OFF } = await import('../../features/auth/ui/authLogic.js')

const ready = { auth_required: true, login_available: true, platforms: ['web'], google_client_id_web: 'cid', pat_default_days: 30, pat_max_days: 90 }

test('loginViewState: signed in redirects (even without config)', () => {
  assert.deepEqual(loginViewState({ config: ready, configError: false, status: 'signed_in' }), { kind: 'redirect', offNote: false })
  assert.equal(loginViewState({ config: null, configError: false, status: 'signed_in' }).kind, 'redirect')
})

test('loginViewState: config error and loading', () => {
  assert.equal(loginViewState({ config: null, configError: true, status: 'unknown' }).kind, 'error')
  assert.equal(loginViewState({ config: null, configError: false, status: 'unknown' }).kind, 'loading')
  assert.equal(loginViewState({ config: ready, configError: false, status: 'unknown' }).kind, 'loading')
})

test('loginViewState: ready shows button, no off note when auth is required', () => {
  assert.deepEqual(loginViewState({ config: ready, configError: false, status: 'signed_out' }), { kind: 'ready', offNote: false })
})

test('loginViewState: off mode with login available adds the off note', () => {
  const off = { ...ready, auth_required: false }
  assert.deepEqual(loginViewState({ config: off, configError: false, status: 'signed_out' }), { kind: 'ready', offNote: true })
})

test('loginViewState: login not available -> unavailable (off mode keeps the continue note)', () => {
  assert.deepEqual(loginViewState({ config: CONFIG_OFF, configError: false, status: 'signed_out' }), { kind: 'unavailable', offNote: true })
  const notReady = { ...ready, login_available: false }
  assert.deepEqual(loginViewState({ config: notReady, configError: false, status: 'signed_out' }), { kind: 'unavailable', offNote: false })
})

test('loginViewState: login_available without a client id cannot draw the button', () => {
  const noId = { ...ready, google_client_id_web: null }
  assert.equal(loginViewState({ config: noId, configError: false, status: 'signed_out' }).kind, 'unavailable')
})

// 약속을 손으로 끝낼 수 있게 한다
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('credential handler ignores a second credential while one is in flight', async () => {
  const gate = deferred()
  const seen = []
  const events = []
  const handle = createCredentialHandler({
    signIn: (c) => { seen.push(c); return gate.promise },
    onStart: () => events.push('start'),
    onSuccess: () => events.push('ok'),
    onError: () => events.push('err'),
  })
  const first = handle('one')
  const second = handle('two')
  assert.deepEqual(seen, ['one'])
  gate.resolve({ u_id: 1 })
  await Promise.all([first, second])
  assert.deepEqual(events, ['start', 'ok'])
  // 성공한 뒤에도 같은 화면에서 또 들어온 응답은 무시한다
  await handle('three')
  assert.deepEqual(seen, ['one'])
})

test('credential handler reports the error and then accepts a new attempt', async () => {
  const errors = []
  let fail = true
  const handle = createCredentialHandler({
    signIn: async () => { if (fail) throw Object.assign(new Error('허용된 계정이 아닙니다'), { status: 403 }); return { u_id: 1 } },
    onStart() {},
    onSuccess() {},
    onError: (e) => errors.push(e.message),
  })
  await handle('a')
  assert.deepEqual(errors, ['허용된 계정이 아닙니다'])
  fail = false
  const events = []
  const again = createCredentialHandler({ signIn: async () => 1, onStart() {}, onSuccess: () => events.push('ok'), onError() {} })
  await again('b')
  assert.deepEqual(events, ['ok'])
  // 같은 처리기도 실패 뒤에는 다시 받는다
  let called = 0
  fail = true
  const retry = createCredentialHandler({ signIn: async () => { called += 1; throw new Error('x') }, onStart() {}, onSuccess() {}, onError() {} })
  await retry('1')
  await retry('2')
  assert.equal(called, 2)
})

test('credential handler never passes the credential to callbacks', async () => {
  const args = []
  const handle = createCredentialHandler({
    signIn: async () => { throw new Error('no') },
    onStart: (...a) => args.push(a),
    onSuccess: (...a) => args.push(a),
    onError: (...a) => args.push(a.map((x) => x?.message)),
  })
  await handle('SECRET.ID.TOKEN')
  assert.doesNotMatch(JSON.stringify(args), /SECRET/)
})
