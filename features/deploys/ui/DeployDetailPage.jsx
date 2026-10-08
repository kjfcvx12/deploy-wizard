import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import ExplainCard from '@features/explains/ui/ExplainCard.jsx'

import { deployApi } from './api.js'
import { isProgress, repoName } from './constants.js'
import StatusBadge from './StatusBadge.jsx'
import StepProgress from './StepProgress.jsx'
import LogTerminal from './LogTerminal.jsx'
import IssueHistory from './IssueHistory.jsx'

const HEALTH_LABEL = { healthy: '응답 정상', unhealthy: '응답 없음', unknown: '확인 전' }

// 단계별 진행률, 터미널형 로그, 완료 시 클릭 가능한 링크 (M4) + 실패 해설과 선택지 (M5)
export default function DeployDetailPage() {
  const { d_id } = useParams()
  const navigate = useNavigate()
  const dialog = useRef(null)
  const stopDialog = useRef(null)

  const [deploy, setDeploy] = useState(null)
  const [logs, setLogs] = useState([])
  const [issues, setIssues] = useState([])
  const [health, setHealth] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [round, setRound] = useState(0)

  // 상태와 로그를 함께 폴링 - 로그는 마지막 d_l_id 이후 것만 받는다
  useEffect(() => {
    let alive = true
    let timer = null
    let after = 0
    setLogs([])

    const load = async () => {
      try {
        const [nextDeploy, nextLogs] = await Promise.all([deployApi.getOne(d_id), deployApi.getLogs(d_id, after)])
        if (!alive) return

        setDeploy(nextDeploy)
        setError('')
        if (nextLogs.length > 0) {
          after = nextLogs[nextLogs.length - 1].d_l_id
          setLogs((prev) => [...prev, ...nextLogs])
        }

        if (isProgress(nextDeploy.status) || nextLogs.length > 0) timer = setTimeout(load, 1500)
      } catch (e) {
        if (alive) setError(e.message)
      }
    }

    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [d_id, round])

  // 떠 있는 서비스만 헬스체크
  useEffect(() => {
    if (deploy?.status !== 'running') { setHealth(null); return }
    let alive = true
    deployApi.getHealth(d_id).then((data) => alive && setHealth(data)).catch(() => {})
    return () => { alive = false }
  }, [d_id, deploy?.status])

  // 문제 이력 - 다시 배포할 때, 실패가 막 쌓였을 때 새로 받는다
  useEffect(() => {
    let alive = true
    deployApi.getIssues(d_id).then((data) => alive && setIssues(data)).catch(() => {})
    return () => { alive = false }
  }, [d_id, round, deploy?.status])

  const redeploy = async () => {
    setBusy(true)
    setError('')
    try {
      await deployApi.redeploy(d_id)
      setRound((n) => n + 1)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  // 멈춤 - 요금이 나가는 서비스만 내린다. 이미지는 남아서 [다시 켜기]가 빌드 없이 끝난다
  const stop = async () => {
    stopDialog.current?.close()
    setBusy(true)
    setError('')
    try {
      await deployApi.stop(d_id)
      setRound((n) => n + 1)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      await deployApi.start(d_id)
      setRound((n) => n + 1)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    dialog.current?.close()
    setBusy(true)
    setError('')
    try {
      await deployApi.remove(d_id)
      navigate('/')
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  if (!deploy) {
    return error ? <div className="notice err">{error}</div> : <p className="muted">불러오는 중...</p>
  }

  const hasResources = Boolean(deploy.service_arn || deploy.image_uri)

  return (
    <>
      <p className="small"><Link to="/">← 목록</Link></p>

      <section className="card">
        <div className="row spread" style={{ marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0 }}>{repoName(deploy.repo_url)}</h2>
            <div className="deploy-meta">
              #{deploy.d_id}
              {deploy.branch && ` · ${deploy.branch}`}
              {deploy.commit_sha && ` · ${deploy.commit_sha.slice(0, 7)}`}
              {deploy.language && ` · ${deploy.language}`}
              {deploy.app_dir && deploy.app_dir !== '.' && ` · ${deploy.app_dir}/`}
            </div>
          </div>
          <div className="row">
            {deploy.support_level === 'experimental' && <span className="badge exp">실험 지원</span>}
            {deploy.fix_count > 0 && <span className="badge exp">자가수정 {deploy.fix_count}회</span>}
            <StatusBadge status={deploy.status} />
          </div>
        </div>

        <StepProgress status={deploy.status} errorStep={deploy.error_step} />
      </section>

      {deploy.status === 'running' && deploy.endpoint && (
        <section className="card">
          <div className="row spread">
            <a className="endpoint" href={deploy.endpoint} target="_blank" rel="noreferrer">{deploy.endpoint}</a>
            {health && <span className={`badge ${health.health === 'healthy' ? 'ok' : 'err'}`}>{HEALTH_LABEL[health.health]}</span>}
          </div>
          <p className="muted small" style={{ margin: '8px 0 0' }}>
            떠 있는 동안 로드밸런서와 컨테이너 요금이 계속 나옵니다. 잠시 안 쓸 거면 아래에서 [멈춤], 완전히 지울 거면 [삭제]를 누르세요.
          </p>
        </section>
      )}

      {deploy.status === 'stopped' && (
        <section className="card">
          <div className="row spread">
            <div>
              <strong>멈춘 상태입니다.</strong>
              <p className="muted small" style={{ margin: '6px 0 0' }}>
                컨테이너와 주소는 내려갔습니다. 이미지만 남겨 두었고(소액의 저장 요금), [다시 켜기]를 누르면 빌드 없이 같은 버전이 다시 뜹니다.
              </p>
            </div>
            <button className="primary" onClick={start} disabled={busy}>다시 켜기</button>
          </div>
        </section>
      )}

      {deploy.status === 'failed' && (
        <ExplainCard
          explain={deploy.explain}
          errorStep={deploy.error_step}
          errorMsg={deploy.error_msg}
          hasResources={hasResources}
          busy={busy}
          onRedeploy={redeploy}
          onCleanup={() => dialog.current?.showModal()}
        />
      )}

      {error && <div className="notice err" style={{ marginBottom: 16 }}>{error}</div>}

      <LogTerminal logs={logs} />

      {deploy.dockerfile && (
        <section className="card" style={{ marginTop: 16 }}>
          <details>
            <summary>
              Dockerfile <span className="muted small">({deploy.dockerfile_source} · 포트 {deploy.port})</span>
            </summary>
            <pre className="dockerfile">{deploy.dockerfile}</pre>
          </details>
        </section>
      )}

      <IssueHistory issues={issues} />

      {!isProgress(deploy.status) && deploy.status !== 'failed' && (
        <div className="row" style={{ marginTop: 16 }}>
          {deploy.status !== 'stopped' && <button onClick={redeploy} disabled={busy}>다시 배포</button>}
          {deploy.status === 'running' && <button onClick={() => stopDialog.current?.showModal()} disabled={busy}>멈춤</button>}
          <button className="danger" onClick={() => dialog.current?.showModal()} disabled={busy}>삭제</button>
        </div>
      )}

      <dialog ref={stopDialog}>
        <h2 style={{ marginTop: 0 }}>이 배포를 멈출까요?</h2>
        <p>ECS 서비스를 내려서 컨테이너 요금이 멈춥니다. 주소는 접속되지 않게 됩니다. 이미지와 설정은 남겨 두므로 [다시 켜기] 한 번으로 다시 띄울 수 있습니다.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={() => stopDialog.current?.close()}>그대로 두기</button>
          <button className="danger" onClick={stop}>멈춤</button>
        </div>
      </dialog>

      <dialog ref={dialog}>
        <h2 style={{ marginTop: 0 }}>이 배포를 삭제할까요?</h2>
        <p>AWS에 만든 ECS 서비스와 ECR 이미지가 함께 지워져 이 배포의 요금이 모두 멈춥니다. 되돌릴 수 없습니다.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={() => dialog.current?.close()}>그대로 두기</button>
          <button className="danger" onClick={remove}>삭제</button>
        </div>
      </dialog>
    </>
  )
}
