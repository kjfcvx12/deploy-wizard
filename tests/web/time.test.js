import test from 'node:test'
import assert from 'node:assert/strict'
import { toMs, formatTime, durationText } from '../../shared/ui/time.js'
import { backoffDelay } from '../../shared/ui/polling.js'

// 시간대 표시가 없는 서버 시각은 UTC 로 읽는다
test('toMs: zone-less string is UTC', () => {
  assert.equal(new Date(toMs('2026-11-09T03:12:00')).toISOString(), '2026-11-09T03:12:00.000Z')
})

test('toMs: Z and offset respected', () => {
  assert.equal(new Date(toMs('2026-11-09T03:12:00Z')).toISOString(), '2026-11-09T03:12:00.000Z')
  assert.equal(new Date(toMs('2026-11-09T12:12:00+09:00')).toISOString(), '2026-11-09T03:12:00.000Z')
  assert.equal(new Date(toMs('2026-11-09T12:12:00+0900')).toISOString(), '2026-11-09T03:12:00.000Z')
})

test('toMs: 6-digit fraction is cut to ms', () => {
  assert.equal(new Date(toMs('2026-11-09T03:12:00.123456')).toISOString(), '2026-11-09T03:12:00.123Z')
})

test('toMs / formatTime: unreadable input', () => {
  for (const bad of [null, undefined, '', 'x', 12]) {
    assert.ok(Number.isNaN(toMs(bad)), String(bad))
    assert.equal(formatTime(bad), '')
  }
})

test('formatTime: local time as M월 D일 HH:MM', () => {
  const iso = '2026-11-09T03:12:00'
  const d = new Date(toMs(iso))
  const pad = (n) => String(n).padStart(2, '0')
  assert.equal(formatTime(iso), `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`)
})

test('durationText', () => {
  const base = '2026-11-09T00:00:00'
  assert.equal(durationText(base, '2026-11-09T00:00:05'), '5초')
  assert.equal(durationText(base, '2026-11-09T00:03:20'), '3분 20초')
  assert.equal(durationText(base, '2026-11-09T00:03:00'), '3분')
  assert.equal(durationText(base, '2026-11-09T02:05:00'), '2시간 5분')
  assert.equal(durationText(base, '2026-11-10T02:00:00'), '1일 2시간')
  assert.equal(durationText('2026-11-09T00:03:20', base), '')
  assert.equal(durationText('x', base), '')
  assert.equal(durationText(base, null), '')
})

test('backoffDelay: 5s base doubles up to 30s', () => {
  const seq = [0, 1, 2, 3, 4, 5].map((f) => backoffDelay(5000, f))
  assert.deepEqual(seq, [5000, 5000, 10000, 20000, 30000, 30000])
  assert.equal(backoffDelay(5000, 9, 60000), 60000)
  // 읽지 않은 알림 수: 30초 기준, 상한 5분
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((f) => backoffDelay(30000, f, 300000)), [30000, 60000, 120000, 240000, 300000, 300000, 300000])
})
