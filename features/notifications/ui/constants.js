// 알림의 고정 글자 - 값 문자열은 서버와 같아야 한다 (features/notifications/models.py, docs/api-spec.md Notifications)
// 모르는 종류는 화면에서 서버 글자 그대로 보여 준다

// 알림 종류 (서버 순서 그대로) - 설정 화면의 종류 목록도 이 순서를 쓴다
export const NOTIFICATION_KINDS = [
  'incident_opened', 'incident_recovered', 'incident_needs_action', 'deploy_succeeded', 'deploy_failed', 'new_commit', 'plan_exceeded',
]

// 알림 종류 이름
export const NOTIFICATION_KIND_LABEL = {
  incident_opened: '문제 감지',
  incident_recovered: '복구 완료',
  incident_needs_action: '확인 필요',
  deploy_succeeded: '배포 성공',
  deploy_failed: '배포 실패',
  new_commit: '새 커밋',
  plan_exceeded: '예정 사용 시간 초과',
}

// 알림 종류별 아이콘 글자
export const NOTIFICATION_KIND_ICON = {
  incident_opened: '⚠',
  incident_recovered: '↺',
  incident_needs_action: '‼',
  deploy_succeeded: '✔',
  deploy_failed: '✖',
  new_commit: '⇡',
  plan_exceeded: '✖',
}

// 알림 종류별 배지 색 (.badge 클래스)
export const NOTIFICATION_KIND_BADGE = {
  incident_opened: 'exp',
  incident_recovered: 'ok',
  incident_needs_action: 'err',
  deploy_succeeded: 'ok',
  deploy_failed: 'err',
  new_commit: 'run',
  plan_exceeded: 'err',
}

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

export const MAIL_HINT = '서버에 메일 설정이 있을 때만 보내집니다'
export const PUSH_HINT_WEB = '푸시는 앱에서 이 기기를 등록해야 도착합니다. 웹 브라우저로는 받지 않습니다. 이 설정은 모든 기기에 적용됩니다.'

// 읽지 않은 수가 바뀌었음을 같은 탭의 다른 화면에 알리는 창 이벤트 이름
export const UNREAD_CHANGED_EVENT = 'dw:unread-changed'
