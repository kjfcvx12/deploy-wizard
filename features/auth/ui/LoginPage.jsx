import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { useAuth } from './AuthProvider.jsx'
import { loginErrorText, safeNext } from './authLogic.js'
import { loadGoogleIdentity, renderGoogleButton } from './googleIdentity.js'
import { createCredentialHandler, loginViewState } from './loginView.js'

// 로그인 화면 (S-01) - 상단 바 없이 카드 하나. Google 버튼으로만 로그인한다
export default function LoginPage() {
  const { config, configError, status, retryConfig, signInWithCredential } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // URLSearchParams 가 이미 한 번 풀어 준 값 그대로 쓴다 (다시 풀지 않는다)
  const next = searchParams.get('next')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [gisError, setGisError] = useState('')
  const buttonBox = useRef(null)
  const latest = useRef({})
  const handler = useRef(null)

  latest.current = { signIn: signInWithCredential, navigate, next }
  // 처리기는 한 번만 만든다 - Google 콜백이 몇 번 와도 로그인은 하나씩만
  if (!handler.current) {
    handler.current = createCredentialHandler({
      signIn: (credential) => latest.current.signIn(credential),
      onStart: () => { setBusy(true); setError('') },
      onSuccess: () => latest.current.navigate(safeNext(latest.current.next), { replace: true }),
      onError: (e) => { setError(loginErrorText(e)); setBusy(false) },
    })
  }

  const view = loginViewState({ config, configError, status })
  const clientId = config?.google_client_id_web ?? null

  // 이미 로그인한 사람은 가려던 곳으로 바로 보낸다
  useEffect(() => {
    if (view.kind === 'redirect') navigate(safeNext(next), { replace: true })
  }, [view.kind, next, navigate])

  // 버튼을 그릴 수 있을 때 Google 스크립트를 불러와 버튼을 그린다
  useEffect(() => {
    if (view.kind !== 'ready' || !clientId) return undefined
    let cancelled = false
    setGisError('')
    loadGoogleIdentity()
      .then((gisId) => {
        if (cancelled || !buttonBox.current) return
        renderGoogleButton(gisId, buttonBox.current, { client_id: clientId, onCredential: (credential) => handler.current(credential) })
      })
      .catch((e) => { if (!cancelled) setGisError(e.message) })
    return () => { cancelled = true }
  }, [view.kind, clientId])

  return (
    <main className="login-page">
      <div className="card login-card">
        <h1 className="login-title"><span className="brand-mark">▲</span> AWS 자동 배포 마법사</h1>

        {view.kind === 'loading' && <p className="muted">불러오는 중…</p>}
        {view.kind === 'redirect' && <p className="muted">이동하는 중…</p>}

        {view.kind === 'error' && (
          <>
            <div className="notice err" role="alert">서버에 연결할 수 없습니다</div>
            <div className="row login-actions">
              <button onClick={retryConfig}>다시 시도</button>
            </div>
          </>
        )}

        {(view.kind === 'ready' || view.kind === 'unavailable') && (
          <>
            {view.offNote && <p className="muted">로그인하지 않아도 쓸 수 있습니다. 로그인하면 내 정보와 개인 토큰을 관리할 수 있습니다.</p>}

            {view.kind === 'ready' && (
              <>
                <p>Google 계정으로 로그인합니다. 허용된 계정만 들어올 수 있습니다.</p>
                <div className="login-gis" ref={buttonBox} hidden={busy} />
                {busy && <button className="login-wait" disabled>로그인하는 중…</button>}
                {error && <div className="notice err" role="alert">{error}</div>}
                {gisError && <div className="notice err" role="alert">{gisError}</div>}
              </>
            )}

            {view.kind === 'unavailable' && (
              <div className="notice warn">이 서버는 아직 로그인이 설정되지 않았습니다 (GOOGLE_CLIENT_ID_WEB·AUTH_JWT_KEY).</div>
            )}

            {view.offNote && (
              <div className="row login-actions">
                <button onClick={() => navigate('/')}>로그인하지 않고 계속</button>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  )
}
