import { groupEnvVars, canContinue } from '../envGroups'

const row = (name, extra) => ({
  name, required: true, has_default: false, kind: 'config', source: 'code', source_hint: null,
  status: 'detected', has_value: false, needs_redeploy: false, ...extra,
})

const fixture = () => [
  row('MY_THING_URL', { kind: 'unknown', source_hint: 'app/config.py:12' }),
  row('DATABASE_URL', { kind: 'database' }),
  row('LOG_LEVEL'),
  row('PAGE_SIZE', { required: false, has_default: true }),
  row('OLD_FLAG', { status: 'skipped' }),
]

const names = (rows) => rows.map((r) => r.name)

describe('groupEnvVars', () => {
  test('웹과 같은 묶음', () => {
    const g = groupEnvVars(fixture())
    expect(names(g.unknown)).toEqual(['MY_THING_URL'])
    expect(names(g.need)).toEqual(['DATABASE_URL', 'LOG_LEVEL'])
    expect(names(g.optional)).toEqual(['PAGE_SIZE'])
    expect(names(g.done)).toEqual(['OLD_FLAG'])
  })

  test('값이 저장된 행은 입력 완료', () => {
    const g = groupEnvVars([row('A', { status: 'set', has_value: true })])
    expect(names(g.done)).toEqual(['A'])
  })

  test('예상 밖 status/kind 행도 버리지 않는다', () => {
    const rows = [
      row('W1', { status: 'weird' }),
      row('W2', { kind: 'brand_new_kind' }),
      row('W3', { required: false, status: 'weird' }),
      row('W4', { kind: undefined, status: undefined }),
      row('W5', { required: undefined, kind: null }),
    ]
    const g = groupEnvVars(rows)
    const total = g.need.length + g.unknown.length + g.optional.length + g.done.length
    expect(total).toBe(rows.length)
  })

  test('빈 입력은 네 묶음 모두 비어 있다', () => {
    const empty = { need: [], unknown: [], optional: [], done: [] }
    expect(groupEnvVars([])).toEqual(empty)
    expect(groupEnvVars(null)).toEqual(empty)
    expect(groupEnvVars(undefined)).toEqual(empty)
  })
})

describe('canContinue', () => {
  test('필수 변수가 비어 있으면 false, 건너뛰면 true', () => {
    const rows = fixture()
    expect(canContinue(rows)).toBe(false)
    const skipped = rows.map((r) => (r.required ? { ...r, status: 'skipped' } : r))
    expect(canContinue(skipped)).toBe(true)
  })

  test('선택 변수만 비어 있으면 true / 빈 목록도 true', () => {
    expect(canContinue([row('P', { required: false })])).toBe(true)
    expect(canContinue([])).toBe(true)
    expect(canContinue(null)).toBe(true)
  })
})
