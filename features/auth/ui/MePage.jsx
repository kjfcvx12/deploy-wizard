import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'

import { useAuth } from './AuthProvider.jsx'
import DeleteAccountCard from './DeleteAccountCard.jsx'
import TokensCard from './TokensCard.jsx'
import { afterLogoutPath, deleteResultView, meViewState, safePictureUrl } from './authLogic.js'

const LOGOUT_FAILED_TEXT = '서버에서 로그아웃하지 못했습니다. 연결되면 다시 로그아웃해 주세요.'
const ECR_GUIDE_TEXT = 'AWS 콘솔의 ECR 에서 직접 지워 주세요. 요금이 나갈 수 있습니다.'

// 내 정보 (S-15) - 계정 정보·알림 설정 링크·로그아웃·계정 삭제. 끝난 뒤의 결과 화면은 세션이 없어도 보인다
export default function MePage() {
  const { config, configError, status, user, retryConfig, signOut, forgetAfterDelete } = useAuth()
  const navigate = useNavigate()
  // 끝난 뒤 보이는 화면 - { kind: 'deleted', message, leftovers } | { kind: 'logout_failed' }
  const [ended, setEnded] = useState(null)
  // 로그아웃 중 - 세션이 지워져도 로그인 화면으로 먼저 튕겨 나가지 않게 한다
  const [hold, setHold] = useState(false)
  const view = meViewState({ config, configError, status, ended: ended !== null, hold })

  // 결과 화면이 그려진 뒤에야 이 브라우저의 세션·저장값을 지운다
  useEffect(() => {
    if (ended?.kind === 'deleted') forgetAfterDelete()
  }, [ended, forgetAfterDelete])

  // 로그아웃 - 서버에서 못 끝냈으면 이 브라우저는 로그아웃하되 그 사실을 알린다
  async function logout() {
    setHold(true)
    const { serverLoggedOut } = await signOut()
    if (serverLoggedOut) {
      navigate(afterLogoutPath(config), { replace: true })
      return
    }
    setHold(false)
    setEnded({ kind: 'logout_failed' })
  }

  if (view.kind === 'loading') return <p className="muted">불러오는 중…</p>
  if (view.kind === 'hold') return <p className="muted">로그아웃하는 중…</p>
  if (view.kind === 'redirect') return <Navigate to={view.to} replace />

  if (view.kind === 'error') {
    return (
      <>
        <div className="notice err" style={{ marginTop: 0 }}>서버에 연결할 수 없습니다</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button onClick={retryConfig}>다시 시도</button>
        </div>
      </>
    )
  }

  if (view.kind === 'ended' && ended.kind === 'deleted') {
    return (
      <section className="card me-result">
        <h1 className="page-title">계정을 삭제했습니다</h1>
        <p>{ended.message}</p>
        {ended.leftovers.length > 0 && (
          <>
            <ul className="me-leftovers">
              {ended.leftovers.map((name) => <li key={name}><code>{name}</code></li>)}
            </ul>
            <div className="notice warn" role="alert">{ECR_GUIDE_TEXT}</div>
          </>
        )}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" onClick={() => navigate('/', { replace: true })}>처음으로</button>
        </div>
      </section>
    )
  }

  if (view.kind === 'ended') {
    return (
      <section className="card me-result">
        <h1 className="page-title">이 브라우저에서 로그아웃했습니다</h1>
        <div className="notice warn" role="alert">{LOGOUT_FAILED_TEXT}</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" onClick={() => navigate(afterLogoutPath(config), { replace: true })}>
            {config?.auth_required ? '로그인 화면으로' : '처음으로'}
          </button>
        </div>
      </section>
    )
  }

  const picture = safePictureUrl(user?.picture_url)
  return (
    <>
      <h1 className="page-title">내 정보</h1>

      <section className="card me-profile">
        <div className="me-who">
          {picture && <img className="me-photo" src={picture} alt="" width="48" height="48" referrerPolicy="no-referrer" />}
          <div className="me-id">
            {user?.name && <div className="me-name">{user.name}</div>}
            {user?.email && <div className="me-email muted">{user.email}</div>}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>알림</h2>
        <Link className="me-link" to="/notification-settings">알림 설정</Link>
      </section>

      <TokensCard />

      <section className="card">
        <h2>로그아웃</h2>
        <div className="row">
          <button onClick={logout}>로그아웃</button>
        </div>
      </section>

      <DeleteAccountCard onDeleted={(response) => setEnded({ kind: 'deleted', ...deleteResultView(response) })} />
    </>
  )
}
