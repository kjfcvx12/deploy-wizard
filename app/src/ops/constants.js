// 인시던트·알림·복구의 고정 글자 - 값 문자열은 서버와 같아야 한다 (docs/api-spec.md Incidents · Notifications, features/incidents/scheme.py, features/notifications/models.py)
// 글자는 docs/app-web/06-screens.md S-12~S-15 를 따르고, 문서에 없는 것은 "기획 글" 표시를 달았다
// 색 이름은 theme 의 ok | warn | err | accent | muted

// 인시던트 상태 (S-13: open 주황 · recovering accent · resolved ok · needs_action err)
export const INCIDENT_STATUS_LABEL = { open: '감지됨', recovering: '복구 중', resolved: '해결됨', needs_action: '확인 필요' }
export const INCIDENT_STATUS_TONE = { open: 'warn', recovering: 'accent', resolved: 'ok', needs_action: 'err' }

// 서버가 아직 처리 중으로 보는 상태 - 화면은 이 동안만 새로 고친다
export const INCIDENT_ACTIVE_STATUSES = ['open', 'recovering']

// 인시던트 종류 - 기획 글
export const INCIDENT_KIND_LABEL = {
  unhealthy: '응답 이상',
  crash_loop: '반복 종료',
  bad_release: '새 버전 문제',
  unknown: '원인 미상',
}

// 알림 종류 (서버 순서 그대로) - 설정 화면의 종류 목록도 이 순서를 쓴다
export const NOTIFICATION_KINDS = [
  'incident_opened', 'incident_recovered', 'incident_needs_action', 'deploy_succeeded', 'deploy_failed', 'new_commit',
]

// 알림 종류 이름 - 기획 글
export const NOTIFICATION_KIND_LABEL = {
  incident_opened: '문제 감지',
  incident_recovered: '복구 완료',
  incident_needs_action: '확인 필요',
  deploy_succeeded: '배포 성공',
  deploy_failed: '배포 실패',
  new_commit: '새 커밋',
}

// 알림 종류별 아이콘 글자 - 기획 글
export const NOTIFICATION_KIND_ICON = {
  incident_opened: '⚠',
  incident_recovered: '↺',
  incident_needs_action: '‼',
  deploy_succeeded: '✔',
  deploy_failed: '✖',
  new_commit: '⇡',
}

// 자동으로 한 조치 (재시작 / 이전 버전으로 되돌리기)
export const RECOVERY_ACTION_LABEL = { restart: '재시작', rollback: '이전 버전으로 되돌리기' }

// 조치 결과 - 기획 글
export const RECOVERY_RESULT_LABEL = { running: '진행 중', ok: '성공', failed: '실패' }
export const RECOVERY_RESULT_TONE = { running: 'accent', ok: 'ok', failed: 'err' }

// 마지막 헬스체크 요약 (components/EndpointCard.js 와 같은 글)
export const HEALTH_STATE_LABEL = { healthy: '응답 정상', unhealthy: '응답 없음', unknown: '확인 전' }
