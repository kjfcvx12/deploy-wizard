import { request } from '@shared/ui/api.js'

// 쿼리 문자열을 만든다 - 값이 없는(null, undefined, 빈 글자) 항목은 뺀다
const queryString = (params) => {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

// features/notifications/router.py 와 1:1 (기기 등록은 앱 전용이라 웹에는 없다)
export const notificationApi = {
  getAll: ({ after, unread } = {}) => request(`/api/notifications${queryString({ after, unread: unread ? 'true' : null })}`),
  getUnreadCount: () => request('/api/notifications/unread-count'),
  read: (n_id) => request(`/api/notifications/${n_id}/read`, { method: 'POST' }),
  readAll: () => request('/api/notifications/read-all', { method: 'POST' }),
  getSettings: () => request('/api/notifications/settings'),
  patchSettings: (body) => request('/api/notifications/settings', { method: 'PATCH', body }),
}
