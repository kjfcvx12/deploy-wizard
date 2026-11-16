const MAX_PLANNED_HOURS = 8760
const INCOMPLETE_SCALING_TEXT = '증설 설정은 최소·최대·기준·목표값을 모두 정해야 합니다'

// 유한한 숫자인지 (문자열·null 은 아님)
const isNum = (value) => typeof value === 'number' && Number.isFinite(value)

// 비어 있는 입력인지 (null·undefined·빈 문자열·공백)
const isBlank = (value) => value === null || value === undefined || String(value).trim() === ''

// 정수로 읽을 수 있으면 그 수, 아니면 null (숫자 또는 숫자 모양 문자열만)
const toInteger = (value) => {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

// 금액 표기 - USD 는 $12.34, 그 외 통화는 12.34 KRW
export function formatUsd(value, digits = 2, currency = 'USD') {
  if (!isNum(value)) return '-'
  const text = value.toFixed(digits)
  return currency === 'USD' ? `$${text}` : `${text} ${currency}`
}

// 시간 표기 - 24 는 1일, 168 은 1주일, 그 외 N시간 (소수는 최대 1자리)
export function formatHours(hours) {
  if (!isNum(hours)) return '-'
  if (hours === 24) return '1일'
  if (hours === 168) return '1주일'
  return `${Number(hours.toFixed(1))}시간`
}

// 사용 예정 시간 입력 해석 - 비면 계획 없음, 잘못되면 한국어 오류
export function parsePlannedHours(text) {
  if (isBlank(text)) return { hours: null, error: null }
  const trimmed = String(text).trim()
  const fail = { hours: null, error: `사용 시간은 0보다 크고 ${MAX_PLANNED_HOURS}시간 이하의 숫자로 적어 주세요` }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return fail
  const hours = Number(trimmed)
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_PLANNED_HOURS) return fail
  return { hours, error: null }
}

// 자동 증설 입력 검증 - 문제 없으면 null, 있으면 한국어 문구
export function validateScaling(values, cap, metrics = []) {
  const { min, max, metric, target } = values || {}
  const fields = [min, max, metric, target]
  if (fields.every(isBlank)) return null
  if (fields.some(isBlank)) return INCOMPLETE_SCALING_TEXT

  const minTasks = toInteger(min)
  const maxTasks = toInteger(max)
  const targetValue = toInteger(target)
  if (minTasks === null || maxTasks === null || targetValue === null) {
    return '최소·최대·목표값은 정수로 적어 주세요'
  }
  if (minTasks < 1) return '최소 작업 수는 1 이상이어야 합니다'
  if (minTasks > maxTasks) return '최소 작업 수는 최대 작업 수보다 클 수 없습니다'
  if (maxTasks > cap) return `최대 작업 수는 ${cap}개까지만 정할 수 있습니다`
  if (!(metrics || []).some((item) => item.value === metric)) return '증설 기준을 목록에서 골라 주세요'

  const upper = metric === 'REQUEST_COUNT_PER_TARGET' ? 100000 : 100
  if (targetValue < 1 || targetValue > upper) return `목표값은 1~${upper} 사이여야 합니다`
  return null
}

// 사양 선택 - cpu·memory 가 둘 다 있을 때만
const specPart = (selection) => {
  const { cpu, memory } = selection || {}
  return !isBlank(cpu) && !isBlank(memory) ? { cpu, memory } : {}
}

// 사용 예정 시간 선택 - 숫자(또는 숫자 문자열)로 읽힐 때만
const plannedPart = (selection) => {
  const raw = selection?.plannedHours
  const { hours } = parsePlannedHours(typeof raw === 'number' ? String(raw) : raw)
  return hours === null ? {} : { planned_hours: hours }
}

// 배포 요청에 실을 옵션 - 고른 것만 담는다 (증설은 켜져 있고 검증을 통과했을 때만)
export function buildDeployOptions(selection, cap, metrics) {
  const options = { ...specPart(selection), ...plannedPart(selection) }
  const scaling = selection?.scaling
  if (scaling?.enabled && [scaling.min, scaling.max, scaling.metric, scaling.target].every((v) => !isBlank(v))
      && validateScaling(scaling, cap, metrics) === null) {
    options.min_tasks = Number(scaling.min)
    options.max_tasks = Number(scaling.max)
    options.scale_metric = scaling.metric
    options.scale_target = Number(scaling.target)
  }
  return options
}

// /pricing/estimate 본문 - 사양·사용 시간·최대 작업 수 중 고른 것만
export function buildEstimateBody(selection) {
  const body = { ...specPart(selection), ...plannedPart(selection) }
  const scaling = selection?.scaling
  if (scaling?.enabled) {
    const maxTasks = toInteger(scaling.max)
    if (maxTasks !== null && maxTasks >= 1) body.max_tasks = maxTasks
  }
  return body
}

// 서버의 추정 응답을 화면이 바로 그릴 문자열로 바꾼다 (없는 값은 null)
export function describeEstimate(estimate) {
  const e = estimate || {}
  const currency = e.currency || 'USD'
  const usd = (value, digits) => formatUsd(value, digits, currency)

  const componentRows = (e.components || []).map((c) => ({
    name: c.name,
    hourly: usd(c.hourly_usd, 4),
    note: c.note ?? null,
  }))
  const periods = (e.periods || []).map((p) => ({ label: p.label, hours: p.hours, usd: usd(p.usd, 2) }))

  const planned = isNum(e.planned_hours) && isNum(e.planned_usd)
    ? `${formatHours(e.planned_hours)} 동안 약 ${usd(e.planned_usd, 2)}`
    : null
  const max = isNum(e.max_tasks) && isNum(e.max_hourly_usd) && isNum(e.max_monthly_usd)
    ? `최대 ${e.max_tasks}개까지 늘면 시간당 최대 ${usd(e.max_hourly_usd, 4)}, 한 달 최대 ${usd(e.max_monthly_usd, 2)}`
    : null
  const arm = isNum(e.arm64_hourly_usd) && isNum(e.arm64_saving_percent)
    ? `ARM64면 약 ${Number(e.arm64_saving_percent.toFixed(1))}% 저렴합니다 (시간당 ${usd(e.arm64_hourly_usd, 4)}). 이 마법사는 x86으로만 빌드합니다`
    : null

  return {
    componentRows,
    hourly: usd(e.hourly_usd, 4),
    periods,
    planned,
    max,
    arm,
    assumptions: e.assumptions || [],
    notIncluded: e.not_included || [],
    basis: e.basis_date ? `기준일 ${e.basis_date} · ${currency}` : null,
  }
}
