import { notificationApi } from '../api'
import { usePolling } from './usePolling'

// 읽지 않은 알림 수를 가져오는 간격(ms)
const POLL_MS = 30000

// 읽지 않은 알림 수 - 30초마다 가져오고 백그라운드에서는 멈춘다. 실패하면 0 (토스트 없음)
export function useUnreadCount() {
  const { data, error, refresh } = usePolling(() => notificationApi.getUnreadCount(), () => POLL_MS, [])
  const count = !error && Number.isInteger(data?.count) && data.count > 0 ? data.count : 0
  return { count, refresh }
}
