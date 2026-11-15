import { Link } from 'react-router-dom'

import { unreadLabel } from './logic.js'
import { useUnreadCount } from './useUnreadCount.js'

// 상단 바의 알림 링크 - 읽지 않은 알림이 있으면 수를 알약으로 보여 준다 (99 를 넘으면 99+)
export default function BellLink() {
  const { count } = useUnreadCount()
  const label = unreadLabel(count)
  return (
    <Link to="/notifications" className="topbar-link bell-link" aria-label={label ? `알림, 읽지 않은 ${count}개` : '알림'}>
      알림
      {label && <span className="bell-count" aria-hidden="true">{label}</span>}
    </Link>
  )
}
