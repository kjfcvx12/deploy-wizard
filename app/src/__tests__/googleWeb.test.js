import { loadGoogleIdentity, renderGoogleButton, googleSignIn, googleSignOut, GIS_SRC, GIS_LOAD_ERROR_TEXT } from '../auth/google.web'

// 스크립트를 붙이는 가짜 문서 - 붙인 스크립트의 onload·onerror 를 테스트가 직접 부른다
const fakeDoc = (win = {}) => {
  const scripts = []
  const doc = {
    defaultView: win,
    createElement: () => ({ remove: jest.fn() }),
    head: { appendChild: (script) => scripts.push(script) },
  }
  return { doc, scripts }
}

describe('loadGoogleIdentity', () => {
  it('loads the script once and resolves google.accounts.id', async () => {
    const win = {}
    const { doc, scripts } = fakeDoc(win)
    const first = loadGoogleIdentity(doc)
    const second = loadGoogleIdentity(doc)
    expect(scripts).toHaveLength(1)
    expect(scripts[0].src).toBe(GIS_SRC)
    const gisId = { initialize: jest.fn() }
    win.google = { accounts: { id: gisId } }
    scripts[0].onload()
    await expect(first).resolves.toBe(gisId)
    await expect(second).resolves.toBe(gisId)
  })

  it('script error -> Korean error and retry allowed', async () => {
    const { doc, scripts } = fakeDoc()
    const attempt = loadGoogleIdentity(doc)
    scripts[0].onerror()
    await expect(attempt).rejects.toThrow(GIS_LOAD_ERROR_TEXT)
    loadGoogleIdentity(doc).catch(() => {})
    expect(scripts).toHaveLength(2)
    scripts[1].onerror()
  })
})

describe('renderGoogleButton', () => {
  it('passes only a string credential to onCredential', () => {
    const gisId = { initialize: jest.fn(), renderButton: jest.fn() }
    const onCredential = jest.fn()
    renderGoogleButton(gisId, {}, { client_id: 'cid', onCredential })
    const { callback, auto_select, client_id } = gisId.initialize.mock.calls[0][0]
    expect(client_id).toBe('cid')
    expect(auto_select).toBe(false)
    callback({})
    callback({ credential: '' })
    expect(onCredential).not.toHaveBeenCalled()
    callback({ credential: 'idt' })
    expect(onCredential).toHaveBeenCalledWith('idt')
    expect(gisId.renderButton).toHaveBeenCalledTimes(1)
  })
})

describe('web adapter functions', () => {
  it('googleSignIn rejects with a Korean error (the button is used instead)', async () => {
    await expect(googleSignIn()).rejects.toThrow('Google 로그인을 하지 못했습니다. 잠시 뒤 다시 시도해 주세요')
  })

  it('googleSignOut never throws, even without a document', async () => {
    await expect(googleSignOut()).resolves.toBeUndefined()
  })
})
