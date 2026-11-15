import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../../shared/ui/styles.css', import.meta.url), 'utf8')

// 선택자로 시작하는 규칙의 본문을 찾는다 (줄 처음 또는 앞 규칙의 } 바로 뒤)
function ruleBody(selector) {
  const start = css.split('\n').findIndex((line) => line.startsWith(selector + ' {') || line.startsWith(selector + '{'))
  if (start < 0) return null
  const rest = css.split('\n').slice(start).join('\n')
  return rest.slice(rest.indexOf('{') + 1, rest.indexOf('}'))
}

test('body: 한글 어절 단위 줄바꿈 (keep-all) + 긴 낱말은 끊기', () => {
  const body = ruleBody('body')
  assert.ok(body, 'body rule exists')
  assert.match(body, /word-break:\s*keep-all/)
  assert.match(body, /overflow-wrap:\s*break-word/)
})

test('코드·로그·endpoint 상자는 break-all 유지', () => {
  for (const sel of ['.terminal', '.explain-raw', '.endpoint', '.fix-where']) {
    const b = ruleBody(sel)
    assert.ok(b, `${sel} rule exists`)
    assert.match(b, /word-break:\s*break-all/, sel)
  }
})

test('분석 결과 첫 줄의 칸은 긴 앱 폴더 경로에도 줄을 넘지 않는다 (min-width 0 + anywhere)', () => {
  const b = ruleBody('.advice > .row > *')
  assert.ok(b, 'rule exists')
  assert.match(b, /min-width:\s*0/)
  assert.match(b, /overflow-wrap:\s*anywhere/)
})
