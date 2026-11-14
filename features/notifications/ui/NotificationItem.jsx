import { formatTime } from '@shared/ui/time.js'

import { NOTIFICATION_KIND_BADGE, NOTIFICATION_KIND_ICON, NOTIFICATION_KIND_LABEL } from './constants.js'

// 알림 한 줄 - 종류 아이콘, 제목, 두 줄까지 본문, 시각. 읽지 않은 것은 굵은 제목과 점. 라벨에 종류와 제목을 넣어 같은 제목의 줄을 구분한다
export default function NotificationItem({ item, onPress }) {
  const unread = !item.read_at
  const kind = NOTIFICATION_KIND_LABEL[item.kind] || item.kind
  // 글자 모양 선택자(U+FE0E)를 붙여 ⚠ ✔ ✖ ‼ 가 색깔 이모지로 그려지지 않게 한다
  const icon = `${NOTIFICATION_KIND_ICON[item.kind] || '•'}︎`
  const time = formatTime(item.created_at)
  return (
    <button
      type="button"
      className={`notif-item${unread ? ' unread' : ''}`}
      aria-label={`${unread ? '읽지 않음 · ' : ''}${kind}: ${item.title}`}
      onClick={onPress}
    >
      <span className={`notif-icon ${NOTIFICATION_KIND_BADGE[item.kind] || ''}`} aria-hidden="true">{icon}</span>
      <span className="notif-body">
        <span className="notif-title">{item.title}</span>
        {item.body ? <span className="notif-text">{item.body}</span> : null}
        {time ? <span className="notif-time">{time}</span> : null}
      </span>
      {unread && <span className="notif-dot" aria-hidden="true" />}
    </button>
  )
}
