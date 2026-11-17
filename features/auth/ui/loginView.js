// 로그인 화면이 무엇을 보여줄지 정한다 - redirect | error | loading | unavailable | ready, offNote 는 "로그인하지 않고 계속" 안내를 덧붙일지
export function loginViewState({ config, configError, status }) {
  if (status === 'signed_in') return { kind: 'redirect', offNote: false }
  if (configError) return { kind: 'error', offNote: false }
  if (!config || status === 'unknown') return { kind: 'loading', offNote: false }
  const offNote = !config.auth_required
  // 서버가 로그인을 열지 않았거나 웹 클라이언트 ID 가 없으면 버튼을 그릴 수 없다
  const canDraw = config.login_available === true && Boolean(config.google_client_id_web)
  return { kind: canDraw ? 'ready' : 'unavailable', offNote }
}

// Google 이 준 credential 을 한 번에 하나씩만 로그인에 쓰는 처리기 - 진행 중이거나 이미 성공했으면 무시, 실패하면 다시 받는다 (credential 은 콜백에 넘기지 않는다)
export function createCredentialHandler({ signIn, onStart, onSuccess, onError }) {
  let locked = false
  return async function handleCredential(credential) {
    if (locked) return
    locked = true
    onStart()
    try {
      const user = await signIn(credential)
      onSuccess(user)
    } catch (e) {
      locked = false
      onError(e)
    }
  }
}
