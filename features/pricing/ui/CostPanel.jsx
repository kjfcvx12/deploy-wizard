import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { pricingApi } from './api.js'
import { BILLING_NOTICE, CREATED_RESOURCES, ESTIMATE_DEBOUNCE_MS, PRICE_FAIL_TEXT, SCALING_DEFAULTS } from './constants.js'
import {
  buildDeployOptions, buildEstimateBody, describeEstimate, estimateFromCost, parsePlannedHours, validateScaling,
} from './costLogic.js'
import { createLatest } from './latest.js'
import { rejectText } from './rejectText.js'

const EMPTY_SCALING = { enabled: false, min: '', max: '', metric: '', target: '' }
const BLANK_SCALING_TEXT = '증설 값을 모두 적거나, 자동 증설 체크를 풀어 주세요'

// 증설 입력이 전부 비어 있는지
const scalingIsBlank = (scaling) => [scaling.min, scaling.max, scaling.metric, scaling.target].every((v) => String(v).trim() === '')

// 구성 요소별 시간당 가격 표 - 좁은 화면에서는 이름이 줄바꿈된다
function ComponentTable({ view }) {
  return (
    <table className="cost-table" aria-label="구성 요소별 시간당 가격">
      <thead>
        <tr><th scope="col">구성 요소</th><th scope="col" className="num">시간당</th></tr>
      </thead>
      <tbody>
        {view.componentRows.map((row, i) => (
          <tr key={`${row.name}-${i}`}>
            <td>{row.name}{row.note && <span className="muted small cost-note">{row.note}</span>}</td>
            <td className="num">{row.hourly ?? '-'}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr><th scope="row">시간당 합계</th><td className="num">{view.hourly ?? '-'}</td></tr>
      </tfoot>
    </table>
  )
}

// 기간별 금액 표
function PeriodTable({ view }) {
  if (view.periods.length === 0) return null
  return (
    <table className="cost-table" aria-label="기간별 예상 금액">
      <thead>
        <tr><th scope="col">기간</th><th scope="col" className="num">예상 금액</th></tr>
      </thead>
      <tbody>
        {view.periods.map((p) => (
          <tr key={p.label}><td>{p.label}</td><td className="num">{p.usd}</td></tr>
        ))}
      </tbody>
    </table>
  )
}

// 배포 직전 비용 패널 - 분석 응답의 cost 로 처음 그리고, 사양·사용 계획·증설 옵션을 바꾸면 서버에 다시 추정을 묻는다
// onChange(선택, 유효 여부, { options, hourly }) - options 는 배포 요청에 실을 값, hourly 는 시간당 금액 글자(없으면 null)
export default function CostPanel({ cost, onChange, disabled }) {
  const uid = useId()
  const [options, setOptions] = useState(null)
  const [optionsFailed, setOptionsFailed] = useState(false)
  const [specKey, setSpecKey] = useState('')
  const [plannedText, setPlannedText] = useState('')
  const [scaling, setScaling] = useState(EMPTY_SCALING)
  const [estimate, setEstimate] = useState(null)
  const [status, setStatus] = useState(() => (estimateFromCost(cost) ? 'ready' : 'loading'))
  const [rejected, setRejected] = useState('')
  const latestRef = useRef(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const cap = options?.max_tasks_cap
  const metrics = options?.scale_metrics

  // 화면이 사라지면 늦게 오는 응답을 모두 버린다
  useEffect(() => {
    const latest = createLatest()
    latestRef.current = latest
    return () => latest.cancel()
  }, [])

  // 선택지 한 번 불러오기 - 실패해도 사양·증설 선택만 빠지고 기본 사양으로 배포할 수 있다
  useEffect(() => {
    let alive = true
    pricingApi.getOptions()
      .then((data) => { if (alive) setOptions(data) })
      .catch(() => { if (alive) setOptionsFailed(true) })
    return () => { alive = false }
  }, [])

  const selection = useMemo(() => {
    const [cpu, memory] = specKey ? specKey.split('/') : ['', '']
    return { cpu, memory, plannedHours: plannedText, scaling }
  }, [specKey, plannedText, scaling])

  const planned = parsePlannedHours(plannedText)
  let scalingProblem = null
  if (scaling.enabled) scalingProblem = scalingIsBlank(scaling) ? BLANK_SCALING_TEXT : validateScaling(scaling, cap, metrics)
  const problem = planned.error || scalingProblem
  const valid = !problem && !rejected

  const pristine = !specKey && !plannedText.trim() && !scaling.enabled
  const fromCost = useMemo(() => estimateFromCost(cost), [cost])
  const useCost = Boolean(pristine && fromCost)

  // 옵션이 바뀌면 잠시 뒤 추정을 다시 부른다 (손대지 않았고 분석 비용이 있으면 부르지 않는다) - 낡은 응답은 요청 번호로 버린다
  useEffect(() => {
    const latest = latestRef.current
    if (!latest) return undefined
    const id = latest.start()
    setRejected('')
    if (useCost) { setStatus('ready'); return undefined }
    if (problem) { setStatus('stale'); return undefined }
    setStatus('loading')
    const timer = setTimeout(async () => {
      try {
        const data = await pricingApi.estimate(buildEstimateBody(selection))
        if (!latest.accept(id)) return
        setEstimate(data)
        setStatus('ready')
      } catch (e) {
        if (!latest.accept(id)) return
        setEstimate(null)
        setStatus('error')
        if (e.status === 400 || e.status === 422) setRejected(rejectText(e.message))
      }
    }, ESTIMATE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [selection, problem, useCost])

  let shown = null
  if (useCost) shown = fromCost
  else if (status === 'ready' || status === 'loading' || status === 'stale') shown = estimate
  const view = useMemo(() => (shown ? describeEstimate(shown) : null), [shown])
  const hourly = view && (useCost || status === 'ready') ? view.hourly : null

  const deployOptions = useMemo(() => buildDeployOptions(selection, cap, metrics), [selection, cap, metrics])

  // 부모에게 현재 선택을 알린다 (배포 버튼의 활성·문구와 요청 본문에 쓴다)
  useEffect(() => {
    onChangeRef.current?.(selection, valid, { options: deployOptions, hourly })
  }, [selection, valid, deployOptions, hourly])

  // 증설을 처음 켜면 값이 비어 있는 칸만 기본값으로 채운다
  const toggleScaling = (enabled) => {
    setScaling((prev) => {
      if (!enabled) return { ...prev, enabled: false }
      return {
        enabled: true,
        min: prev.min || SCALING_DEFAULTS.min,
        max: prev.max || String(Math.min(Number(SCALING_DEFAULTS.max), cap || Number(SCALING_DEFAULTS.max))),
        metric: prev.metric || metrics?.[0]?.value || '',
        target: prev.target || SCALING_DEFAULTS.target,
      }
    })
  }
  const setScalingField = (field) => (event) => setScaling((prev) => ({ ...prev, [field]: event.target.value }))

  const scalingA11y = { 'aria-invalid': Boolean(scalingProblem), 'aria-describedby': scalingProblem ? `${uid}-scaling-err` : undefined }
  const targetHint = scaling.metric === 'REQUEST_COUNT_PER_TARGET' ? '요청 수는 1~100000' : 'CPU·메모리 사용률(%)은 1~100'
  const canScale = Boolean(options && cap && metrics?.length)
  const priceMissing = !view && status !== 'loading' && !problem

  return (
    <section className="cost-panel" aria-label="예상 비용">
      <h3>배포하면 만들어지는 것과 비용</h3>
      <ul className="cost-resources">
        {CREATED_RESOURCES.map((item) => <li key={item}>{item}</li>)}
      </ul>

      <div className="cost-options">
        {options && (
          <div className="cost-field">
            <label htmlFor={`${uid}-spec`}>사양 (CPU·메모리)</label>
            <select id={`${uid}-spec`} value={specKey} onChange={(e) => setSpecKey(e.target.value)} disabled={disabled}>
              <option value="">기본 (AWS 기본 사양)</option>
              {options.specs.map((spec) => (
                <option key={`${spec.cpu}/${spec.memory}`} value={`${spec.cpu}/${spec.memory}`}>{spec.label}</option>
              ))}
            </select>
          </div>
        )}

        <div className="cost-field">
          <label htmlFor={`${uid}-hours`}>사용 계획 (시간)</label>
          {options && (
            <div className="cost-quick" role="group" aria-label="사용 계획 빠른 선택">
              {options.plans.map((plan) => {
                const value = plan.hours === null ? '' : String(plan.hours)
                return (
                  <button
                    key={plan.label} type="button" disabled={disabled}
                    aria-pressed={plannedText.trim() === value}
                    onClick={() => setPlannedText(value)}
                  >{plan.label}</button>
                )
              })}
            </div>
          )}
          <input
            id={`${uid}-hours`} type="text" inputMode="decimal" autoComplete="off"
            placeholder="직접 입력 (비우면 계속)" value={plannedText} disabled={disabled}
            aria-invalid={Boolean(planned.error)} aria-describedby={planned.error ? `${uid}-hours-err` : undefined}
            onChange={(e) => setPlannedText(e.target.value)}
          />
          <p id={`${uid}-hours-err`} className="cost-err small" role="status" aria-live="polite">{planned.error || ''}</p>
          <p className="muted small cost-hint">정한 시간을 넘기면 알림만 보냅니다. 자동으로 끄지 않습니다.</p>
        </div>

        {canScale && (
          <div className="cost-field">
            <label className="cost-check">
              <input type="checkbox" checked={scaling.enabled} disabled={disabled} onChange={(e) => toggleScaling(e.target.checked)} />
              <span>트래픽이 늘면 자동으로 늘리기</span>
            </label>
            {scaling.enabled && (
              <>
                <div className="cost-grid">
                  <div className="cost-field">
                    <label htmlFor={`${uid}-min`}>최소 개수</label>
                    <input id={`${uid}-min`} type="text" inputMode="numeric" autoComplete="off" value={scaling.min} disabled={disabled} {...scalingA11y} onChange={setScalingField('min')} />
                  </div>
                  <div className="cost-field">
                    <label htmlFor={`${uid}-max`}>최대 개수</label>
                    <input id={`${uid}-max`} type="text" inputMode="numeric" autoComplete="off" value={scaling.max} disabled={disabled} {...scalingA11y} onChange={setScalingField('max')} />
                  </div>
                  <div className="cost-field">
                    <label htmlFor={`${uid}-metric`}>늘리는 기준</label>
                    <select id={`${uid}-metric`} value={scaling.metric} disabled={disabled} {...scalingA11y} onChange={setScalingField('metric')}>
                      <option value="">기준 고르기</option>
                      {metrics.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </div>
                  <div className="cost-field">
                    <label htmlFor={`${uid}-target`}>목표값</label>
                    <input id={`${uid}-target`} type="text" inputMode="numeric" autoComplete="off" value={scaling.target} disabled={disabled} {...scalingA11y} onChange={setScalingField('target')} />
                  </div>
                </div>
                <p className="muted small cost-hint">작업 개수는 1~{cap}개까지. 목표값: {targetHint}. 늘어난 만큼 요금도 늘어납니다.</p>
                <p id={`${uid}-scaling-err`} className="cost-err small" role="status" aria-live="polite">{scalingProblem || ''}</p>
              </>
            )}
          </div>
        )}
        {optionsFailed && <p className="muted small cost-hint">사양·증설 선택지를 가져오지 못해 기본 사양으로 배포합니다. 사용 계획은 직접 적을 수 있습니다.</p>}
      </div>

      {status === 'loading' && !useCost && <p className="muted small cost-hint" aria-hidden="true">가격을 계산하는 중...</p>}
      <div className="cost-live" role="status" aria-live="polite">
        {rejected && <p className="notice err">{rejected}</p>}
        {priceMissing && !rejected && (
          <p className="notice warn">{PRICE_FAIL_TEXT}{cost?.note ? ` (${cost.note})` : ''}</p>
        )}
        {view && (
          <>
            <p className="cost-total">시간당 합계 <strong>{view.hourly ?? '-'}</strong></p>
            {view.planned && <p className="cost-total">예정 사용: {view.planned}</p>}
            {view.max && <p className="cost-total">{view.max}</p>}
            {status === 'stale' && <p className="muted small cost-hint">값을 고치면 금액을 다시 계산합니다.</p>}
          </>
        )}
      </div>

      {view && (
        <>
          <ComponentTable view={view} />
          <PeriodTable view={view} />
          {view.arm && <p className="muted small cost-hint">{view.arm}</p>}
          {(shown?.spec_label || !specKey) && (
            <p className="muted small cost-hint">
              {specKey
                ? `${shown?.spec_label ?? '선택한 사양'} 기준 금액입니다.`
                : `기본 사양은 AWS 가 정합니다. 금액은 ${shown?.spec_label ?? '기본 사양'} 기준 추정이며 실제 사양은 배포 뒤에 확인됩니다.`}
            </p>
          )}
          <details className="advice-block">
            <summary>가정과 포함되지 않는 것</summary>
            {view.assumptions.length > 0 && <ul>{view.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul>}
            {view.notIncluded.length > 0 && (
              <>
                <p className="small cost-hint"><strong>포함되지 않는 것</strong></p>
                <ul>{view.notIncluded.map((item, i) => <li key={i}>{item}</li>)}</ul>
              </>
            )}
            {view.basis && <p className="muted small cost-hint">{view.basis}. 온디맨드 USD 추정치이며 실제 청구와 다를 수 있습니다.</p>}
          </details>
        </>
      )}

      <p className="notice warn cost-billing">{BILLING_NOTICE}</p>
    </section>
  )
}
