import test from 'node:test'
import assert from 'node:assert/strict'

const { createLatest } = await import('../../features/pricing/ui/latest.js')

test('createLatest: 마지막으로 시작한 요청만 받아들인다', () => {
  const latest = createLatest()
  const first = latest.start()
  const second = latest.start()
  assert.equal(latest.accept(first), false)
  assert.equal(latest.accept(second), true)
  const third = latest.start()
  assert.equal(latest.accept(second), false)
  assert.equal(latest.accept(third), true)
})

test('createLatest: 시작한 적이 없거나 모르는 번호는 거절', () => {
  const latest = createLatest()
  assert.equal(latest.accept(0), false)
  assert.equal(latest.accept(undefined), false)
  assert.equal(latest.accept(99), false)
})

test('createLatest: 취소 후에는 모두 거절', () => {
  const latest = createLatest()
  const id = latest.start()
  latest.cancel()
  assert.equal(latest.accept(id), false)
  assert.equal(latest.accept(latest.start()), false)
})

test('createLatest: 인스턴스끼리 독립', () => {
  const a = createLatest()
  const b = createLatest()
  const idA = a.start()
  b.cancel()
  assert.equal(a.accept(idA), true)
})
