import { Routes, Route, Link } from 'react-router-dom'

import DeployListPage from '@features/deploys/ui/DeployListPage.jsx'
import DeployDetailPage from '@features/deploys/ui/DeployDetailPage.jsx'
import AccountsPage from '@features/accounts/ui/AccountsPage.jsx'
import ConnectGuidePage from '@features/accounts/ui/ConnectGuidePage.jsx'

// 상단 바가 있는 보통 화면들
function Shell() {
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">▲</span> AWS 자동 배포 마법사
        </Link>
        <nav className="row">
          <Link to="/accounts" className="topbar-link">계정 연결</Link>
          <span className="topbar-note">GitHub 주소 하나로 HTTPS 주소까지</span>
        </nav>
      </header>

      <main className="page">
        <Routes>
          <Route path="/" element={<DeployListPage />} />
          <Route path="/deploys/:d_id" element={<DeployDetailPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="*" element={<p className="muted">없는 페이지입니다.</p>} />
        </Routes>
      </main>
    </div>
  )
}

// 화면은 기능 폴더가 가지고 있고, 여기서는 경로만 잇는다
// 안내 창(/guide/...)은 따로 뜨는 작은 창이라 상단 바 없이 보여준다
export default function App() {
  return (
    <Routes>
      <Route path="/guide/:kind" element={<ConnectGuidePage />} />
      <Route path="*" element={<Shell />} />
    </Routes>
  )
}
