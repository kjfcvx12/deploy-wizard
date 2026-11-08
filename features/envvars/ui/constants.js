// features/envvars 의 kind 값과 같아야 한다 (docs/api-spec.md Env_Read)
export const ENV_KINDS = [
  { key: 'database', label: '데이터베이스 주소' },
  { key: 'cache', label: '캐시 주소' },
  { key: 'external_api', label: '외부 서비스 키' },
  { key: 'secret', label: '비밀값' },
  { key: 'config', label: '일반 설정' },
]

// 시크릿으로 다루는 종류 - 값 입력을 받지 않는다 (서버가 501)
export const ENV_SECRET_KINDS = new Set(['database', 'cache', 'external_api', 'secret'])

// 종류 키를 한국어 이름으로 바꾼다 (모르는 키는 '알 수 없음')
export const kindLabel = (key) => ENV_KINDS.find((k) => k.key === key)?.label || '알 수 없음'

// 환경변수 행을 화면 묶음으로 나눈다 - 어떤 행도 버리지 않는다
export function groupEnvVars(rows) {
  const groups = { need: [], unknown: [], optional: [], done: [] }
  for (const row of rows || []) {
    if (row.status === 'set' || row.status === 'skipped') groups.done.push(row)
    else if (!row.required) groups.optional.push(row)
    else if (row.kind === 'unknown') groups.unknown.push(row)
    else groups.need.push(row)
  }
  return groups
}

// 값이 비어 있는 필수 변수가 없으면 이어서 배포할 수 있다
export const canContinue = (rows) => !(rows || []).some((row) => row.required && row.status === 'detected')
