// 인시던트·복구의 고정 글자 - 값 문자열은 서버와 같아야 한다 (features/incidents/scheme.py, docs/api-spec.md Incidents)
// 모르는 값은 화면에서 서버 글자 그대로 보여 준다 (표에 없으면 원래 값을 쓴다)

// 인시던트 상태와 배지 색 (.badge 클래스: exp 주황 · run 파랑 · ok 초록 · err 빨강)
export const INCIDENT_STATUS_LABEL = { open: '감지됨', recovering: '복구 중', resolved: '해결됨', needs_action: '확인 필요' }
export const INCIDENT_STATUS_BADGE = { open: 'exp', recovering: 'run', resolved: 'ok', needs_action: 'err' }

// 서버가 아직 처리 중으로 보는 상태 - 화면은 이 동안만 새로 고친다
export const INCIDENT_ACTIVE_STATUSES = ['open', 'recovering']

// 인시던트 종류
export const INCIDENT_KIND_LABEL = {
  unhealthy: '응답 이상',
  crash_loop: '반복 종료',
  bad_release: '새 버전 문제',
  unknown: '원인 미상',
}

// 자동으로 한 조치 (재시작 / 이전 버전으로 되돌리기)
export const RECOVERY_ACTION_LABEL = { restart: '재시작', rollback: '이전 버전으로 되돌리기' }

// 조치 결과와 타임라인 색 이름 (ok | warn | err | accent | muted)
export const RECOVERY_RESULT_LABEL = { running: '진행 중', ok: '성공', failed: '실패' }
export const RECOVERY_RESULT_TONE = { running: 'accent', ok: 'ok', failed: 'err' }

// 문제 한 줄 상태 글 - 확인 필요 인시던트와 자동 복구를 꺼 둔 배포는 사람이 봐야 하고, 그 밖에는 자동 복구 중
export function problemLabel(deploy) {
  if (deploy.open_incident_status === 'needs_action') return '확인이 필요합니다'
  return deploy.auto_recover === false ? '확인이 필요합니다' : '자동 복구 중'
}
