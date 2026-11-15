import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'

import { deployApi } from '@features/deploys/ui/api.js'
import StopDialog from '@features/deploys/ui/StopDialog.jsx'
import { isValidId } from '@shared/ui/isValidId.js'
import NotFoundNotice from '@shared/ui/NotFoundNotice.jsx'
import { backoffDelay } from '@shared/ui/polling.js'
import { durationText, formatTime } from '@shared/ui/time.js'
import { usePolling } from '@shared/ui/usePolling.js'

import { incidentApi } from './api.js'
import { INCIDENT_ACTIVE_STATUSES, INCIDENT_KIND_LABEL } from './constants.js'
import HealthBar from './HealthBar.jsx'
import IncidentBadge from './IncidentBadge.jsx'
import IncidentExplain from './IncidentExplain.jsx'
import IncidentTimeline from './IncidentTimeline.jsx'

// 갱신 간격(ms) - 처리 중에는 5초마다, 연결 실패가 이어지면 5, 10, 20초로 늘려 최대 30초까지 (404 와 끝난 상태 뒤의 실패는 다시 부르지 않는다)
const POLL_MS = 5000
// 헬스 이력은 처음·상태가 바뀔 때·수동 새로 고침 때 받고, 그 밖에는 60초에 한 번만
const HEALTH_HOURS = 24
const HEALTH_REFRESH_MS = 60000
const NOT_FOUND_TEXT = '문제를 찾을 수 없습니다. 이미 삭제된 배포이거나 지워진 기록일 수 있습니다.'

// 인시던트 상세 화면 (S-13) - 주소의 i_id 가 바뀌면 화면을 새로 만들어 다른 인시던트의 상태가 남지 않게 한다
export default function IncidentDetailPage() {
  const { i_id } = useParams()
  if (!isValidId(i_id)) return <NotFoundNotice text={NOT_FOUND_TEXT} />
  return <IncidentDetail key={i_id} i_id={i_id} />
}

// 인시던트 한 건: 원인·고칠 곳·마법사가 한 일·헬스 이력. 확인이 필요할 때만 사용자가 누르는 버튼이 있다
function IncidentDetail({ i_id }) {
  const navigate = useNavigate()
  const location = useLocation()
  const stopDialog = useRef(null)
  const alive = useRef(false)
  const busyRef = useRef(false)
  const failsRef = useRef(0)
  const statusRef = useRef(null)
  const forceHistoryRef = useRef(false)
  const lastHistoryAt = useRef(0)
  const historySeq = useRef(0)

  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [copyError, setCopyError] = useState('')
  const [notice, setNotice] = useState('')
  const [acted, setActed] = useState(false)
  // 헬스 이력 - undefined 면 아직 받는 중(막대를 그리지 않음), null 이면 한 번도 받지 못함, 배열이면 받은 이력
  const [checks, setChecks] = useState(undefined)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // 인시던트만 폴링한다 - 헬스 이력은 아래에서 따로 받아 느려도 갱신을 붙잡지 않는다
  const { data: incident, error, loading, refresh: poll } = usePolling(() => incidentApi.getOne(i_id), (value, failure) => {
    if (!failure) {
      failsRef.current = 0
      return INCIDENT_ACTIVE_STATUSES.includes(value.status) ? POLL_MS : null
    }
    if (failure.status === 404) return null
    // 끝난 상태(해결됨·확인 필요)를 받아 둔 뒤의 실패는 다시 부르지 않는다 - 수동 새로 고침만
    if (value && !INCIDENT_ACTIVE_STATUSES.includes(value.status)) return null
    failsRef.current += 1
    return backoffDelay(POLL_MS, failsRef.current)
  }, [i_id])

  // 지금 바로 새로 받는다 (새로 고침 버튼·동작 뒤) - 헬스 이력도 60초를 기다리지 않는다
  const refresh = useCallback(() => { forceHistoryRef.current = true; return poll() }, [poll])

  // 헬스 이력 - 첫 응답, 상태 변경, 수동 새로 고침, 60초 경과 때만. 실패하면 지난 이력은 그대로 두고, 받은 적이 없으면 못 받았다고 알린다
  useEffect(() => {
    if (!incident) return
    const changed = statusRef.current !== incident.status
    statusRef.current = incident.status
    const now = Date.now()
    if (!changed && !forceHistoryRef.current && now - lastHistoryAt.current < HEALTH_REFRESH_MS) return
    forceHistoryRef.current = false
    lastHistoryAt.current = now
    const mine = ++historySeq.current
    deployApi.getHealthHistory(incident.d_id, HEALTH_HOURS)
      .then((result) => { if (alive.current && mine === historySeq.current) setChecks(result) })
      .catch(() => { if (alive.current && mine === historySeq.current) setChecks((prev) => (Array.isArray(prev) ? prev : null)) })
  }, [incident])

  // 동작 실패나 안내가 생기면 맨 위로 올려 보여 준다
  useEffect(() => {
    if (actionError || copyError || notice) window.scrollTo?.({ top: 0 })
  }, [actionError, copyError, notice])

  // 동작 하나를 실행한다 - 실행하는 동안 버튼을 잠그고(더블 클릭 방지), 성공하면 안내를 띄우고 다시 받고, 실패하면 빨간 알림을 띄운다
  const perform = async (call, doneMessage) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setActionError('')
    setNotice('')
    try {
      await call()
      if (!alive.current) return
      setActed(true)
      setNotice(doneMessage)
      refresh()
    } catch (e) {
      if (alive.current) setActionError(e.message)
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }

  // 그대로 두기 - 아무것도 바꾸지 않고 돌아간다 (바로 연 화면이라 돌아갈 곳이 없으면 목록으로)
  const leave = () => { if (location.key === 'default') navigate('/'); else navigate(-1) }
  const redeploy = () => { perform(() => deployApi.redeploy(incident.d_id), '다시 배포를 시작했습니다. 진행 상황은 [배포 보기]에서 확인하세요.') }
  const stop = () => {
    stopDialog.current?.close()
    perform(() => deployApi.stop(incident.d_id), '멈추도록 요청했습니다. 진행 상황은 [배포 보기]에서 확인하세요.')
  }

  if (error?.status === 404) {
    // 인시던트나 배포가 지워졌다 - 처음 열 때든 보던 중이든 같은 안내
    return (
      <>
        <div className="notice err" style={{ marginTop: 0 }}>{NOT_FOUND_TEXT}</div>
        <div className="row" style={{ marginTop: 16 }}><button onClick={leave}>돌아가기</button></div>
      </>
    )
  }

  if (!incident) {
    if (loading) return <p className="muted">불러오는 중...</p>
    return (
      <>
        <div className="notice err" style={{ marginTop: 0 }}>{error?.message}</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button onClick={refresh}>다시 시도</button>
          <button onClick={leave}>돌아가기</button>
        </div>
      </>
    )
  }

  const needsAction = incident.status === 'needs_action' && !acted
  const finished = incident.resolved_at ? durationText(incident.detected_at, incident.resolved_at) : ''

  return (
    <>
      {!!error && <div className="notice err" style={{ marginTop: 0, marginBottom: 16 }}>{error.message}</div>}
      {!!actionError && <div className="notice err" style={{ marginTop: 0, marginBottom: 16 }}>{actionError}</div>}
      {!!copyError && <div className="notice err" style={{ marginTop: 0, marginBottom: 16 }} role="alert">{copyError}</div>}
      {!!notice && <div className="notice info" style={{ marginTop: 0, marginBottom: 16 }}>{notice}</div>}

      <section className="card">
        <div className="row spread incident-head">
          <h1 className="incident-title">{incident.summary || incident.explain?.summary || '문제가 감지되었습니다'}</h1>
          <IncidentBadge status={incident.status} />
        </div>
        <p className="deploy-meta incident-meta">
          {`배포 #${incident.d_id} · ${INCIDENT_KIND_LABEL[incident.kind] || incident.kind} · 감지 ${formatTime(incident.detected_at)}`}
          {incident.status === 'resolved' && incident.resolved_at ? ` · 해결 ${formatTime(incident.resolved_at)}${finished ? ` (${finished})` : ''}` : ''}
        </p>
        {INCIDENT_ACTIVE_STATUSES.includes(incident.status) && (
          <p className="deploy-meta incident-meta">마법사가 복구를 시도하고 있습니다. 이 화면은 5초마다 새로 고쳐집니다.</p>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={refresh} disabled={busy}>새로 고침</button>
        </div>
      </section>

      <IncidentExplain explain={incident.explain} onCopyError={setCopyError} />

      <section className="card"><IncidentTimeline incident={incident} /></section>

      {checks !== undefined && <section className="card"><HealthBar checks={checks} hours={HEALTH_HOURS} /></section>}

      {needsAction ? (
        <div className="incident-actions">
          <div className="row">
            <button className="primary" onClick={redeploy} disabled={busy}>다시 배포</button>
            <button onClick={() => stopDialog.current?.showModal()} disabled={busy}>멈춤</button>
            <button onClick={leave} disabled={busy}>그대로 두기</button>
          </div>
          <p className="muted small">아무것도 누르지 않으면 그대로 둡니다. 마법사가 자동으로 지우거나 바꾸지 않습니다.</p>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 16 }}>
          <Link className="link-button" to={`/deploys/${incident.d_id}`}>배포 보기</Link>
        </div>
      )}

      <StopDialog dialogRef={stopDialog} onStop={stop} />
    </>
  )
}
