import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'

import { isValidId } from '@shared/ui/isValidId.js'
import NotFoundNotice from '@shared/ui/NotFoundNotice.jsx'
import SettingSwitch from '@shared/ui/SettingSwitch.jsx'

import { deployApi } from './api.js'
import { DEPLOY_NOT_FOUND_TEXT, repoName } from './constants.js'

const SAVED_TEXT = '저장했습니다'
// 저장 안내가 떠 있는 시간(ms)
const SAVED_MS = 3000

// 스위치 둘의 이름·설명 - 자동 복구는 재시작과 이전 버전으로 되돌리기만 한다는 점을 분명히 적는다 (업무 규칙 3)
const SETTINGS = [
  {
    field: 'auto_redeploy',
    title: '새 커밋이 오면 자동 재배포',
    description: '이 레포의 배포 브랜치에 새 커밋이 올라오면 마법사가 다시 배포합니다. 끄면 "새 커밋 있음" 표시만 남고, 직접 [다시 배포]를 눌러야 합니다.',
  },
  {
    field: 'auto_recover',
    title: '문제가 생기면 자동 복구',
    description: '실행 중인 서비스가 응답하지 않으면 마법사가 복구를 시도하고 무엇을 했는지 알려 드립니다. 자동 복구는 재시작과 이전 버전으로 되돌리기만 합니다. 삭제나 사양 변경은 직접 확인한 뒤에만 합니다.',
  },
]

// 서버 값에서 스위치 값을 읽는다 - 값이 없는 옛 응답은 서버 기본값(자동 복구 켜짐, 자동 재배포 꺼짐)으로 본다
const readValues = (deploy) => ({
  auto_redeploy: Boolean(deploy.auto_redeploy),
  auto_recover: deploy.auto_recover !== false,
})

// 배포 설정 화면 (S-14) - 주소의 d_id 가 바뀌면 화면을 새로 만들어 다른 배포의 상태가 남지 않게 한다
export default function DeploySettingsPage() {
  const { d_id } = useParams()
  if (!isValidId(d_id)) return <NotFoundNotice text={DEPLOY_NOT_FOUND_TEXT} />
  return <DeploySettings key={d_id} d_id={d_id} />
}

// 스위치 둘 - 누르면 저장 버튼 없이 바로 반영하고, 실패하면 되돌린다
function DeploySettings({ d_id }) {
  const navigate = useNavigate()
  const location = useLocation()
  const alive = useRef(false)
  const loadSeq = useRef(0)
  const valuesRef = useRef(null)
  const busyRef = useRef({})
  const timerRef = useRef(null)
  const messageRef = useRef(null)
  const noticeRef = useRef(null)

  const [deploy, setDeploy] = useState(null)
  const [values, setValues] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [busy, setBusy] = useState({})
  const [message, setMessageState] = useState(null)

  // 화면이 살아 있는 동안만 상태를 바꾼다 - 닫힌 뒤 늦게 오는 응답과 안내 타이머는 버린다
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimeout(timerRef.current)
    }
  }, [])

  // 처음 값을 한 번 받는다 (폴링 없음) - 다시 시도도 이 함수
  const load = useCallback(async () => {
    const mine = ++loadSeq.current
    setLoading(true)
    setLoadError(null)
    try {
      const result = await deployApi.getOne(d_id)
      if (!alive.current || mine !== loadSeq.current) return
      valuesRef.current = readValues(result)
      setDeploy(result)
      setValues(valuesRef.current)
    } catch (e) {
      if (alive.current && mine === loadSeq.current) setLoadError(e)
    } finally {
      if (alive.current && mine === loadSeq.current) setLoading(false)
    }
  }, [d_id])

  useEffect(() => { load() }, [load])

  // 안내는 스위치 아래에 띄워 스위치 자리가 밀리지 않게 하고, 화면 밖이면 보이는 곳까지만 스크롤한다
  useEffect(() => {
    if (message) noticeRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [message])

  // 안내를 바꾼다 - 지금 떠 있는 안내를 동기로 알 수 있게 ref 에도 둔다
  const setMessage = (next) => {
    messageRef.current = next
    setMessageState(next)
  }

  // 저장 안내를 띄우고 3초 뒤에 거둔다 - 실패 안내가 떠 있으면 덮어쓰지 않고, 타이머는 저장 안내만 지운다
  const showSaved = () => {
    if (messageRef.current?.tone === 'err') return
    clearTimeout(timerRef.current)
    setMessage({ tone: 'info', text: SAVED_TEXT })
    timerRef.current = setTimeout(() => {
      if (alive.current && messageRef.current?.tone !== 'err') setMessage(null)
    }, SAVED_MS)
  }

  // 실패 안내를 띄운다 - 저장 안내 타이머가 이 안내를 지우지 않게 타이머를 먼저 지운다
  const showError = (text) => {
    clearTimeout(timerRef.current)
    setMessage({ tone: 'err', text })
  }

  // 스위치 하나를 바꾼다 - 먼저 새 값으로 보이고, 같은 스위치는 응답이 올 때까지 잠근다. 실패하면 그 스위치만 되돌린다
  const toggle = async (field) => {
    if (busyRef.current[field] || !valuesRef.current) return
    const previous = valuesRef.current[field]
    const next = !previous
    busyRef.current[field] = true
    clearTimeout(timerRef.current)
    valuesRef.current = { ...valuesRef.current, [field]: next }
    setValues(valuesRef.current)
    setBusy((b) => ({ ...b, [field]: true }))
    setMessage(null)
    try {
      await deployApi.patchSettings(d_id, { [field]: next })
      if (alive.current) showSaved()
    } catch (e) {
      if (!alive.current) return
      valuesRef.current = { ...valuesRef.current, [field]: previous }
      setValues(valuesRef.current)
      showError(e.message)
      // 그 사이 배포가 지워졌으면 없는 배포 안내로 바꾼다
      if (e.status === 404) setLoadError(e)
    } finally {
      busyRef.current[field] = false
      if (alive.current) setBusy((b) => ({ ...b, [field]: false }))
    }
  }

  // 돌아간다 - 바로 연 화면이라 돌아갈 곳이 없으면 목록으로
  const leave = () => { if (location.key === 'default') navigate('/'); else navigate(-1) }

  if (loadError?.status === 404) {
    return (
      <>
        <div className="notice err" style={{ marginTop: 0 }}>{DEPLOY_NOT_FOUND_TEXT}</div>
        <div className="row" style={{ marginTop: 16 }}><button onClick={leave}>돌아가기</button></div>
      </>
    )
  }

  if (!values) {
    if (loading) return <p className="muted">불러오는 중...</p>
    return (
      <>
        <div className="notice err" style={{ marginTop: 0 }}>{loadError?.message}</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button onClick={load}>다시 시도</button>
          <button onClick={leave}>돌아가기</button>
        </div>
      </>
    )
  }

  return (
    <>
      <p className="small back-link"><Link to={`/deploys/${d_id}`}>← 배포로</Link></p>

      <h1 className="settings-heading">{`${repoName(deploy.repo_url)} · 배포 #${d_id}`}</h1>

      <div className="settings-list">
        {SETTINGS.map((setting) => (
          <SettingSwitch
            key={setting.field}
            title={setting.title}
            description={setting.description}
            checked={values[setting.field]}
            busy={!!busy[setting.field]}
            label={`${setting.title}, 배포 #${d_id}`}
            onToggle={() => { toggle(setting.field) }}
          />
        ))}
      </div>

      {/* 읽어 주는 영역은 항상 떠 있게 두고 안에 안내만 넣고 뺀다 - 비어 있다가 채워질 때 스크린 리더가 읽는다 */}
      <div role="status" aria-live="polite" aria-atomic="true">
        {!!message && <div ref={noticeRef} className={`notice ${message.tone}`} style={{ marginTop: 0, marginBottom: 12 }}>{message.text}</div>}
      </div>

      <p className="muted small">변경은 누르는 즉시 저장됩니다. 이미 진행 중인 배포에는 영향이 없습니다.</p>
    </>
  )
}
