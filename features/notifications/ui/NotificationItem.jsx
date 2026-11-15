import { formatTime } from '@shared/ui/time.js'

import { NOTIFICATION_KIND_BADGE, NOTIFICATION_KIND_ICON, NOTIFICATION_KIND_LABEL } from './constants.js'

// 알림 한 줄 - 종류 아이콘, 제목, 본문 전체(줄바꿈 포함), 시각. 읽지 않은 것은 굵은 제목과 점. 스크린 리더에는 종류와 읽지 않음을 글로 앞에 붙여 읽어 준다
export default function NotificationItem({ item, onPress }) {
  const unread = !item.read_at
  const kind = NOTIFICATION_KIND_LABEL[item.kind] || item.kind || ''
  const prefix = `${unread ? '읽지 않음 · ' : ''}${kind ? `${kind}: ` : ''}`
  // 글자 모양 선택자(U+FE0E)를 붙여 ⚠ ✔ ✖ ‼ 가 색깔 이모지로 그려지지 않게 한다
  const icon = `${NOTIFICATION_KIND_ICON[item.kind] || '•'}︎`
  const time = formatTime(item.created_at)
  return (
    <button
      type="button"
      className={`notif-item${unread ? ' unread' : ''}`}
      onClick={onPress}
    >
      <span className={`notif-icon ${NOTIFICATION_KIND_BADGE[item.kind] || ''}`} aria-hidden="true">{icon}</span>
      <span className="notif-body">
        {prefix ? <span className="sr-only">{prefix}</span> : null}
        <span className="notif-title">{item.title ?? ''}</span>
        {item.body ? <span className="notif-text">{item.body}</span> : null}
        {time ? <span className="notif-time">{time}</span> : null}
      </span>
      {unread && <span className="notif-dot" aria-hidden="true" />}
    </button>
  )
}
