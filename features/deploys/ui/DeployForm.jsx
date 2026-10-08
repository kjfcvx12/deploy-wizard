import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import AccountPicker from '@features/accounts/ui/AccountPicker.jsx'

import { deployApi } from './api.js'

// 위: 연결 블록 고르기 (M6, 연결해 둔 것이 있을 때만). 아래: GitHub 주소 하나 - 직접 입력하거나, GitHub 연결을 골랐으면 그 계정의 레포 목록에서 고른다
// 브랜치는 고르고 싶을 때만 불러온다
export default function DeployForm() {
  const navigate = useNavigate()
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [remote, setRemote] = useState(null)
  const [awsAccountId, setAwsAccountId] = useState('')
  const [githubInstallationId, setGithubInstallationId] = useState('')
  const [repositories, setRepositories] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadBranches = async () => {
    setError('')
    setBusy(true)
    try {
      const data = await deployApi.getRemote(repoUrl.trim(), githubInstallationId)
      setRemote(data)
      setBranch(data.default_branch || '')
    } catch (e) {
      setRemote(null)
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const deploy = await deployApi.create(repoUrl.trim(), branch, awsAccountId, githubInstallationId)
      navigate(`/deploys/${deploy.d_id}`)
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>새 배포</h2>
      <AccountPicker
        awsAccountId={awsAccountId} onAwsAccountChange={setAwsAccountId}
        githubInstallationId={githubInstallationId} onGithubInstallationChange={setGithubInstallationId}
        onRepositoriesChange={setRepositories}
      />

      <div className="row">
        <input
          className="grow"
          list="deploy-repo-options"
          placeholder={repositories.length > 0 ? '레포를 고르거나 주소를 입력하세요' : 'https://github.com/소유자/레포'}
          value={repoUrl}
          onChange={(e) => { setRepoUrl(e.target.value); setRemote(null); setBranch('') }}
          required
        />
        <datalist id="deploy-repo-options">
          {repositories.map((repo) => (
            <option key={repo.full_name} value={repo.html_url}>{repo.private ? 'private' : 'public'}</option>
          ))}
        </datalist>
        {remote ? (
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            {remote.branches.map((name) => (
              <option key={name} value={name}>
                {name}{name === remote.default_branch ? ' (기본)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <button type="button" onClick={loadBranches} disabled={busy || !repoUrl.trim()}>브랜치 고르기</button>
        )}
        <button type="submit" className="primary" disabled={busy || !repoUrl.trim()}>배포</button>
      </div>

      <p className="muted small" style={{ margin: '10px 0 0' }}>
        브랜치를 고르지 않으면 레포의 기본 브랜치를 배포합니다.
        {githubInstallationId ? ` GitHub 연결을 골랐으니 private 레포도 됩니다${repositories.length > 0 ? ` — 입력창을 누르면 이 계정의 레포 ${repositories.length}개가 목록으로 나옵니다` : ''}.` : ' 지금은 public 레포만 됩니다 — private 레포는 위에서 GitHub 연결을 고르세요.'}
      </p>
      {error && <div className="notice err">{error}</div>}
    </form>
  )
}
