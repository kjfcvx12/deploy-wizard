import { useEffect, useRef } from 'react'

import { backoffDelay } from '@shared/ui/polling.js'
import { usePolling } from '@shared/ui/usePolling.js'

import { notificationApi } from './api.js'
import { UNREAD_CHANGED_EVENT } from './constants.js'

// 읽지 않은 알림 수를 가져오는 간격(ms)
const POLL_MS = 30000
// 실패가 이어질 때 늘려 가는 간격의 위쪽 한계(ms) - 5분
const MAX_BACKOFF_MS = 300000

// 읽지 않은 알림 수 - 30초마다 한 번만 가져오고(숨겨진 탭에서는 멈춤), 알림 화면에서 읽음 처리가 되면 바로 다시 받는다. 실패하면 0 (안내 없음), 실패가 이어지면 5분까지 간격을 늘린다
export function useUnreadCount() {
  const failsRef = useRef(0)
  const { data, error, refresh } = usePolling(() => notificationApi.getUnreadCount(), (value, failure) => {
    if (!failure) {
      failsRef.current = 0
      return POLL_MS
    }
    failsRef.current += 1
    return backoffDelay(POLL_MS, failsRef.current, MAX_BACKOFF_MS)
  }, [])

  // 같은 탭의 알림 화면이 읽음 처리를 하면 기다리지 않고 다시 받는다
  useEffect(() => {
    const onChanged = () => { refresh() }
    window.addEventListener(UNREAD_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(UNREAD_CHANGED_EVENT, onChanged)
  }, [refresh])

  const count = !error && Number.isInteger(data?.count) && data.count > 0 ? data.count : 0
  return { count, refresh }
}
