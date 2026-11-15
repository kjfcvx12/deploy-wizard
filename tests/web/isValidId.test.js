import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidId } from '../../shared/ui/isValidId.js'

// 주소의 id 검사 - 양의 정수 문자열(2147483647 이하)만 통과
test('isValidId: accepts positive integers up to int32 max', () => {
  for (const value of ['1', '7', '42', '2147483647', '1234567890']) assert.equal(isValidId(value), true, value)
})

test('isValidId: rejects everything else', () => {
  const bad = ['0', '01', '-1', '1.5', '1e3', ' 7', '7 ', '7/../x', '7?a=1', '%37', '', 'abc', '2147483648', '99999999999', undefined, null, 7, {}]
  for (const value of bad) assert.equal(isValidId(value), false, String(value))
})
