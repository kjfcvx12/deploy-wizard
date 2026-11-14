import test from 'node:test'
import assert from 'node:assert/strict'
import {
  INCIDENT_STATUS_LABEL, INCIDENT_STATUS_BADGE, INCIDENT_ACTIVE_STATUSES, INCIDENT_KIND_LABEL,
  RECOVERY_ACTION_LABEL, RECOVERY_RESULT_LABEL, RECOVERY_RESULT_TONE, problemLabel,
} from '../../features/incidents/ui/constants.js'
import { HEALTH_STATE_LABEL } from '../../features/deploys/ui/constants.js'
import { incidentTimeline } from '../../features/incidents/ui/timeline.js'
import { healthBuckets } from '../../features/incidents/ui/health.js'

test('label tables cover every backend value', () => {
  for (const s of ['open', 'recovering', 'resolved', 'needs_action']) {
    assert.ok(INCIDENT_STATUS_LABEL[s], s)
    assert.ok(INCIDENT_STATUS_BADGE[s], s)
  }
  assert.deepEqual(INCIDENT_STATUS_BADGE, { open: 'exp', recovering: 'run', resolved: 'ok', needs_action: 'err' })
  assert.deepEqual(INCIDENT_ACTIVE_STATUSES, ['open', 'recovering'])
  for (const k of ['unhealthy', 'crash_loop', 'bad_release', 'unknown']) assert.ok(INCIDENT_KIND_LABEL[k], k)
  for (const a of ['restart', 'rollback']) assert.ok(RECOVERY_ACTION_LABEL[a], a)
  for (const r of ['running', 'ok', 'failed']) {
    assert.ok(RECOVERY_RESULT_LABEL[r], r)
    assert.ok(RECOVERY_RESULT_TONE[r], r)
  }
  for (const h of ['healthy', 'unhealthy', 'unknown']) assert.ok(HEALTH_STATE_LABEL[h], h)
  assert.equal(INCIDENT_STATUS_LABEL.needs_action, '확인 필요')
})

test('problemLabel', () => {
  assert.equal(problemLabel({ open_incident_status: 'needs_action', auto_recover: true }), '확인이 필요합니다')
  assert.equal(problemLabel({ open_incident_status: 'open', auto_recover: true }), '자동 복구 중')
  assert.equal(problemLabel({ open_incident_status: 'open', auto_recover: false }), '확인이 필요합니다')
  assert.equal(problemLabel({ open_incident_status: 'open' }), '자동 복구 중')
  assert.equal(problemLabel({ open_incident_status: 'recovering', auto_recover: true }), '자동 복구 중')
})

const base = {
  i_id: 7, status: 'open', summary: '응답이 없습니다', explain: null,
  detected_at: '2026-11-09T03:00:00', updated_at: '2026-11-09T03:00:00', resolved_at: null, actions: [],
}
const act = (id, action, result, started, finished, detail = null) => (
  { r_a_id: id, action, result, started_at: started, finished_at: finished, detail })

test('timeline: no actions', () => {
  const t = incidentTimeline(base)
  assert.deepEqual(t.map((e) => e.key), ['detected'])
  assert.equal(t[0].tone, 'warn')
  assert.equal(t[0].detail, '응답이 없습니다')
})

test('timeline: detected detail falls back to explain.summary then null', () => {
  assert.equal(incidentTimeline({ ...base, summary: '', explain: { summary: '설명' } })[0].detail, '설명')
  assert.equal(incidentTimeline({ ...base, summary: null })[0].detail, null)
})

test('timeline: one finished action', () => {
  const t = incidentTimeline({
    ...base, status: 'recovering',
    actions: [act(1, 'restart', 'ok', '2026-11-09T03:01:00', '2026-11-09T03:02:00', '완료')],
  })
  assert.deepEqual(t.map((e) => e.key), ['detected', 'action-1-start', 'action-1-result'])
  assert.equal(t[1].title, '재시작 시도')
  assert.equal(t[2].title, '재시작 성공')
  assert.equal(t[2].tone, 'ok')
  assert.equal(t[2].detail, '완료')
})

test('timeline: running action has no result row', () => {
  const t = incidentTimeline({ ...base, status: 'recovering', actions: [act(1, 'restart', 'running', '2026-11-09T03:01:00', null)] })
  assert.deepEqual(t.map((e) => e.key), ['detected', 'action-1-start'])
})

test('timeline: two actions sorted by start, failed tone err', () => {
  const t = incidentTimeline({
    ...base, status: 'needs_action', updated_at: '2026-11-09T03:10:00',
    actions: [
      act(2, 'rollback', 'failed', '2026-11-09T03:05:00', '2026-11-09T03:06:00', '실패 이유'),
      act(1, 'restart', 'failed', '2026-11-09T03:01:00', '2026-11-09T03:02:00'),
    ],
  })
  assert.deepEqual(t.map((e) => e.key), [
    'detected', 'action-1-start', 'action-1-result', 'action-2-start', 'action-2-result', 'needs_action'])
  assert.equal(t[2].tone, 'err')
  assert.equal(t.at(-1).title, '확인이 필요합니다')
  assert.equal(t.at(-1).time, '2026-11-09T03:10:00')
})

test('timeline: needs_action stays last even if updated_at is older', () => {
  const t = incidentTimeline({
    ...base, status: 'needs_action', updated_at: '2026-11-09T03:00:00',
    actions: [act(1, 'restart', 'failed', '2026-11-09T03:01:00', '2026-11-09T03:02:00')],
  })
  assert.equal(t.at(-1).key, 'needs_action')
  assert.equal(t.at(-1).time, '2026-11-09T03:02:00')
})

test('timeline: resolved', () => {
  const t = incidentTimeline({
    ...base, status: 'resolved', resolved_at: '2026-11-09T03:05:00',
    actions: [act(1, 'restart', 'ok', '2026-11-09T03:01:00', '2026-11-09T03:02:00')],
  })
  assert.equal(t.at(-1).key, 'resolved')
  assert.equal(t.at(-1).time, '2026-11-09T03:05:00')
  assert.equal(t.at(-1).tone, 'ok')
})

test('timeline: equal times keep creation order; unreadable times last; unknown values raw', () => {
  const same = '2026-11-09T03:00:00'
  const t = incidentTimeline({
    ...base, detected_at: same,
    actions: [act(1, 'mystery', 'weird', same, same), act(2, 'restart', 'ok', 'garbage', 'garbage')],
  })
  assert.deepEqual(t.map((e) => e.key), ['detected', 'action-1-start', 'action-1-result', 'action-2-start', 'action-2-result'])
  assert.equal(t[1].title, 'mystery 시도')
  assert.equal(t[2].title, 'mystery weird')
  assert.equal(t[2].tone, 'muted')
})

const NOW = Date.parse('2026-11-09T12:00:00Z')
const at = (minAgo) => new Date(NOW - minAgo * 60000).toISOString()

test('healthBuckets: empty and bad input', () => {
  for (const input of [[], null, undefined, 'x']) {
    const r = healthBuckets(input, NOW)
    assert.equal(r.cells.length, 96)
    assert.ok(r.cells.every((c) => c === 'none'))
    assert.equal(r.percent, null)
  }
})

test('healthBuckets: all ok gives 100', () => {
  const r = healthBuckets([{ ok: true, checked_at: at(10) }, { ok: true, checked_at: at(100) }], NOW)
  assert.equal(r.percent, 100)
  assert.equal(r.cells.filter((c) => c === 'ok').length, 2)
})

test('healthBuckets: failed cell wins and percent clamps to 99', () => {
  const checks = [{ ok: true, checked_at: at(10) }, { ok: false, checked_at: at(10) }]
  for (let i = 0; i < 300; i++) checks.push({ ok: true, checked_at: at(10) })
  const r = healthBuckets(checks, NOW)
  assert.equal(r.cells.filter((c) => c === 'failed').length, 1)
  assert.equal(r.cells.filter((c) => c === 'ok').length, 0)
  assert.equal(r.percent, 99)
})

test('healthBuckets: all failed gives 0, one ok among failures clamps to 1', () => {
  assert.equal(healthBuckets([{ ok: false, checked_at: at(5) }], NOW).percent, 0)
  const checks = [{ ok: true, checked_at: at(5) }]
  for (let i = 0; i < 300; i++) checks.push({ ok: false, checked_at: at(5) })
  assert.equal(healthBuckets(checks, NOW).percent, 1)
})

test('healthBuckets: a check newer than now is kept', () => {
  const r = healthBuckets([{ ok: true, checked_at: new Date(NOW + 5 * 60000).toISOString() }], NOW)
  assert.equal(r.percent, 100)
  assert.equal(r.cells.at(-1), 'ok')
})

test('healthBuckets: non-boolean ok, bad time, old checks ignored', () => {
  const r = healthBuckets([
    { ok: 'true', checked_at: at(5) }, { ok: 1, checked_at: at(5) }, null, 'x',
    { ok: true, checked_at: 'garbage' }, { ok: true, checked_at: at(60 * 25) },
  ], NOW)
  assert.equal(r.percent, null)
  assert.ok(r.cells.every((c) => c === 'none'))
})

test('healthBuckets: hours 1 gives 4 cells, hours capped at 96 cells', () => {
  assert.equal(healthBuckets([], NOW, 1).cells.length, 4)
  assert.equal(healthBuckets([], NOW, 168).cells.length, 96)
})
