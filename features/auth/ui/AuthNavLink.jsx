import { Link, useLocation } from 'react-router-dom'

import { useAuth } from './AuthProvider.jsx'
import { authNavLinkView } from './authLogic.js'

// 상단 바의 링크 하나 - 로그인했으면 내 정보, 로그인할 수 있을 때만 로그인, 둘 다 아니면 아무것도 그리지 않는다
export default function AuthNavLink() {
  const { config, status } = useAuth()
  const location = useLocation()
  const view = authNavLinkView({ config, status, path: location.pathname + location.search + location.hash })
  if (!view) return null
  return <Link to={view.to} className="topbar-link">{view.label}</Link>
}
