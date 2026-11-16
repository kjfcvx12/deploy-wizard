import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import './useAlias.mjs'

const {
  formatUsd, formatHours, parsePlannedHours, validateScaling,
  buildDeployOptions, buildEstimateBody, describeEstimate,
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
  assert.match(all({ ...ok, min: 3, max: 2 }), /최소/)
  assert.match(all({ ...ok, max: 5 }), /4/)
  assert.match(all({ ...ok, min: 0 }), /최소/)
  assert.match(all({ ...ok, metric: 'FOO' }), /기준/)
  assert.match(all({ ...ok, target: 0 }), /1/)
  assert.equal(all({ ...ok, target: 100 }), null)
  assert.match(all({ ...ok, target: 101 }), /100/)
  const req = { ...ok, metric: 'REQUEST_COUNT_PER_TARGET' }
  assert.equal(all({ ...req, target: 100000 }), null)
  assert.match(all({ ...req, target: 100001 }), /100000/)
  assert.match(all({ ...ok, min: 1.5 }), /정수/)
  assert.match(all({ ...ok, max: '2.5' }), /정수/)
  assert.match(all({ ...ok, min: 'abc' }), /정수/)
  assert.match(all({ ...ok, min: 'NaN' }), /정수/)
  assert.match(all({ ...ok, target: '1e2' }), /정수/)
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
