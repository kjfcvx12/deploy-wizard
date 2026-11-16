import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import SettingSwitch from '@shared/ui/SettingSwitch.jsx'

import { notificationApi } from './api.js'
import { KIND_HINT, MAIL_HINT, NOTIFICATION_KINDS, NOTIFICATION_KIND_LABEL, PUSH_HINT_WEB } from './constants.js'
import { kindsAfterToggle, readSettingValues } from './logic.js'

const SAVED_TEXT = '저장했습니다'
// 저장 안내가 떠 있는 시간(ms)
const SAVED_MS = 3000

// 알림 설정 화면 (S-15 로그인 없이) - 스위치를 누르면 저장 버튼 없이 바로 반영하고, 실패하면 되돌린다
export default function NotificationSettingsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const alive = useRef(false)
  const loadSeq = useRef(0)
  const valuesRef = useRef(null)
  const busyRef = useRef({})
  const timerRef = useRef(null)
  const messageRef = useRef(null)
  const noticeRef = useRef(null)

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
      const settings = await notificationApi.getSettings()
      if (!alive.current || mine !== loadSeq.current) return
      valuesRef.current = readSettingValues(settings)
      setValues(valuesRef.current)
    } catch (e) {
      if (alive.current && mine === loadSeq.current) setLoadError(e)
    } finally {
      if (alive.current && mine === loadSeq.current) setLoading(false)
    }
  }, [])

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

  // 같은 스위치(묶음)가 응답을 기다리는 동안은 다시 누를 수 없다 - 종류 스위치는 목록 전체를 한 번에 보내므로 한 묶음이다
  const lock = (key, on) => {
    busyRef.current[key] = on
    if (alive.current) setBusy((b) => ({ ...b, [key]: on }))
  }

  // 화면 값을 일부만 바꾼다
  const setLocal = (patch) => {
    valuesRef.current = { ...valuesRef.current, ...patch }
    setValues(valuesRef.current)
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

  // 값을 먼저 바꿔 보이고 서버에 보낸다 - 실패하면 이 요청이 바꾼 값만 되돌리고 서버 메시지를 보인다
  const save = async (key, patch) => {
    if (busyRef.current[key] || !valuesRef.current) return
    const previous = Object.fromEntries(Object.keys(patch).map((field) => [field, valuesRef.current[field]]))
    lock(key, true)
    clearTimeout(timerRef.current)
    setLocal(patch)
    setMessage(null)
    try {
      await notificationApi.patchSettings(patch)
      if (alive.current) showSaved()
    } catch (e) {
      if (alive.current) {
        setLocal(previous)
        showError(e.message)
      }
    } finally {
      lock(key, false)
    }
  }

  // 메일·푸시 스위치 하나를 바꾼다 - 보내는 것은 그 필드 하나뿐
  const toggleField = (field) => {
    if (!valuesRef.current) return
    save(field, { [field]: !valuesRef.current[field] })
  }

  // 종류 스위치 하나를 바꾼다 - 목록 전체를 서버 순서로, 눌린 줄이 아니라 지금 값에서 다시 만들어 보낸다
  const toggleKind = (kind) => {
    if (!valuesRef.current) return
    save('kinds', { kinds: kindsAfterToggle(valuesRef.current.kinds, kind) })
  }

  // 돌아간다 - 바로 연 화면이라 돌아갈 곳이 없으면 알림 목록으로
  const leave = () => { if (location.key === 'default') navigate('/notifications'); else navigate(-1) }

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
      <p className="small back-link"><Link to="/notifications">← 알림</Link></p>

      <h1 className="settings-heading">알림 설정</h1>

      <h2 className="settings-group-title">받는 방법</h2>
      <div className="settings-list">
        <SettingSwitch
          title="메일 받기"
          description={MAIL_HINT}
          checked={values.notify_email}
          busy={!!busy.notify_email}
          label="메일 받기"
          onToggle={() => { toggleField('notify_email') }}
        />
        <SettingSwitch
          title="푸시 받기"
          description={PUSH_HINT_WEB}
          checked={values.notify_push}
          busy={!!busy.notify_push}
          label="푸시 받기"
          onToggle={() => { toggleField('notify_push') }}
        />
      </div>

      <h2 className="settings-group-title">알림 종류</h2>
      <div className="settings-list">
        {NOTIFICATION_KINDS.map((kind) => (
          <SettingSwitch
            key={kind}
            title={NOTIFICATION_KIND_LABEL[kind]}
            description={KIND_HINT[kind]}
            checked={values.kinds.includes(kind)}
            busy={!!busy.kinds}
            label={`${NOTIFICATION_KIND_LABEL[kind]} 알림`}
            onToggle={() => { toggleKind(kind) }}
          />
        ))}
      </div>

      {/* 읽어 주는 영역은 항상 떠 있게 두고 안에 안내만 넣고 뺀다 - 비어 있다가 채워질 때 스크린 리더가 읽는다 */}
      <div role="status" aria-live="polite" aria-atomic="true">
        {!!message && <div ref={noticeRef} className={`notice ${message.tone}`} style={{ marginTop: 0, marginBottom: 12 }}>{message.text}</div>}
      </div>

      <p className="muted small">끈 종류는 알림 목록에도 남지 않습니다. 변경은 누르는 즉시 저장됩니다.</p>
    </>
  )
}
