import { Navigate, useLocation } from 'react-router-dom'

import { useAuth } from './AuthProvider.jsx'
import { routeDecision } from './authLogic.js'

// 로그인이 필요한 화면을 감싼다 - 정해지기 전엔 기다리고, 필요하면 로그인으로 보낸다
export default function RequireAuth({ children }) {
  const { config, configError, status, retryConfig } = useAuth()
  const location = useLocation()
  const decision = routeDecision({ config, configError, status, path: location.pathname })

  if (decision === 'loading') return <p className="muted">불러오는 중…</p>

  if (decision === 'error') {
    return (
      <>
        <div className="notice err" style={{ marginTop: 0 }}>서버에 연결할 수 없습니다</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button onClick={retryConfig}>다시 시도</button>
        </div>
      </>
    )
  }

  if (decision === 'login') {
    const here = location.pathname + location.search + location.hash
    return <Navigate to={'/login?next=' + encodeURIComponent(here)} replace />
  }

  return children
}
