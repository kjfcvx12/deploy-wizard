import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import AccountPicker from '@features/accounts/ui/AccountPicker.jsx'
import AdvicePanel from '@features/advice/ui/AdvicePanel.jsx'
import { adviceApi } from '@features/advice/ui/api.js'

import { deployApi } from './api.js'

// 위: 연결 블록 고르기 (M6, 연결해 둔 것이 있을 때만). 아래: GitHub 주소 하나 - 직접 입력하거나, GitHub 연결을 골랐으면 그 계정의 레포 목록에서 고른다
// 브랜치는 고르고 싶을 때만 불러온다
// 두 단계: [분석](읽기만 함) -> 결과를 보고 [이 레포로 배포]. 입력이 바뀌면 이전 분석 결과는 지운다
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
  const [advice, setAdvice] = useState(null)
  const [analyzing, setAnalyzing] = useState(false)
  // 분석 요청 번호 - 입력이 바뀐 뒤 늦게 도착한 결과를 버리고, 같은 순간의 두 번째 클릭을 막는다
  const analysisId = useRef(0)
  const inflight = useRef(false)

  // 입력이 바뀌면 이전 분석 결과를 지운다 (낡은 결과로 배포하지 않게). 진행 중인 분석 결과도 버린다
  const invalidate = () => {
    analysisId.current += 1
    inflight.current = false
    setAdvice(null)
    setAnalyzing(false)
  }

  const loadBranches = async () => {
    setError('')
    setBusy(true)
    try {
      const data = await deployApi.getRemote(repoUrl.trim(), githubInstallationId)
      setRemote(data)
      setBranch(data.default_branch || '')
      invalidate()
    } catch (e) {
      setRemote(null)
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  // 분석 - 레포를 읽기만 한다 (AWS 에 아무것도 만들지 않는다)
  const submit = async (event) => {
    event.preventDefault()
    if (busy || analyzing || inflight.current) return
    inflight.current = true
    const id = ++analysisId.current
    setError('')
    setAdvice(null)
    setAnalyzing(true)
    try {
      const data = await adviceApi.analyze({
        repo_url: repoUrl.trim(), branch, aws_account_id: awsAccountId, github_installation_id: githubInstallationId,
      })
      if (id === analysisId.current) setAdvice(data)
    } catch (e) {
      if (id === analysisId.current) setError(e.message)
    } finally {
      if (id === analysisId.current) { inflight.current = false; setAnalyzing(false) }
    }
  }

  // 분석 결과를 본 뒤 배포 - 입력이 바뀌면 결과가 지워지므로 분석한 그대로의 입력으로 만든다
  const deploy = async () => {
    if (busy || analyzing) return
    setError('')
    setBusy(true)
    try {
      const created = await deployApi.create(repoUrl.trim(), branch, awsAccountId, githubInstallationId)
      navigate(`/deploys/${created.d_id}`)
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <>
    <form className="card" onSubmit={submit}>
      <h2>새 배포</h2>
      <AccountPicker
        awsAccountId={awsAccountId} onAwsAccountChange={(value) => { setAwsAccountId(value); invalidate() }}
        githubInstallationId={githubInstallationId} onGithubInstallationChange={(value) => { setGithubInstallationId(value); invalidate() }}
        onRepositoriesChange={setRepositories}
      />

      <div className="row">
        <input
          className="grow"
          list="deploy-repo-options"
          placeholder={repositories.length > 0 ? '레포를 고르거나 주소를 입력하세요' : 'https://github.com/소유자/레포'}
          value={repoUrl}
          onChange={(e) => { setRepoUrl(e.target.value); setRemote(null); setBranch(''); invalidate() }}
          required
        />
        <datalist id="deploy-repo-options">
          {repositories.map((repo) => (
            <option key={repo.full_name} value={repo.html_url}>{repo.private ? 'private' : 'public'}</option>
          ))}
        </datalist>
        {remote ? (
          <select value={branch} onChange={(e) => { setBranch(e.target.value); invalidate() }}>
            {remote.branches.map((name) => (
              <option key={name} value={name}>
                {name}{name === remote.default_branch ? ' (기본)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <button type="button" onClick={loadBranches} disabled={busy || analyzing || !repoUrl.trim()}>브랜치 고르기</button>
        )}
        <button type="submit" className="primary" disabled={busy || analyzing || !repoUrl.trim()}>{analyzing ? '분석 중...' : '분석'}</button>
      </div>

      <p className="muted small" style={{ margin: '10px 0 0' }}>
        브랜치를 고르지 않으면 레포의 기본 브랜치를 분석합니다.
        {githubInstallationId ? ` GitHub 연결을 골랐으니 private 레포도 됩니다${repositories.length > 0 ? ` — 입력창을 누르면 이 계정의 레포 ${repositories.length}개가 목록으로 나옵니다` : ''}.` : ' 지금은 public 레포만 됩니다 — private 레포는 위에서 GitHub 연결을 고르세요.'}
      </p>
      {error && !advice && <div className="notice err">{error}</div>}
    </form>
    <AdvicePanel advice={advice} busy={busy || analyzing} onDeploy={deploy} onReset={invalidate} />
    {advice && error && <div className="notice err advice-error">{error}</div>}
    </>
  )
}
