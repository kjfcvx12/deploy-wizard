import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { notificationApi } from './api.js'
import { UNREAD_CHANGED_EVENT } from './constants.js'
import { notificationRoute } from './logic.js'
import NotificationItem from './NotificationItem.jsx'

// 서버가 한 번에 주는 건수 - 이만큼 받았으면 더 있을 수 있다
const PAGE_SIZE = 100
// 같은 줄을 연달아 누른 것으로 보는 시간(ms)
const DOUBLE_TAP_MS = 600

// 지금 받은 목록에서 가장 오래된 n_id - 다음 쪽을 받을 기준(after)
const oldestId = (items) => items.reduce((min, item) => Math.min(min, item.n_id), Infinity)

// 읽지 않은 수가 바뀌었다고 상단 바에 알린다 (이 화면이 닫힌 뒤에도 보낸다)
const announceUnreadChanged = () => window.dispatchEvent(new Event(UNREAD_CHANGED_EVENT))

// 알림 목록 화면 (S-12) - 읽지 않은 것은 굵게 + 점, 누르면 읽음 처리 후 관련 화면으로 간다
export default function NotificationsPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [moreError, setMoreError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [moreBusy, setMoreBusy] = useState(false)
  const [readAllBusy, setReadAllBusy] = useState(false)
  // 화면이 살아 있는지, 가장 최근 목록 번호, 같은 순간의 두 번째 누름 막기
  const alive = useRef(true)
  const loadSeq = useRef(0)
  const itemsRef = useRef(null)
  const moreBusyRef = useRef(false)
  const readAllRef = useRef(false)
  const pendingReads = useRef(new Set())
  const markSeq = useRef(0)
  const lastTap = useRef({ n_id: null, at: 0 })

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // 목록을 바꾼다 (최신 값을 ref 에도 둬서 비동기 안에서 읽을 수 있게)
  const put = (next) => {
    itemsRef.current = next
    setItems(next)
  }

  // 처음 쪽을 받아 목록을 바꾼다 - 늦게 온 응답은 버린다
  const load = async () => {
    const id = ++loadSeq.current
    try {
      const page = await notificationApi.getAll({})
      if (!alive.current || id !== loadSeq.current) return
      put(page)
      setHasMore(page.length >= PAGE_SIZE)
      setError('')
      setMoreError('')
    } catch (e) {
      if (!alive.current || id !== loadSeq.current) return
      setError(e.message)
    }
  }

  useEffect(() => { load() }, [])

  // 다음 쪽을 이어 붙인다 - after 는 가장 오래된 n_id, 이미 있는 n_id 는 건너뛴다. 받는 중 새로 고침이 끼면 이 응답은 버린다
  const loadMore = async () => {
    if (moreBusyRef.current || !itemsRef.current || itemsRef.current.length === 0) return
    moreBusyRef.current = true
    setMoreBusy(true)
    setMoreError('')
    const id = loadSeq.current
    try {
      const page = await notificationApi.getAll({ after: oldestId(itemsRef.current) })
      if (!alive.current || id !== loadSeq.current) return
      const seen = new Set(itemsRef.current.map((item) => item.n_id))
      put([...itemsRef.current, ...page.filter((item) => !seen.has(item.n_id))])
      setHasMore(page.length >= PAGE_SIZE)
    } catch (e) {
      if (alive.current && id === loadSeq.current) setMoreError(e.message)
    } finally {
      moreBusyRef.current = false
      if (alive.current) setMoreBusy(false)
    }
  }

  // 표시한 읽음 값을 되돌린다 - 그사이 다른 값으로 바뀐 줄은 건드리지 않는다
  const rollback = (marker, ids) => {
    put(itemsRef.current.map((item) => (ids.includes(item.n_id) && item.read_at === marker ? { ...item, read_at: null } : item)))
  }

  // 줄을 누르면: 읽지 않은 것은 먼저 읽음으로 보이고(요청은 뒤에서) 관련 화면으로 간다. 실패하면 되돌리고 알린다
  const onItem = (item) => {
    const now = Date.now()
    if (pendingReads.current.has(item.n_id)) return
    if (lastTap.current.n_id === item.n_id && now - lastTap.current.at < DOUBLE_TAP_MS) return
    lastTap.current = { n_id: item.n_id, at: now }
    setActionError('')
    const route = notificationRoute(item)
    if (!item.read_at) {
      const marker = `pending-${++markSeq.current}`
      pendingReads.current.add(item.n_id)
      put(itemsRef.current.map((row) => (row.n_id === item.n_id ? { ...row, read_at: marker } : row)))
      notificationApi.read(item.n_id)
        .then((saved) => {
          announceUnreadChanged()
          if (!alive.current) return
          const stamp = (saved && saved.read_at) || new Date().toISOString()
          put(itemsRef.current.map((row) => (row.n_id === item.n_id && row.read_at === marker ? { ...row, read_at: stamp } : row)))
        })
        .catch((e) => {
          if (!alive.current) return
          rollback(marker, [item.n_id])
          setActionError(`읽음으로 표시하지 못했습니다 :${e.message}`)
        })
        .finally(() => { pendingReads.current.delete(item.n_id) })
    }
    if (route) navigate(route)
  }

  // 모두 읽음 - 읽지 않던 줄만 먼저 읽음으로 보이고, 실패하면 그 줄들만 되돌린다
  const onReadAll = async () => {
    if (readAllRef.current || !itemsRef.current) return
    const ids = itemsRef.current.filter((item) => !item.read_at).map((item) => item.n_id)
    if (ids.length === 0) return
    readAllRef.current = true
    setReadAllBusy(true)
    setActionError('')
    const marker = `pending-all-${++markSeq.current}`
    put(itemsRef.current.map((item) => (ids.includes(item.n_id) ? { ...item, read_at: marker } : item)))
    try {
      await notificationApi.readAll()
      announceUnreadChanged()
      if (!alive.current) return
      const stamp = new Date().toISOString()
      put(itemsRef.current.map((item) => (item.read_at === marker ? { ...item, read_at: stamp } : item)))
    } catch (e) {
      if (!alive.current) return
      rollback(marker, ids)
      setActionError(`모두 읽음으로 표시하지 못했습니다 :${e.message}`)
    } finally {
      readAllRef.current = false
      if (alive.current) setReadAllBusy(false)
    }
  }

  const hasItems = !!items && items.length > 0
  const hasUnread = hasItems && items.some((item) => !item.read_at)
  return (
    <>
      <div className="row spread notif-head">
        <h2 className="notif-heading">알림</h2>
        <div className="row">
          <Link to="/notification-settings" className="link-button">알림 설정</Link>
          <button type="button" onClick={() => { load() }}>새로 고침</button>
          <button type="button" onClick={() => { onReadAll() }} disabled={readAllBusy || !hasUnread}>모두 읽음</button>
        </div>
      </div>

      {items && error && <p className="notice err">{`새로 받지 못했습니다 :${error}`}</p>}
      {actionError && <p className="notice err" role="alert">{actionError}</p>}

      {!items && !error && <p className="muted">불러오는 중…</p>}
      {!items && error && (
        <div className="notif-error">
          <p className="notice err">{`서버에 연결할 수 없습니다 :${error}`}</p>
          <button type="button" onClick={() => { load() }}>다시 시도</button>
        </div>
      )}
      {items && items.length === 0 && <p className="muted notif-empty">새 알림이 없습니다</p>}

      {hasItems && (
        <ul className="notif-list">
          {items.map((item) => (
            <li key={item.n_id}><NotificationItem item={item} onPress={() => onItem(item)} /></li>
          ))}
        </ul>
      )}

      {hasItems && hasMore && (
        <div className="notif-more">
          {moreError && <p className="notice err">{`더 받지 못했습니다 :${moreError}`}</p>}
          <button type="button" onClick={() => { loadMore() }} disabled={moreBusy}>더 보기</button>
        </div>
      )}
    </>
  )
}
