import test from 'node:test'
import assert from 'node:assert/strict'
import './useAlias.mjs'

const { runBoot, normalizeConfig, routeDecision, reloadFailureFlagsError } = await import('../../features/auth/ui/authLogic.js')

// 시작 확인용 가짜 - 호출 기록과 상태를 들고 있다
const bootHarness = ({ config, configError, refreshError, startStatus = 'unknown', hint = true, refreshStatus } = {}) => {
  const log = { refresh: 0, booted: [], cleared: 0, configs: [] }
  let status = startStatus
  const deps = {
    getConfig: async () => { if (configError) throw configError; return config },
    refresh: async () => {
      log.refresh += 1
      if (refreshError) throw refreshError
      if (refreshStatus) status = refreshStatus
      return refreshStatus === 'signed_in'
    },
    getStatus: () => status,
    markBooted: (next) => { log.booted.push(next) },
    hasHint: () => hint,
    clearHint: () => { log.cleared += 1 },
    onConfig: (c) => { log.configs.push(c) },
  }
  return { deps, log }
}
const httpError = (status) => Object.assign(new Error(`실패 ${status}`), { status })

test('runBoot: old server (config 404) is login-off and never tries a refresh, even with the hint', async () => {
  const { deps, log } = bootHarness({ configError: httpError(404), hint: true })
  const result = await runBoot(deps)
  assert.deepEqual(result, { error: false })
  assert.equal(log.refresh, 0)
  assert.deepEqual(log.booted, ['signed_out'])
  assert.equal(log.configs[0].auth_required, false)
})

test('runBoot: off mode, refresh 404 (old-server rollback) ends signed_out and clears the hint', async () => {
  const { deps, log } = bootHarness({ config: { auth_required: false }, refreshError: httpError(404) })
  const result = await runBoot(deps)
  assert.deepEqual(result, { error: false })
  assert.deepEqual(log.booted, ['signed_out'])
  assert.equal(log.cleared, 1)
})

test('runBoot: off mode, refresh 503 or network error ends signed_out, hint kept', async () => {
  for (const status of [503, 0]) {
    const { deps, log } = bootHarness({ config: { auth_required: false }, refreshError: httpError(status) })
    const result = await runBoot(deps)
    assert.deepEqual(result, { error: false }, String(status))
    assert.deepEqual(log.booted, ['signed_out'], String(status))
    assert.equal(log.cleared, 0, String(status))
  }
})

test('runBoot: off mode, refresh swallowed a definitive refusal (returns false) clears the hint', async () => {
  const { deps, log } = bootHarness({ config: { auth_required: false }, refreshStatus: 'signed_out' })
  const result = await runBoot(deps)
  assert.deepEqual(result, { error: false })
  assert.equal(log.refresh, 1)
  assert.equal(log.cleared, 1)
  assert.deepEqual(log.booted, ['signed_out'])
})

test('runBoot: off mode, refresh success keeps the hint', async () => {
  const { deps, log } = bootHarness({ config: { auth_required: false }, refreshStatus: 'signed_in' })
  await runBoot(deps)
  assert.equal(log.cleared, 0)
  assert.deepEqual(log.booted, ['signed_in'])
})

test('runBoot: auth required, refresh returning false does not touch the hint', async () => {
  const { deps, log } = bootHarness({ config: { auth_required: true } })
  await runBoot(deps)
  assert.equal(log.cleared, 0)
})

test('reloadFailureFlagsError: only a latest, failed reload with no config known flags the error', () => {
  assert.equal(reloadFailureFlagsError({ config: null, latest: true }), true)
  assert.equal(reloadFailureFlagsError({ config: undefined, latest: true }), true)
  assert.equal(reloadFailureFlagsError({ config: { auth_required: false }, latest: true }), false)
  assert.equal(reloadFailureFlagsError({ config: null, latest: false }), false)
})

test('runBoot: off mode without the hint does not refresh', async () => {
  const { deps, log } = bootHarness({ config: { auth_required: false }, hint: false })
  await runBoot(deps)
  assert.equal(log.refresh, 0)
  assert.deepEqual(log.booted, ['signed_out'])
})

test('runBoot: auth required, network or 5xx refresh failure is an error and NOT signed_out', async () => {
  for (const status of [0, 500, 503]) {
    const { deps, log } = bootHarness({ config: { auth_required: true }, refreshError: httpError(status), hint: false })
    const result = await runBoot(deps)
    assert.deepEqual(result, { error: true }, String(status))
    assert.deepEqual(log.booted, [], String(status))
    assert.equal(log.cleared, 0, String(status))
  }
})

test('runBoot: auth required, refresh succeeds or is refused (definitive) finishes boot with the session status', async () => {
  const ok = bootHarness({ config: { auth_required: true }, refreshStatus: 'signed_in', hint: false })
  assert.deepEqual(await runBoot(ok.deps), { error: false })
  assert.deepEqual(ok.log.booted, ['signed_in'])
  const refused = bootHarness({ config: { auth_required: true }, refreshStatus: 'signed_out', hint: false })
  assert.deepEqual(await runBoot(refused.deps), { error: false })
  assert.deepEqual(refused.log.booted, ['signed_out'])
})

test('runBoot: config network error or 5xx is an error with no boot and no refresh', async () => {
  for (const status of [0, 500]) {
    const { deps, log } = bootHarness({ configError: httpError(status) })
    assert.deepEqual(await runBoot(deps), { error: true }, String(status))
    assert.equal(log.refresh, 0)
    assert.deepEqual(log.booted, [])
    assert.deepEqual(log.configs, [])
  }
})

test('runBoot: an already decided session or a stale run does nothing more', async () => {
  const decided = bootHarness({ config: { auth_required: true }, startStatus: 'signed_in' })
  await runBoot(decided.deps)
  assert.equal(decided.log.refresh, 0)
  assert.deepEqual(decided.log.booted, [])
  const stale = bootHarness({ config: { auth_required: true } })
  const result = await runBoot({ ...stale.deps, live: () => false })
  assert.deepEqual(result, { error: false })
  assert.deepEqual(stale.log.configs, [])
  assert.equal(stale.log.refresh, 0)
})

test('after a reload says auth is required, a signed-out tab is sent to login', () => {
  const before = normalizeConfig({ auth_required: false })
  const after = normalizeConfig({ auth_required: true, login_available: true })
  assert.equal(routeDecision({ config: before, status: 'signed_out', path: '/deploys/1' }), 'allow')
  assert.equal(routeDecision({ config: after, status: 'signed_out', path: '/deploys/1' }), 'login')
})
