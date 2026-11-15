import { NOTIFICATION_KINDS } from './constants.js'

// 서버 id 는 32비트 양의 정수 (앞에 0 없이)
const MAX_ID = 2147483647
const ID_PATTERN = /^[1-9][0-9]{0,9}$/

// 알림 한 건의 id 를 검사한다 - 숫자나 숫자 글자만 받고, 범위 밖이면 null
function checkedId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const text = String(value)
  if (!ID_PATTERN.test(text) || Number(text) > MAX_ID) return null
  return text
}

// 알림을 눌렀을 때 갈 앱 안 경로 - incident_* 는 인시던트, 그 밖에는 배포 (id 가 믿을 수 없으면 null)
export function notificationRoute(item) {
  if (!item || typeof item !== 'object') return null
  if (typeof item.kind === 'string' && item.kind.startsWith('incident_')) {
    const id = checkedId(item.i_id)
    return id === null ? null : `/incidents/${id}`
  }
  const id = checkedId(item.d_id)
  return id === null ? null : `/deploys/${id}`
}

// 종류 스위치 하나를 바꾼 뒤의 목록 - 지금 값에서 서버 순서로 다시 만든다 (목록에 없는 종류는 버린다)
export const kindsAfterToggle = (current, kind) => {
  const has = current.includes(kind)
  return NOTIFICATION_KINDS.filter((k) => (k === kind ? !has : current.includes(k)))
}

// 서버 응답에서 화면 값을 읽는다 - 모르는 종류는 버리고 서버 순서(NOTIFICATION_KINDS)로 맞춘다
export function readSettingValues(settings) {
  return {
    notify_email: settings?.notify_email === true,
    notify_push: settings?.notify_push === true,
    kinds: NOTIFICATION_KINDS.filter((kind) => Array.isArray(settings?.kinds) && settings.kinds.includes(kind)),
  }
}

// 읽지 않은 수 배지 글 - 0 이하나 숫자가 아니면 빈 글자, 99 를 넘으면 99+
export function unreadLabel(count) {
  if (typeof count !== 'number' || !(count > 0)) return ''
  return count > 99 ? '99+' : String(count)
}
