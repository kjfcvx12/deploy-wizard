import test from 'node:test'
import assert from 'node:assert/strict'
import './useAlias.mjs'

const { GIS_SRC, GIS_LOAD_ERROR_TEXT, loadGoogleIdentity, renderGoogleButton, gisButtonTheme } = await import('../../features/auth/ui/googleIdentity.js')

// 가짜 문서 - createElement·head.appendChild 를 기록한다
const fakeDoc = () => {
  const doc = {
    appended: [],
    removed: 0,
    defaultView: {},
    createElement(tag) {
      return { tag, remove() { doc.removed += 1; doc.appended = doc.appended.filter((el) => el !== this) } }
    },
    head: { appendChild(el) { doc.appended.push(el) } },
  }
  return doc
}

// 스크립트가 불러진 척한다
const fakeGisId = () => ({ id: { initialize() {}, renderButton() {} } })

test('loads script once', async () => {
  const doc = fakeDoc()
  const first = loadGoogleIdentity(doc, 1000)
  const second = loadGoogleIdentity(doc, 1000)
  assert.equal(doc.appended.length, 1)
  assert.equal(doc.appended[0].src, GIS_SRC)
  assert.equal(doc.appended[0].async, true)
  const gis = fakeGisId()
  doc.defaultView.google = { accounts: gis }
  doc.appended[0].onload()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a, gis.id)
  assert.equal(b, gis.id)
  // 이미 불러온 뒤에는 스크립트를 더하지 않고 바로 돌려준다
  assert.equal(await loadGoogleIdentity(doc, 1000), gis.id)
  assert.equal(doc.appended.length, 1)
})

test('script error rejects with Korean text and allows retry', async () => {
  const doc = fakeDoc()
  const first = loadGoogleIdentity(doc, 1000)
  doc.appended[0].onerror(new Event('error'))
  await assert.rejects(first, (e) => e.message === GIS_LOAD_ERROR_TEXT)
  assert.match(GIS_LOAD_ERROR_TEXT, /Google 로그인 버튼을 불러오지 못했습니다/)
  // 실패한 스크립트는 치워져 다시 시도하면 새로 불러온다
  assert.equal(doc.appended.length, 0)
  const again = loadGoogleIdentity(doc, 1000)
  assert.equal(doc.appended.length, 1)
  doc.defaultView.google = { accounts: fakeGisId() }
  doc.appended[0].onload()
  await again
})

test('timeout rejects', async () => {
  const doc = fakeDoc()
  await assert.rejects(loadGoogleIdentity(doc, 10), (e) => e.message === GIS_LOAD_ERROR_TEXT)
  assert.equal(doc.appended.length, 0)
})

test('onload without google.accounts.id rejects', async () => {
  const doc = fakeDoc()
  const pending = loadGoogleIdentity(doc, 1000)
  doc.appended[0].onload()
  await assert.rejects(pending, (e) => e.message === GIS_LOAD_ERROR_TEXT)
})

test('renderGoogleButton passes only credential', () => {
  const calls = { init: [], render: [] }
  const gisId = {
    initialize: (options) => calls.init.push(options),
    renderButton: (element, options) => calls.render.push({ element, options }),
  }
  const element = { replaceChildren() { this.cleared = true } }
  const received = []
  renderGoogleButton(gisId, element, { client_id: 'cid.apps.googleusercontent.com', onCredential: (c) => received.push(c) })

  assert.equal(calls.init.length, 1)
  assert.equal(calls.init[0].client_id, 'cid.apps.googleusercontent.com')
  assert.equal(calls.init[0].auto_select, false)
  assert.equal(calls.render.length, 1)
  assert.equal(calls.render[0].element, element)
  assert.deepEqual(calls.render[0].options, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', locale: 'ko' })

  calls.init[0].callback({ credential: 'idt', select_by: 'btn' })
  assert.deepEqual(received, ['idt'])
})

test('renderGoogleButton ignores callbacks without a credential', () => {
  let callback
  const gisId = { initialize: (o) => { callback = o.callback }, renderButton() {} }
  const received = []
  renderGoogleButton(gisId, {}, { client_id: 'c', onCredential: (c) => received.push(c) })
  callback(undefined)
  callback({})
  callback({ credential: '' })
  callback({ credential: 123 })
  assert.deepEqual(received, [])
})

// 성공한 뒤에는 시간 제한이 걷혀 늦게 실패로 바뀌지 않는다
test('timeout timer is cleared after success', async () => {
  const doc = fakeDoc()
  const pending = loadGoogleIdentity(doc, 20)
  const gis = fakeGisId()
  doc.defaultView.google = { accounts: gis }
  doc.appended[0].onload()
  assert.equal(await pending, gis.id)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(doc.removed, 0)
  assert.equal(doc.appended.length, 1)
  assert.equal(await loadGoogleIdentity(doc, 20), gis.id)
})

// 같은 클라이언트 ID 로는 initialize 를 한 번만 부르고, 콜백은 가장 새 처리기로 간다
test('renderGoogleButton initializes once per client id and uses the latest handler', () => {
  const inits = []
  const renders = []
  const gisId = { initialize: (o) => inits.push(o), renderButton: () => renders.push(1) }
  const first = []
  const second = []
  renderGoogleButton(gisId, {}, { client_id: 'same', onCredential: (c) => first.push(c) })
  renderGoogleButton(gisId, {}, { client_id: 'same', onCredential: (c) => second.push(c) })
  assert.equal(inits.length, 1)
  assert.equal(renders.length, 2)
  inits[0].callback({ credential: 'idt' })
  assert.deepEqual(first, [])
  assert.deepEqual(second, ['idt'])
  // 다른 클라이언트 ID 는 새로 initialize
  renderGoogleButton(gisId, {}, { client_id: 'other', onCredential() {} })
  assert.equal(inits.length, 2)
  assert.equal(inits[1].client_id, 'other')
})

test('gisButtonTheme follows prefers-color-scheme', () => {
  assert.equal(gisButtonTheme(() => ({ matches: true })), 'filled_black')
  assert.equal(gisButtonTheme(() => ({ matches: false })), 'outline')
  assert.equal(gisButtonTheme(undefined), 'outline')
  assert.equal(gisButtonTheme(() => { throw new Error('x') }), 'outline')
})

test('renderGoogleButton never opens One Tap', () => {
  const gisId = {
    initialize() {}, renderButton() {},
    prompt() { throw new Error('prompt must not be called') },
  }
  renderGoogleButton(gisId, {}, { client_id: 'c', onCredential() {} })
})
