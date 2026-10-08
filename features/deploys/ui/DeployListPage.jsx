import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { deployApi } from './api.js'
import { isProgress, repoName } from './constants.js'
import DeployForm from './DeployForm.jsx'
import StatusBadge from './StatusBadge.jsx'

// 입력 + 내가 배포한 서비스 목록과 현재 상태 (M4)
export default function DeployListPage() {
  const [deploys, setDeploys] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    let timer = null

    const load = async () => {
      try {
        const data = await deployApi.getAll()
        if (!alive) return
        setDeploys(data)
        setError('')
        // 진행 중인 것이 있을 때만 자주 본다
        timer = setTimeout(load, data.some((d) => isProgress(d.status)) ? 3000 : 15000)
      } catch (e) {
        if (!alive) return
        setError(e.message)
        timer = setTimeout(load, 10000)
      }
    }

    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [])

  return (
    <>
      <DeployForm />

      <section className="card">
        <h2>내 배포</h2>
        {error && <div className="notice err">서버에 연결할 수 없습니다 :{error}</div>}
        {deploys && deploys.length === 0 && <p className="muted">아직 배포한 것이 없습니다.</p>}
        {deploys?.map((deploy) => (
          <Link key={deploy.d_id} to={`/deploys/${deploy.d_id}`} className="deploy-item">
            <div>
              <div className="deploy-name">{repoName(deploy.repo_url)}</div>
              <div className="deploy-meta">
                #{deploy.d_id}
                {deploy.branch && ` · ${deploy.branch}`}
                {deploy.language && ` · ${deploy.language}`}
                {deploy.endpoint && ` · ${deploy.endpoint.replace('https://', '')}`}
              </div>
            </div>
            <StatusBadge status={deploy.status} />
          </Link>
        ))}
      </section>
    </>
  )
}
