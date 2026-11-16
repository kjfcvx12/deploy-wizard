import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import './useAlias.mjs'

const {
  formatUsd, formatHours, parsePlannedHours, validateScaling,
  buildDeployOptions, buildEstimateBody, describeEstimate, estimateFromCost,
  planRemaining, formatRemaining, describeDeployPlan,
} = await import('../../features/pricing/ui/costLogic.js')
const { pricingApi } = await import('../../features/pricing/ui/api.js')

const METRICS = [
  { value: 'AVERAGE_CPU', label: 'CPU 사용률' },
  { value: 'AVERAGE_MEMORY', label: '메모리 사용률' },
  { value: 'REQUEST_COUNT_PER_TARGET', label: '요청 수' },
]

test('formatUsd: USD 와 다른 통화, 숫자가 아닌 값', () => {
  assert.equal(formatUsd(26.787, 2), '$26.79')
  assert.equal(formatUsd(26.787), '$26.79')
  assert.equal(formatUsd(0.036695, 4), '$0.0367')
  assert.equal(formatUsd(NaN), '-')
  assert.equal(formatUsd(Infinity), '-')
  assert.equal(formatUsd(null), '-')
  assert.equal(formatUsd(undefined), '-')
  assert.equal(formatUsd('3'), '-')
  assert.equal(formatUsd(1.234, 2, 'KRW'), '1.23 KRW')
  assert.equal(formatUsd(NaN, 2, 'KRW'), '-')
  // 반올림하면 0 이 되는 음수는 부호 없이
  assert.equal(formatUsd(-0.001), '$0.00')
  assert.equal(formatUsd(-0), '$0.00')
  assert.equal(formatUsd(-0.00001, 4, 'KRW'), '0.0000 KRW')
  assert.equal(formatUsd(-1.5), '$-1.50')
})

test('formatHours', () => {
  assert.equal(formatHours(4), '4시간')
  assert.equal(formatHours(1.5), '1.5시간')
  assert.equal(formatHours(24), '1일')
  assert.equal(formatHours(168), '1주일')
  assert.equal(formatHours(730), '730시간')
  assert.equal(formatHours(0.5), '0.5시간')
  assert.equal(formatHours(2.0), '2시간')
  assert.equal(formatHours(NaN), '-')
  assert.equal(formatHours(Infinity), '-')
  // 0.1시간으로도 반올림되지 않는 아주 짧은 시간은 0시간이라 하지 않는다
  assert.equal(formatHours(0.04), '0.1시간 미만')
  assert.equal(formatHours(0.05), '0.1시간')
  assert.equal(formatHours(0), '0시간')
})

test('parsePlannedHours', () => {
  assert.deepEqual(parsePlannedHours(''), { hours: null, error: null })
  assert.deepEqual(parsePlannedHours('   '), { hours: null, error: null })
  assert.deepEqual(parsePlannedHours(null), { hours: null, error: null })
  assert.deepEqual(parsePlannedHours('8'), { hours: 8, error: null })
  assert.deepEqual(parsePlannedHours(' 4 '), { hours: 4, error: null })
  assert.deepEqual(parsePlannedHours('1.5'), { hours: 1.5, error: null })
  assert.deepEqual(parsePlannedHours('8760'), { hours: 8760, error: null })
  for (const bad of ['0', '-1', 'abc', '1e999', 'NaN', 'Infinity', '8761']) {
    const r = parsePlannedHours(bad)
    assert.equal(r.hours, null, bad)
    assert.equal(typeof r.error, 'string', bad)
    assert.match(r.error, /[가-힣]/, bad)
  }
})

test('validateScaling 표', () => {
  const ok = { min: 1, max: 3, metric: 'AVERAGE_CPU', target: 60 }
  const all = (v) => validateScaling(v, 4, METRICS)
  assert.equal(all({ min: '', max: '', metric: '', target: '' }), null)
  assert.equal(all({}), null)
  assert.equal(all(ok), null)
  assert.equal(all({ ...ok, min: '2', max: '4', target: '70' }), null)
  assert.equal(all({ ...ok, target: '' }), '증설 설정은 최소·최대·기준·목표값을 모두 정해야 합니다')
  assert.equal(all({ min: 1 }), '증설 설정은 최소·최대·기준·목표값을 모두 정해야 합니다')
  assert.equal(all({ ...ok, min: 3, max: 2 }), '최소 작업 수는 최대 작업 수보다 클 수 없습니다')
  assert.equal(all({ ...ok, max: 5 }), '최대 작업 수는 4개까지만 정할 수 있습니다')
  assert.equal(all({ ...ok, min: 0 }), '최소 작업 수는 1 이상이어야 합니다')
  assert.equal(all({ ...ok, metric: 'FOO' }), '증설 기준을 목록에서 골라 주세요')
  assert.equal(all({ ...ok, target: 0 }), '목표값은 1~100 사이여야 합니다')
  assert.match(all({ ...ok, target: 0 }), /1~100/)
  assert.equal(all({ ...ok, target: 100 }), null)
  assert.equal(all({ ...ok, target: 101 }), '목표값은 1~100 사이여야 합니다')
  const req = { ...ok, metric: 'REQUEST_COUNT_PER_TARGET' }
  assert.equal(all({ ...req, target: 100000 }), null)
  assert.equal(all({ ...req, target: 100001 }), '목표값은 1~100000 사이여야 합니다')
  assert.equal(all({ ...req, target: 0 }), '목표값은 1~100000 사이여야 합니다')
  assert.match(all({ ...ok, min: 1.5 }), /정수/)
  assert.match(all({ ...ok, max: '2.5' }), /정수/)
  assert.match(all({ ...ok, min: 'abc' }), /정수/)
  assert.match(all({ ...ok, min: 'NaN' }), /정수/)
  assert.match(all({ ...ok, target: '1e2' }), /정수/)
  // NaN·무한대는 정수가 아니다
  for (const bad of [NaN, Infinity, -Infinity]) {
    for (const key of ['min', 'max', 'target']) {
      assert.equal(all({ ...ok, [key]: bad }), '최소·최대·목표값은 정수로 적어 주세요', `${key} ${bad}`)
    }
  }
  // 지표 목록은 인자로 받은 것만 허용한다
  assert.match(validateScaling(ok, 4, [{ value: 'AVERAGE_MEMORY', label: 'm' }]), /기준/)
  assert.match(validateScaling(ok, 4, undefined), /기준/)
})

const full = {
  cpu: '1024', memory: '2048', plannedHours: 24,
  scaling: { enabled: true, min: '1', max: '3', metric: 'AVERAGE_CPU', target: '60' },
}

test('buildDeployOptions: 고른 것만', () => {
  const build = (s) => buildDeployOptions(s, 4, METRICS)
  assert.deepEqual(build({}), {})
  assert.deepEqual(build({ cpu: '', memory: '', plannedHours: null, scaling: { enabled: false } }), {})
  assert.deepEqual(build({ cpu: '256', memory: '512' }), { cpu: '256', memory: '512' })
  assert.deepEqual(build({ cpu: '256' }), {})
  assert.deepEqual(build({ plannedHours: 4 }), { planned_hours: 4 })
  assert.deepEqual(build({ plannedHours: '1.5' }), { planned_hours: 1.5 })
  assert.deepEqual(build({ plannedHours: NaN }), {})
  assert.deepEqual(build({ plannedHours: '' }), {})
  assert.deepEqual(build({ plannedHours: Infinity }), {})
  assert.deepEqual(build({ plannedHours: -1 }), {})
  // 증설이 켜졌지만 비었거나 일부만 찼으면 증설 키 없음
  assert.deepEqual(build({ scaling: { enabled: true, min: '', max: '', metric: '', target: '' } }), {})
  assert.deepEqual(build({ scaling: { enabled: true, min: '1', max: '2' } }), {})
  // NaN·무한대는 서버로 가지 않는다
  for (const bad of [NaN, Infinity, -Infinity]) {
    for (const key of ['min', 'max', 'target']) {
      const scaling = { ...full.scaling, [key]: bad }
      assert.deepEqual(build({ scaling }), {}, `${key} ${bad}`)
    }
  }
  // 증설이 켜졌지만 검증 실패 -> 증설 키 없음
  const bad = { ...full, scaling: { ...full.scaling, max: '9' } }
  assert.deepEqual(build(bad), { cpu: '1024', memory: '2048', planned_hours: 24 })
  const off = { ...full, scaling: { ...full.scaling, enabled: false } }
  assert.deepEqual(build(off), { cpu: '1024', memory: '2048', planned_hours: 24 })
  const options = build(full)
  assert.deepEqual(options, {
    cpu: '1024', memory: '2048', planned_hours: 24,
    min_tasks: 1, max_tasks: 3, scale_metric: 'AVERAGE_CPU', scale_target: 60,
  })
  assert.equal(Object.keys(options).length, 7)
  assert.equal(typeof options.min_tasks, 'number')
})

test('buildEstimateBody: 고른 것만', () => {
  assert.deepEqual(buildEstimateBody({}), {})
  assert.deepEqual(buildEstimateBody(full), { cpu: '1024', memory: '2048', planned_hours: 24, max_tasks: 3 })
  assert.deepEqual(buildEstimateBody({ cpu: '1024' }), {})
  assert.deepEqual(buildEstimateBody({ ...full, scaling: { enabled: false, max: '3' } }),
    { cpu: '1024', memory: '2048', planned_hours: 24 })
  assert.deepEqual(buildEstimateBody({ scaling: { enabled: true, max: 'x' } }), {})
  assert.deepEqual(buildEstimateBody({ scaling: { enabled: true, max: '2.5' } }), {})
  assert.deepEqual(buildEstimateBody({ scaling: { enabled: true, max: '2' } }), { max_tasks: 2 })
})

const estimate = () => ({
  basis_date: '2026-11-11', region: 'ap-northeast-2', currency: 'USD',
  cpu: '256', memory: '512', spec_label: '0.25 vCPU / 0.5 GB', spec_is_default: false,
  components: [
    { name: 'Fargate', hourly_usd: 0.0367, note: '0.25 vCPU + 0.5 GB' },
    { name: 'ALB', hourly_usd: 0.0225, note: null },
  ],
  hourly_usd: 0.0592,
  periods: [
    { label: '1시간', hours: 1, usd: 0.0592 },
    { label: '1일', hours: 24, usd: 1.4208 },
    { label: '1주', hours: 168, usd: 9.9456 },
    { label: '한 달', hours: 730, usd: 43.216 },
  ],
  planned_hours: 8, planned_usd: 0.4136,
  max_tasks: 3, max_hourly_usd: 0.1077, max_monthly_usd: 78.6,
  arm64_hourly_usd: 0.0452, arm64_saving_percent: 11.2,
  assumptions: ['온디맨드 가격'], not_included: ['데이터 전송'],
})

test('describeEstimate: 전체 모양', () => {
  const d = describeEstimate(estimate())
  assert.deepEqual(d.componentRows, [
    { name: 'Fargate', hourly: '$0.0367', note: '0.25 vCPU + 0.5 GB' },
    { name: 'ALB', hourly: '$0.0225', note: null },
  ])
  assert.equal(d.hourly, '$0.0592')
  assert.deepEqual(d.periods[0], { label: '1시간', hours: 1, usd: '$0.06' })
  assert.deepEqual(d.periods[3], { label: '한 달', hours: 730, usd: '$43.22' })
  assert.equal(d.periods.length, 4)
  assert.equal(d.planned, '8시간 동안 약 $0.41')
  assert.equal(d.max, '최대 3개까지 늘면 시간당 최대 $0.1077, 한 달 최대 $78.60')
  assert.equal(d.arm, 'ARM64면 약 11.2% 저렴합니다 (시간당 $0.0452). 이 마법사는 x86으로만 빌드합니다')
  assert.deepEqual(d.assumptions, ['온디맨드 가격'])
  assert.deepEqual(d.notIncluded, ['데이터 전송'])
  assert.equal(d.basis, '기준일 2026-11-11 · USD')
})

test('describeEstimate: 없는 값은 null', () => {
  const e = estimate()
  Object.assign(e, { max_tasks: null, max_hourly_usd: null, max_monthly_usd: null })
  assert.equal(describeEstimate(e).max, null)
  const e2 = estimate()
  Object.assign(e2, { arm64_hourly_usd: null, arm64_saving_percent: null })
  assert.equal(describeEstimate(e2).arm, null)
  const e3 = estimate()
  Object.assign(e3, { planned_hours: null, planned_usd: null })
  assert.equal(describeEstimate(e3).planned, null)
  const e4 = estimate()
  delete e4.max_tasks; delete e4.arm64_hourly_usd; delete e4.planned_usd
  const d4 = describeEstimate(e4)
  assert.equal(d4.max, null)
  assert.equal(d4.arm, null)
  assert.equal(d4.planned, null)
  const d5 = describeEstimate({})
  assert.deepEqual(d5.componentRows, [])
  assert.deepEqual(d5.periods, [])
  assert.deepEqual(d5.assumptions, [])
  assert.deepEqual(d5.notIncluded, [])
  assert.equal(d5.hourly, null)
  assert.equal(d5.basis, null)
  // 시간당 금액이 없으면 '-' 가 아니라 null
  const e6 = estimate()
  delete e6.hourly_usd
  assert.equal(describeEstimate(e6).hourly, null)
  assert.equal(describeEstimate({ ...estimate(), hourly_usd: NaN }).hourly, null)
})

test('describeEstimate: USD 가 아닌 통화', () => {
  const d = describeEstimate({ ...estimate(), currency: 'KRW' })
  assert.equal(d.hourly, '0.0592 KRW')
  assert.equal(d.componentRows[0].hourly, '0.0367 KRW')
  assert.equal(d.periods[0].usd, '0.06 KRW')
  assert.equal(d.planned, '8시간 동안 약 0.41 KRW')
  assert.equal(d.max, '최대 3개까지 늘면 시간당 최대 0.1077 KRW, 한 달 최대 78.60 KRW')
  assert.match(d.arm, /\(시간당 0\.0452 KRW\)/)
  assert.equal(d.basis, '기준일 2026-11-11 · KRW')
  // 통화가 없으면 USD
  const noCurrency = estimate()
  delete noCurrency.currency
  assert.equal(describeEstimate(noCurrency).hourly, '$0.0592')
})

const realFetch = globalThis.fetch
let calls
beforeEach(() => {
  calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return { status: 200, ok: true, json: async () => ({}) }
  }
})
afterEach(() => { globalThis.fetch = realFetch })

test('pricingApi: URL, method, JSON body', async () => {
  await pricingApi.getOptions()
  assert.equal(calls[0].url, '/api/pricing/options')
  assert.equal(calls[0].options.method, undefined)
  await pricingApi.estimate({ cpu: '256', memory: '512', max_tasks: 2 })
  assert.equal(calls[1].url, '/api/pricing/estimate')
  assert.equal(calls[1].options.method, 'POST')
  assert.equal(calls[1].options.body, JSON.stringify({ cpu: '256', memory: '512', max_tasks: 2 }))
})

test('estimateFromCost: 분석 응답의 cost 를 추정 모양으로 (가격 없으면 null)', () => {
  assert.equal(estimateFromCost(null), null)
  assert.equal(estimateFromCost({ hourly_usd: null, components: [], not_included: [] }), null)
  const e = estimateFromCost({
    monthly_min: 26.79, monthly_max: 26.79, currency: 'USD', basis_date: '2026-11-11',
    hourly_usd: 0.0367, components: [{ name: 'ALB', hourly_usd: 0.0225, note: null }], not_included: ['LCU'],
    arm64_hourly_usd: 0.03, spec_label: '0.25 vCPU / 0.5 GB',
  })
  assert.equal(e.hourly_usd, 0.0367)
  assert.equal(e.basis_date, '2026-11-11')
  assert.deepEqual(e.periods, [{ label: '한 달', hours: null, usd: 26.79 }])
  assert.deepEqual(e.not_included, ['LCU'])
  const d = describeEstimate(e)
  assert.equal(d.hourly, '$0.0367')
  assert.equal(d.periods[0].usd, '$26.79')
  assert.equal(d.arm, null)
  const noMonthly = estimateFromCost({ hourly_usd: 0.04, components: [], not_included: [] })
  assert.deepEqual(noMonthly.periods, [])
})

const HOUR = 3600000
const SINCE = '2026-11-16T01:00:00'
const at = (iso) => new Date(iso)

test('planRemaining: 계획·시작 시각이 없으면 none', () => {
  const now = at('2026-11-16T02:00:00Z')
  const none = { state: 'none', remainingMs: null }
  assert.deepEqual(planRemaining(null, 4, now), none)
  assert.deepEqual(planRemaining(SINCE, null, now), none)
  assert.deepEqual(planRemaining(undefined, undefined, now), none)
  assert.deepEqual(planRemaining(SINCE, 0, now), none)
  assert.deepEqual(planRemaining(SINCE, -1, now), none)
  assert.deepEqual(planRemaining(SINCE, NaN, now), none)
  assert.deepEqual(planRemaining(SINCE, '4', now), none)
  assert.deepEqual(planRemaining('', 4, now), none)
  assert.deepEqual(planRemaining('어제', 4, now), none)
  assert.deepEqual(planRemaining('not a date', 4, now), none)
  assert.deepEqual(planRemaining(SINCE, 4, new Date('x')), none)
  assert.deepEqual(planRemaining(SINCE, 4, null), none)
})

test('planRemaining: 남음, 정확히 경계, 지남 (서버 시각은 UTC 로 읽는다)', () => {
  assert.deepEqual(planRemaining(SINCE, 4, at('2026-11-16T01:00:00Z')), { state: 'counting', remainingMs: 4 * HOUR })
  assert.deepEqual(planRemaining(SINCE, 4, at('2026-11-16T04:00:00Z')), { state: 'counting', remainingMs: HOUR })
  assert.deepEqual(planRemaining(SINCE, 1.5, at('2026-11-16T01:30:00Z')), { state: 'counting', remainingMs: HOUR })
  assert.deepEqual(planRemaining(SINCE, 4, at('2026-11-16T04:59:59.999Z')), { state: 'counting', remainingMs: 1 })
  // 정확히 끝나는 순간은 넘긴 것으로 본다
  assert.deepEqual(planRemaining(SINCE, 4, at('2026-11-16T05:00:00Z')), { state: 'over', remainingMs: null })
  assert.deepEqual(planRemaining(SINCE, 4, at('2026-11-17T05:00:00Z')), { state: 'over', remainingMs: null })
  // Z 가 붙은 시각도 같다
  assert.deepEqual(planRemaining('2026-11-16T01:00:00Z', 4, at('2026-11-16T02:00:00Z')), { state: 'counting', remainingMs: 3 * HOUR })
  // 시작 전(시계가 어긋남)이어도 전체 시간을 넘지 않는다
  assert.deepEqual(planRemaining(SINCE, 4, at('2026-11-16T00:00:00Z')), { state: 'counting', remainingMs: 4 * HOUR })
})

test('formatRemaining', () => {
  assert.equal(formatRemaining(3 * HOUR + 12 * 60000), '3시간 12분 남음')
  assert.equal(formatRemaining(59 * 60000), '59분 남음')
  assert.equal(formatRemaining(59 * 60000 + 59999), '59분 남음')
  assert.equal(formatRemaining(60000), '1분 남음')
  assert.equal(formatRemaining(59999), '1분 미만 남음')
  assert.equal(formatRemaining(1), '1분 미만 남음')
  assert.equal(formatRemaining(0), '1분 미만 남음')
  assert.equal(formatRemaining(HOUR), '1시간 남음')
  assert.equal(formatRemaining(25 * HOUR), '1일 1시간 남음')
  assert.equal(formatRemaining(24 * HOUR), '1일 남음')
  assert.equal(formatRemaining(48 * HOUR + 30 * 60000), '2일 남음')
  assert.equal(formatRemaining(NaN), '')
  assert.equal(formatRemaining(null), '')
  assert.equal(formatRemaining(Infinity), '')
})

const OPTIONS = {
  specs: [{ label: '0.25 vCPU / 0.5 GB', cpu: '256', memory: '512' }, { label: '1 vCPU / 2 GB', cpu: '1024', memory: '2048' }],
  scale_metrics: METRICS,
}
const NOW = at('2026-11-16T02:30:00Z')
const base = { cpu: null, memory: null, min_tasks: null, max_tasks: null, scale_metric: null, planned_hours: null, running_since: null }

test('describeDeployPlan: 값이 하나도 없으면 null', () => {
  assert.equal(describeDeployPlan(base, OPTIONS, NOW), null)
  assert.equal(describeDeployPlan({}, null, NOW), null)
  assert.equal(describeDeployPlan(null, OPTIONS, NOW), null)
})

test('describeDeployPlan: 사양·증설·계획', () => {
  const d = describeDeployPlan({
    ...base, cpu: '1024', memory: '2048', min_tasks: 1, max_tasks: 3, scale_metric: 'AVERAGE_CPU',
    planned_hours: 4, running_since: SINCE,
  }, OPTIONS, NOW)
  assert.equal(d.spec, '1 vCPU / 2 GB')
  assert.equal(d.scaling, '자동 증설 1~3개 (CPU 사용률 기준)')
  assert.equal(d.plan, '예정 사용 4시간 · 2시간 30분 남음')
  assert.equal(d.over, false)
})

test('describeDeployPlan: 모르는 사양은 값 그대로, 옵션을 못 받아도 그린다', () => {
  assert.equal(describeDeployPlan({ ...base, cpu: '512', memory: '1024' }, OPTIONS, NOW).spec, '512 / 1024')
  assert.equal(describeDeployPlan({ ...base, cpu: '256', memory: '512' }, null, NOW).spec, '256 / 512')
  const m = describeDeployPlan({ ...base, min_tasks: 1, max_tasks: 2, scale_metric: 'FOO' }, null, NOW)
  assert.equal(m.scaling, '자동 증설 1~2개 (FOO 기준)')
  assert.equal(m.spec, '기본 사양')
  assert.equal(m.plan, null)
})

test('describeDeployPlan: 계획만 있을 때와 시간을 넘겼을 때', () => {
  assert.equal(describeDeployPlan({ ...base, planned_hours: 24 }, OPTIONS, NOW).plan, '예정 사용 1일')
  const over = describeDeployPlan({ ...base, planned_hours: 1, running_since: SINCE }, OPTIONS, NOW)
  assert.equal(over.plan, '예정 사용 1시간 · 예정 시간을 넘겼습니다 — 멈추거나 삭제하세요')
  assert.equal(over.over, true)
  assert.equal(describeDeployPlan({ ...base, planned_hours: 0.04 }, OPTIONS, NOW).plan, '예정 사용 0.1시간 미만')
  // 증설 값이 한쪽만 있으면 그리지 않는다
  assert.equal(describeDeployPlan({ ...base, min_tasks: 1, planned_hours: 4 }, OPTIONS, NOW).scaling, null)
})
