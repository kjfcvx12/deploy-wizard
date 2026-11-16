import test from 'node:test'
import assert from 'node:assert/strict'

const { rejectText, REJECT_FALLBACK } = await import('../../features/pricing/ui/rejectText.js')

test('rejectText: 한글이 있는 서버 문장은 그대로 쓴다', () => {
  assert.equal(rejectText('최대 개수는 8개까지입니다'), '최대 개수는 8개까지입니다')
})

test('rejectText: pydantic 영어 문장이면 한국어 안내로 바꾼다', () => {
  assert.equal(rejectText('Input should be greater than or equal to 1'), REJECT_FALLBACK)
  assert.equal(REJECT_FALLBACK, '입력값을 확인해 주세요')
})

test('rejectText: 비었거나 문자열이 아니어도 안내를 돌려준다', () => {
  assert.equal(rejectText(''), REJECT_FALLBACK)
  assert.equal(rejectText(undefined), REJECT_FALLBACK)
  assert.equal(rejectText(null), REJECT_FALLBACK)
})
