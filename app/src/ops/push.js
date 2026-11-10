import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import * as Notifications from './notifications'
import { Platform } from 'react-native'
import { deviceApi } from '../api'
import { parseAppLink } from './links'

// 이 기기를 서버에 등록한 번호(p_d_id)만 저장한다 - 푸시 토큰은 어디에도 저장하지 않는다
const DEVICE_KEY = 'dw-push-device'
// 배포 상세의 한 번짜리 알림 안내 카드를 닫았는지
const CARD_KEY = 'dw-push-card-dismissed'
// 안드로이드 알림 채널 (SDK 58 문서의 등록 예시와 같은 순서: 채널 → 권한 → 토큰)
const CHANNEL_ID = 'default'
// IosAuthorizationStatus 값 (expo-notifications 타입 정의): 0 아직 안 물음, 1 거부, 2 허용, 3 임시 허용, 4 임시(App Clip)
const IOS_UNDETERMINED = 0
const IOS_DENIED = 1
const IOS_ALLOWED = [2, 3, 4]

const TOKEN_FAIL = '이 기기의 알림 주소를 받지 못했습니다. 잠시 뒤 다시 시도하세요.'
const REGISTER_FAIL = '서버에 이 기기를 등록하지 못했습니다'

// 앱 설정에 적힌 EAS 프로젝트 id - 없으면 null (스토어 빌드 준비 전)
const readProjectId = () => {
  const id = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId
  return typeof id === 'string' && id.trim() ? id : null
}

// OS 권한 응답을 앱 상태로 바꾼다 - 허용 / 아직 물을 수 있음(처음이거나 안드로이드에서 한 번 거부) / 거부
const permissionState = (permission) => {
  const ios = permission?.ios?.status
  if (permission?.granted === true || IOS_ALLOWED.includes(ios)) return 'granted'
  if (ios === IOS_DENIED) return 'denied'
  if (ios === IOS_UNDETERMINED || permission?.status === 'undetermined') return 'undetermined'
  return permission?.canAskAgain === true ? 'undetermined' : 'denied'
}

// 알림 상태 읽기 - 'unsupported'(웹·알림 모듈 없음) | 'no_project'(EAS 프로젝트 id 없음) | 'denied' | 'undetermined' | 'granted'. 권한 창을 띄우지 않고 던지지도 않는다
export async function getPushState() {
  if (Platform.OS === 'web') return 'unsupported'
  if (!readProjectId()) return 'no_project'
  try {
    return permissionState(await Notifications.getPermissionsAsync())
  } catch {
    return 'unsupported'
  }
}

// 저장된 기기 번호 읽기 - 없거나 이상한 값이거나 저장소가 막혔으면 null
export async function readPushDevice() {
  try {
    const id = Number(await AsyncStorage.getItem(DEVICE_KEY))
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

// 기기 번호 저장·삭제 - 저장소가 막혀도 던지지 않는다
const writePushDevice = async (p_d_id) => {
  try {
    await AsyncStorage.setItem(DEVICE_KEY, String(p_d_id))
  } catch {
    // 저장이 막힌 기기 - 이번 실행에서만 기억한다
  }
}
const clearPushDevice = async () => {
  try {
    await AsyncStorage.removeItem(DEVICE_KEY)
  } catch {
    // 지울 것도 없다
  }
}

// 안내 카드를 닫았는지 읽기 - 저장소가 막혔으면 false
export async function readCardDismissed() {
  try {
    return (await AsyncStorage.getItem(CARD_KEY)) === '1'
  } catch {
    return false
  }
}

// 안내 카드를 닫았다고 기억하기 - 막혀도 던지지 않는다
export async function writeCardDismissed() {
  try {
    await AsyncStorage.setItem(CARD_KEY, '1')
  } catch {
    // 저장이 막힌 기기 - 다음 실행에 카드가 다시 보일 수 있다
  }
}

// 오류에 토큰이 섞여 있으면 지운다 (서버 오류 문장이 입력을 되풀이할 수 있다) - 상태코드는 남긴다
const scrubbedError = (error, token) => {
  const text = typeof error?.message === 'string' && error.message ? error.message : REGISTER_FAIL
  const scrubbed = new Error(text.split(token).join('[토큰]'))
  if (error?.status) scrubbed.status = error.status
  return scrubbed
}

// 안드로이드 알림 채널 만들기 - 실패해도 등록은 계속한다
const ensureChannel = async () => {
  if (Platform.OS !== 'android') return
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, { name: '배포 마법사', importance: Notifications.AndroidImportance.HIGH })
  } catch {
    // 채널이 없으면 OS 기본 채널로 간다
  }
}

// 실제 등록 - 권한(필요하면 OS 창) → 토큰 → 서버 등록 → p_d_id 저장
async function register() {
  const before = await getPushState()
  if (before === 'unsupported' || before === 'no_project') return before
  await ensureChannel()
  let state = before
  try {
    if (state === 'undetermined') state = permissionState(await Notifications.requestPermissionsAsync())
  } catch {
    throw new Error(TOKEN_FAIL)
  }
  if (state !== 'granted') return 'denied'

  let token
  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId: readProjectId() }))?.data
  } catch {
    throw new Error(TOKEN_FAIL)
  }
  if (typeof token !== 'string' || !token) throw new Error(TOKEN_FAIL)

  let device
  try {
    device = await deviceApi.register({ expo_token: token, platform: Platform.OS })
  } catch (e) {
    throw scrubbedError(e, token)
  }
  const p_d_id = device?.p_d_id
  if (!Number.isInteger(p_d_id) || p_d_id < 1) throw new Error(REGISTER_FAIL)

  // 같은 토큰이면 서버가 같은 번호를 돌려준다 - 다르면(토큰이 바뀐 경우) 옛 기기를 지운다
  const previous = await readPushDevice()
  await writePushDevice(p_d_id)
  if (previous && previous !== p_d_id) {
    try {
      await deviceApi.remove(previous)
    } catch {
      // 옛 기기가 이미 없거나 서버에 닿지 않아도 새 등록은 유효하다
    }
  }
  return 'granted'
}

// 진행 중인 등록 하나 - 연타해도 서버에는 한 번만 보낸다
let inflight = null

// 알림 켜기 - 반드시 버튼 핸들러에서만 부른다 (앱 시작·화면 열림에서는 권한을 묻지 않는다). 새 상태를 돌려주고 토큰은 돌려주지도 남기지도 않는다
export function requestAndRegister() {
  if (!inflight) inflight = register().finally(() => { inflight = null })
  return inflight
}

// 알림 끄기 - 저장된 번호로 서버 등록을 지우고 저장소를 비운다. 404·오프라인이어도 던지지 않는다 (서버의 notify_push 는 따로 끈다)
export async function unregister() {
  const p_d_id = await readPushDevice()
  if (p_d_id) {
    try {
      await deviceApi.remove(p_d_id)
    } catch {
      // 이미 없거나(404) 서버에 닿지 않아도 이 기기에서는 등록이 없어진 것으로 본다
    }
  }
  await clearPushDevice()
}

// 알림을 눌렀을 때 갈 곳 - data.link 가 허용된 링크 두 가지일 때만 {route, params}, 그 밖은 모두 null
export function routeFromNotificationResponse(response) {
  const data = response?.notification?.request?.content?.data
  if (!data || typeof data !== 'object') return null
  return parseAppLink(data.link)
}
