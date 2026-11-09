// 웹의 features/envvars/ui/constants.js 와 같은 묶음 규칙

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
