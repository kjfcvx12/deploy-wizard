import { Routes, Route, Link } from 'react-router-dom'

import LoginPage from '@features/auth/ui/LoginPage.jsx'
import RequireAuth from '@features/auth/ui/RequireAuth.jsx'
import DeployListPage from '@features/deploys/ui/DeployListPage.jsx'
import DeployDetailPage from '@features/deploys/ui/DeployDetailPage.jsx'
import DeploySettingsPage from '@features/deploys/ui/DeploySettingsPage.jsx'
import IncidentDetailPage from '@features/incidents/ui/IncidentDetailPage.jsx'
import BellLink from '@features/notifications/ui/BellLink.jsx'
import NotificationsPage from '@features/notifications/ui/NotificationsPage.jsx'
import NotificationSettingsPage from '@features/notifications/ui/NotificationSettingsPage.jsx'
import AccountsPage from '@features/accounts/ui/AccountsPage.jsx'
import AuthNavLink from '@features/auth/ui/AuthNavLink.jsx'
import MePage from '@features/auth/ui/MePage.jsx'
import ConnectGuidePage from '@features/accounts/ui/ConnectGuidePage.jsx'

// 상단 바가 있는 보통 화면들의 틀
function Shell({ children }) {
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">▲</span> AWS 자동 배포 마법사
        </Link>
        <nav className="row">
          <BellLink />
          <Link to="/accounts" className="topbar-link">계정 연결</Link>
          <AuthNavLink />
          <span className="topbar-note">GitHub 주소 하나로 HTTPS 주소까지</span>
        </nav>
      </header>

      <main className="page">{children}</main>
    </div>
  )
}

// 보통 화면들의 경로
function ShellRoutes() {
  return (
    <Routes>
      <Route path="/" element={<DeployListPage />} />
      <Route path="/deploys/:d_id" element={<DeployDetailPage />} />
      <Route path="/deploys/:d_id/settings" element={<DeploySettingsPage />} />
      <Route path="/incidents/:i_id" element={<IncidentDetailPage />} />
      <Route path="/notifications" element={<NotificationsPage />} />
      <Route path="/notification-settings" element={<NotificationSettingsPage />} />
      <Route path="/accounts" element={<AccountsPage />} />
      <Route path="*" element={<p className="muted">없는 페이지입니다.</p>} />
    </Routes>
  )
}

// 화면은 기능 폴더가 가지고 있고, 여기서는 경로만 잇는다
// 로그인(/login)과 안내 창(/guide/...)은 상단 바 없이 보여준다 - 안내 창은 따로 뜨는 작은 창이다
// 로그인이 필요한 서버에서는 두 곳 모두 RequireAuth 가 로그인 화면(/login)으로 보낸다
// 내 정보(/me)는 상단 바는 있지만 RequireAuth 밖이다 - 계정 삭제 뒤 세션이 사라져도 결과 화면이 떠 있어야 해서 MePage 가 스스로 로그인 여부를 본다
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/guide/:kind" element={<RequireAuth><ConnectGuidePage /></RequireAuth>} />
      <Route path="/me" element={<Shell><MePage /></Shell>} />
      <Route path="*" element={<RequireAuth><Shell><ShellRoutes /></Shell></RequireAuth>} />
    </Routes>
  )
}
