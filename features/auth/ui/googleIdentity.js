export const GIS_SRC = 'https://accounts.google.com/gsi/client'
export const GIS_LOAD_ERROR_TEXT = 'Google 로그인 버튼을 불러오지 못했습니다. 새로고침해 주세요'

// 문서마다 진행 중인 불러오기 (같은 문서에서 스크립트가 둘이 되지 않게)
const pending = new WeakMap()

// 이미 불러온 Google 로그인 객체 (없으면 null)
const readGis = (doc) => (doc.defaultView ?? globalThis).google?.accounts?.id ?? null

// Google 로그인 스크립트를 한 번만 불러와 google.accounts.id 를 돌려준다 - 실패·시간 초과는 한국어 오류, 다시 부르면 새로 시도
export function loadGoogleIdentity(doc = document, timeoutMs = 10000) {
  const loaded = readGis(doc)
  if (loaded) return Promise.resolve(loaded)
  const shared = pending.get(doc)
  if (shared) return shared

  const promise = new Promise((resolve, reject) => {
    const script = doc.createElement('script')
    let timer = null

    // 끝낸 뒤에는 시간 제한·이벤트를 걷어 낸다
    const finish = () => {
      clearTimeout(timer)
      script.onload = null
      script.onerror = null
    }
    // 실패하면 스크립트를 치워 다시 시도할 수 있게 한다
    const fail = () => {
      finish()
      pending.delete(doc)
      script.remove?.()
      reject(new Error(GIS_LOAD_ERROR_TEXT))
    }

    script.src = GIS_SRC
    script.async = true
    script.onerror = fail
    script.onload = () => {
      const gisId = readGis(doc)
      if (!gisId) return fail()
      finish()
      resolve(gisId)
    }
    timer = setTimeout(fail, timeoutMs)
    doc.head.appendChild(script)
  })
  pending.set(doc, promise)
  return promise
}

// Google 로그인 버튼을 그린다 - 콜백의 credential(id_token)만 onCredential 에 넘기고, One Tap 은 띄우지 않는다
export function renderGoogleButton(gisId, element, { client_id, onCredential }) {
  gisId.initialize({
    client_id,
    auto_select: false,
    callback: (response) => {
      const credential = response?.credential
      if (typeof credential === 'string' && credential) onCredential(credential)
    },
  })
  // 다시 그려도 버튼이 겹치지 않게 비운다
  element.replaceChildren?.()
  gisId.renderButton(element, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', locale: 'ko' })
}
