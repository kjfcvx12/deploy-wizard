import {
  INCIDENT_STATUS_LABEL, INCIDENT_STATUS_TONE, INCIDENT_ACTIVE_STATUSES, INCIDENT_KIND_LABEL,
  NOTIFICATION_KIND_LABEL, NOTIFICATION_KIND_ICON, NOTIFICATION_KINDS,
  RECOVERY_ACTION_LABEL, RECOVERY_RESULT_LABEL, RECOVERY_RESULT_TONE, HEALTH_STATE_LABEL,
} from '../ops/constants'
import { parseAppLink } from '../ops/links'
import { formatTime, durationText, incidentTimeline } from '../ops/format'

// docs/api-spec.md 에 적힌 서버 값 (여기서 따로 적어 두고 앱의 표와 맞춘다)
const SERVER = {
  incidentStatus: ['open', 'recovering', 'resolved', 'needs_action'],
  incidentKind: ['unhealthy', 'crash_loop', 'bad_release', 'unknown'],
  notificationKind: ['incident_opened', 'incident_recovered', 'incident_needs_action', 'deploy_succeeded', 'deploy_failed', 'new_commit'],
  recoveryAction: ['restart', 'rollback'],
  recoveryResult: ['running', 'ok', 'failed'],
  health: ['healthy', 'unhealthy', 'unknown'],
}
const TONES = ['ok', 'warn', 'err', 'accent', 'muted']

describe('라벨은 서버 값을 빠짐없이, 더도 덜도 없이 덮는다', () => {
  test.each([
    ['INCIDENT_STATUS_LABEL', INCIDENT_STATUS_LABEL, SERVER.incidentStatus],
    ['INCIDENT_STATUS_TONE', INCIDENT_STATUS_TONE, SERVER.incidentStatus],
    ['INCIDENT_KIND_LABEL', INCIDENT_KIND_LABEL, SERVER.incidentKind],
    ['NOTIFICATION_KIND_LABEL', NOTIFICATION_KIND_LABEL, SERVER.notificationKind],
    ['NOTIFICATION_KIND_ICON', NOTIFICATION_KIND_ICON, SERVER.notificationKind],
    ['RECOVERY_ACTION_LABEL', RECOVERY_ACTION_LABEL, SERVER.recoveryAction],
    ['RECOVERY_RESULT_LABEL', RECOVERY_RESULT_LABEL, SERVER.recoveryResult],
    ['RECOVERY_RESULT_TONE', RECOVERY_RESULT_TONE, SERVER.recoveryResult],
    ['HEALTH_STATE_LABEL', HEALTH_STATE_LABEL, SERVER.health],
  ])('%s', (name, table, values) => {
    expect(Object.keys(table).sort()).toEqual([...values].sort())
    values.forEach((v) => expect(typeof table[v]).toBe('string'))
    values.forEach((v) => expect(table[v].length).toBeGreaterThan(0))
  })

  test('NOTIFICATION_KINDS 는 서버 순서 그대로', () => {
    expect(NOTIFICATION_KINDS).toEqual(SERVER.notificationKind)
  })

  test('톤은 테마 색 이름만 쓴다', () => {
    ;[INCIDENT_STATUS_TONE, RECOVERY_RESULT_TONE].forEach((t) => {
      Object.values(t).forEach((tone) => expect(TONES).toContain(tone))
    })
  })

  test('상태 글자와 톤 (06-screens.md S-13)', () => {
    expect(INCIDENT_STATUS_LABEL).toEqual({ open: '감지됨', recovering: '복구 중', resolved: '해결됨', needs_action: '확인 필요' })
    expect(INCIDENT_STATUS_TONE).toEqual({ open: 'warn', recovering: 'accent', resolved: 'ok', needs_action: 'err' })
  })

  test('복구 조치 글자', () => {
    expect(RECOVERY_ACTION_LABEL).toEqual({ restart: '재시작', rollback: '이전 버전으로 되돌리기' })
  })

  test('처리 중인 상태는 open 과 recovering', () => {
    expect([...INCIDENT_ACTIVE_STATUSES]).toEqual(['open', 'recovering'])
  })
})

describe('parseAppLink', () => {
  test.each([
    ['deploywizard://deploys/7', { route: '/deploys/7', params: { d_id: '7' } }],
    ['deploywizard://incidents/7', { route: '/incidents/7', params: { i_id: '7' } }],
    ['deploywizard://deploys/123456', { route: '/deploys/123456', params: { d_id: '123456' } }],
    ['/deploys/7', { route: '/deploys/7', params: { d_id: '7' } }],
    ['/incidents/12', { route: '/incidents/12', params: { i_id: '12' } }],
    ['deploywizard://deploys/2147483647', { route: '/deploys/2147483647', params: { d_id: '2147483647' } }],
  ])('%j 는 받는다', (url, expected) => {
    expect(parseAppLink(url)).toEqual(expected)
  })

  test.each([
    ['DEPLOYWIZARD://deploys/7'],
    ['DeployWizard://deploys/7'],
    ['deploywizard://Deploys/7'],
    ['javascript:alert(1)'],
    ['javascript://deploys/7'],
    ['https://deploys/7'],
    ['https://example.com/deploys/7'],
    ['http://localhost/incidents/7'],
    ['otherscheme://deploys/7'],
    ['deploywizard://evil.com/deploys/7'],
    ['deploywizard://deploys'],
    ['deploywizard://deploys/'],
    ['deploywizard://deploys/7/'],
    ['deploywizard://deploys/7/logs'],
    ['deploywizard://deploys/7?x=1'],
    ['deploywizard://deploys/7#frag'],
    ['deploywizard://deploys/0'],
    ['deploywizard://incidents/0'],
    ['deploywizard://incidents/-1'],
    ['deploywizard://incidents/1abc'],
    ['deploywizard://incidents/abc'],
    ['deploywizard://incidents/007'],
    ['deploywizard://incidents/1.5'],
    ['deploywizard://incidents/+7'],
    ['deploywizard://incidents/ 7'],
    ['deploywizard://incidents/7 '],
    [' deploywizard://incidents/7'],
    ['deploywizard://incidents/7\n'],
    ['deploywizard://incidents/２'],
    ['deploywizard://accounts?connected=github'],
    ['deploywizard://accounts'],
    ['deploywizard:///deploys/7'],
    ['deploywizard://deploys/99999999999999999999'],
    ['deploywizard://deploys/2147483648'],
    ['/deploys/0'],
    ['/accounts'],
    ['//deploys/7'],
    ['/deploys/7/../accounts'],
    ['/deploys/7?x=1'],
    ['/Deploys/7'],
    ['deploys/7'],
    ['/'],
    [''],
    [null],
    [undefined],
    [7],
    [{}],
    [['deploywizard://deploys/7']],
  ])('%j 는 거절한다', (url) => {
    expect(parseAppLink(url)).toBeNull()
  })
})

describe('formatTime / durationText', () => {
  // 서버 시각은 UTC 이고 끝에 Z 가 없다 - 기기의 현지 시각으로 바꿔 보여 준다
  const local = (ms) => {
    const d = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  test('Z 가 없는 서버 시각은 UTC 로 읽는다', () => {
    expect(formatTime('2026-11-09T03:12:30')).toBe(local(Date.UTC(2026, 10, 9, 3, 12, 30)))
  })

  test('Z 나 오프셋이 있으면 그대로 따른다', () => {
    expect(formatTime('2026-11-09T03:12:30Z')).toBe(local(Date.UTC(2026, 10, 9, 3, 12, 30)))
    expect(formatTime('2026-11-09T12:12:30+09:00')).toBe(local(Date.UTC(2026, 10, 9, 3, 12, 30)))
  })

  test('소수점 초가 있어도 읽는다', () => {
    expect(formatTime('2026-11-09T03:12:30.123456')).toBe(local(Date.UTC(2026, 10, 9, 3, 12, 30)))
  })

  test.each([[null], [undefined], [''], ['어제'], [42]])('%j 는 빈 글자', (v) => {
    expect(formatTime(v)).toBe('')
  })

  test.each([
    ['2026-11-09T03:00:00', '2026-11-09T03:00:00', '0초'],
    ['2026-11-09T03:00:00', '2026-11-09T03:00:45', '45초'],
    ['2026-11-09T03:00:00', '2026-11-09T03:01:00', '1분'],
    ['2026-11-09T03:00:00', '2026-11-09T03:03:20', '3분 20초'],
    ['2026-11-09T03:00:00', '2026-11-09T04:00:00', '1시간'],
    ['2026-11-09T03:00:00', '2026-11-09T05:15:40', '2시간 15분'],
    ['2026-11-09T03:00:00', '2026-11-10T03:00:00', '1일'],
    ['2026-11-09T03:00:00', '2026-11-11T07:30:00', '2일 4시간'],
  ])('durationText(%s, %s) = %s', (a, b, expected) => {
    expect(durationText(a, b)).toBe(expected)
  })

  test.each([
    [null, '2026-11-09T03:00:00'],
    ['2026-11-09T03:00:00', null],
    ['2026-11-09T03:00:00', 'x'],
    ['2026-11-09T03:00:10', '2026-11-09T03:00:00'],
  ])('durationText(%j, %j) 는 빈 글자', (a, b) => {
    expect(durationText(a, b)).toBe('')
  })
})

describe('incidentTimeline', () => {
  const base = {
    i_id: 7, d_id: 2, kind: 'unhealthy', status: 'open',
    summary: '앱이 오류로 응답하고 있습니다.',
    explain: null,
    detected_at: '2026-11-09T03:12:30', resolved_at: null,
    created_at: '2026-11-09T03:12:30', updated_at: '2026-11-09T03:12:30',
    actions: [],
  }
  const restart = {
    r_a_id: 11, i_id: 7, action: 'restart', d_r_id: null, result: 'failed', detail: '다시 시작했지만 응답이 없습니다',
    started_at: '2026-11-09T03:13:00', finished_at: '2026-11-09T03:18:00',
  }
  const rollback = {
    r_a_id: 12, i_id: 7, action: 'rollback', d_r_id: 3, result: 'ok', detail: '이전 버전으로 되돌렸습니다',
    started_at: '2026-11-09T03:18:10', finished_at: '2026-11-09T03:21:00',
  }

  test('조치가 없는 열린 인시던트: 감지 하나', () => {
    const rows = incidentTimeline(base)
    expect(rows).toEqual([
      { key: 'detected', time: '2026-11-09T03:12:30', title: '문제를 감지했습니다', detail: '앱이 오류로 응답하고 있습니다.', tone: 'warn' },
    ])
  })

  test('조치 한 건이 끝난 뒤 확인 필요: 감지, 시도, 실패, 확인 필요', () => {
    const rows = incidentTimeline({ ...base, status: 'needs_action', updated_at: '2026-11-09T03:18:05', actions: [restart] })
    expect(rows.map((r) => [r.key, r.title, r.tone])).toEqual([
      ['detected', '문제를 감지했습니다', 'warn'],
      ['action-11-start', '재시작 시도', 'accent'],
      ['action-11-result', '재시작 실패', 'err'],
      ['needs_action', '확인이 필요합니다', 'err'],
    ])
    expect(rows[1].time).toBe('2026-11-09T03:13:00')
    expect(rows[2].time).toBe('2026-11-09T03:18:00')
    expect(rows[2].detail).toBe('다시 시작했지만 응답이 없습니다')
    expect(rows[3].time).toBe('2026-11-09T03:18:05')
  })

  test('조치 두 건과 해결: 감지, 재시작 2줄, 되돌리기 2줄, 해결', () => {
    const rows = incidentTimeline({
      ...base, status: 'resolved', resolved_at: '2026-11-09T03:22:00', updated_at: '2026-11-09T03:22:00',
      actions: [rollback, restart],
    })
    expect(rows.map((r) => r.key)).toEqual([
      'detected', 'action-11-start', 'action-11-result', 'action-12-start', 'action-12-result', 'resolved',
    ])
    expect(rows[4]).toMatchObject({ title: '이전 버전으로 되돌리기 성공', tone: 'ok', detail: '이전 버전으로 되돌렸습니다' })
    expect(rows[5]).toMatchObject({ title: '정상으로 돌아왔습니다', tone: 'ok', time: '2026-11-09T03:22:00' })
  })

  test('아직 진행 중인 조치는 시작 줄만 있다', () => {
    const rows = incidentTimeline({
      ...base, status: 'recovering',
      actions: [{ ...restart, result: 'running', finished_at: null, detail: null }],
    })
    expect(rows.map((r) => r.key)).toEqual(['detected', 'action-11-start'])
  })

  test('끝난 시각이 없는 결과는 시작 시각을 쓴다', () => {
    const rows = incidentTimeline({ ...base, actions: [{ ...restart, finished_at: null }] })
    expect(rows.map((r) => r.key)).toEqual(['detected', 'action-11-start', 'action-11-result'])
    expect(rows[2].time).toBe(restart.started_at)
  })

  test('시간순으로 놓고 같은 시각은 만들어진 순서를 지킨다', () => {
    const t = '2026-11-09T03:12:30'
    const rows = incidentTimeline({
      ...base, status: 'needs_action', updated_at: t,
      actions: [{ ...restart, started_at: t, finished_at: t }],
    })
    expect(rows.map((r) => r.key)).toEqual(['detected', 'action-11-start', 'action-11-result', 'needs_action'])
  })

  test('actions 의 도착 순서가 뒤섞여도 결과가 같다', () => {
    const inc = { ...base, status: 'resolved', resolved_at: '2026-11-09T03:22:00', actions: [restart, rollback] }
    const a = incidentTimeline(inc)
    const b = incidentTimeline({ ...inc, actions: [rollback, restart] })
    expect(b).toEqual(a)
    expect(incidentTimeline(inc)).toEqual(a)
  })

  test('해결 시각이 없으면 갱신 시각으로 닫는다', () => {
    const rows = incidentTimeline({ ...base, status: 'resolved', resolved_at: null, updated_at: '2026-11-09T04:00:00' })
    expect(rows[rows.length - 1]).toMatchObject({ key: 'resolved', time: '2026-11-09T04:00:00' })
  })

  test('확인 필요 줄은 마지막 조치보다 앞서지 않는다', () => {
    const rows = incidentTimeline({ ...base, status: 'needs_action', updated_at: '2026-11-09T03:12:30', actions: [restart] })
    expect(rows.map((r) => r.key)).toEqual(['detected', 'action-11-start', 'action-11-result', 'needs_action'])
    expect(rows[3].time).toBe('2026-11-09T03:18:00')
  })

  test('summary 가 없고 설명이 있으면 설명의 한 줄을 쓴다', () => {
    const rows = incidentTimeline({ ...base, summary: null, explain: { summary: '설명 한 줄', cause: 'c', fix_where: 'f', actions: [], source: 'rule' } })
    expect(rows[0].detail).toBe('설명 한 줄')
  })

  test('둘 다 없으면 detail 은 null', () => {
    expect(incidentTimeline({ ...base, summary: null })[0].detail).toBeNull()
  })

  test('마스킹된 글자는 그대로 보여 준다', () => {
    const detail = 'token=*** 로 갱신 실패 <b>x</b>'
    const rows = incidentTimeline({ ...base, actions: [{ ...restart, detail }] })
    expect(rows[2].detail).toBe(detail)
  })

  test('모르는 조치·결과 값도 죽지 않는다', () => {
    const rows = incidentTimeline({ ...base, actions: [{ ...restart, action: 'scale', result: 'weird' }] })
    expect(rows.map((r) => r.title)).toEqual(['문제를 감지했습니다', 'scale 시도', 'scale weird'])
  })

  test('actions 가 없거나 null 이어도 된다', () => {
    const { actions, ...noActions } = base
    expect(incidentTimeline(noActions)).toHaveLength(1)
    expect(incidentTimeline({ ...base, actions: null })).toHaveLength(1)
  })

  test('입력을 바꾸지 않는다', () => {
    const inc = { ...base, actions: [rollback, restart] }
    const copy = JSON.parse(JSON.stringify(inc))
    incidentTimeline(inc)
    expect(inc).toEqual(copy)
  })
})
