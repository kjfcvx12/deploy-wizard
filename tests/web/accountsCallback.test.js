import test from 'node:test'
import assert from 'node:assert/strict'
import { githubCallbackResult } from '../../features/accounts/ui/logic.js'
import {
  GITHUB_CALLBACK_OK, GITHUB_CALLBACK_ERROR, GITHUB_CALLBACK_TAKEN, GITHUB_CALLBACK_ERROR_TEXT,
} from '../../features/accounts/ui/constants.js'

// 서버 GH_CALLBACK_* 주소의 값과 같아야 한다 (features/accounts/services.py)
test('callback result values match the server redirects', () => {
  assert.equal(GITHUB_CALLBACK_OK, 'github')
  assert.equal(GITHUB_CALLBACK_ERROR, 'github_error')
  assert.equal(GITHUB_CALLBACK_TAKEN, 'github_taken')
})

test('connected=github is success with no error text', () => {
  assert.deepEqual(githubCallbackResult('?connected=github'), { connected: true, error: null, known: true })
})

test('github_error and github_taken map to their Korean notices', () => {
  assert.deepEqual(githubCallbackResult('?connected=github_error'),
    { connected: false, error: 'GitHub 연결에 실패했습니다. 다시 시도해 주세요', known: true })
  assert.deepEqual(githubCallbackResult('?connected=github_taken'),
    { connected: false, error: '이 GitHub 설치는 이미 다른 사용자가 연결했습니다', known: true })
  assert.equal(Object.keys(GITHUB_CALLBACK_ERROR_TEXT).length, 2)
})

test('unknown, missing or hostile values show nothing', () => {
  for (const search of ['', '?', '?connected=', '?connected=aws', '?connected=GITHUB', '?other=github_error', '?connected=constructor', '?connected=__proto__', undefined, null]) {
    assert.deepEqual(githubCallbackResult(search), { connected: false, error: null, known: false }, String(search))
  }
})
