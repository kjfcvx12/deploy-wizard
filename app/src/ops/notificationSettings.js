import { NOTIFICATION_KINDS } from './constants'

export const MAIL_HINT = '서버에 메일 설정이 있을 때만 보내집니다'
export const PUSH_SCOPE_HINT = '이 설정은 모든 기기에 적용됩니다'
export const PUSH_HINT = '이 기기로 문제와 배포 소식을 바로 받습니다. 처음 켤 때 알림 권한을 묻습니다.'

// 종류별 설명 한 줄
export const KIND_HINT = {
  incident_opened: '실행 중인 서비스에 문제가 감지됐을 때',
  incident_recovered: '자동 복구로 정상으로 돌아왔을 때',
  incident_needs_action: '직접 확인해야 하는 문제가 생겼을 때',
  deploy_succeeded: '배포가 끝나 실행 중이 됐을 때',
  deploy_failed: '배포가 실패했을 때',
  new_commit: '배포한 브랜치에 새 커밋이 올라왔을 때',
  plan_exceeded: '예정한 사용 시간을 넘기면 알려 줍니다 (자동으로 끄지 않습니다)',
}

// 서버 응답에서 화면 값을 읽는다 - 모르는 종류는 버리고 서버 순서(NOTIFICATION_KINDS)로 맞춘다
export const readValues = (settings) => ({
  notify_email: settings?.notify_email === true,
  notify_push: settings?.notify_push === true,
  kinds: NOTIFICATION_KINDS.filter((kind) => Array.isArray(settings?.kinds) && settings.kinds.includes(kind)),
})
