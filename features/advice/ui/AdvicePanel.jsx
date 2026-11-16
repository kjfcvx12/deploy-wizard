import { useEffect, useRef } from 'react'

import CostPanel from '@features/pricing/ui/CostPanel.jsx'

import { confidenceLabel, needLabel, tierLabel } from './constants.js'

// 확신도에 따른 배지 모양 - 낮음은 주황(실험 지원 배지와 같은 모양), 높음은 초록
const confidenceClass = (confidence) => (confidence === 'low' ? 'badge exp' : confidence === 'high' ? 'badge ok' : 'badge')

// 필요한 것 한 줄 - 마법사가 만들어 주지 못하는 것은 흐리게 하고 이유를 붙인다
function NeedItem({ need }) {
  const label = needLabel(need.kind)

  if (!need.supported) {
    return <li className="advice-need off">{label}{need.message && ` — ${need.message}`}</li>
  }
  if (need.kind === 'env_vars' && need.count > 0) {
    return <li className="advice-need">환경변수 {need.count}개 입력이 필요합니다</li>
  }
  return <li className="advice-need">{label}{need.message && ` — ${need.message}`}</li>
}

// 배포 전 분석 결과 (S-20) - 보여 주기만 한다. 배포·초기화·비용 옵션 보관은 부모가 처리한다
// costState = { valid, hourly } - 옵션이 올바르지 않으면 배포 버튼을 막고, 시간당 금액이 있으면 버튼 문구에 붙인다
export default function AdvicePanel({ advice, busy, costState, onCostChange, onDeploy, onReset }) {
  const headingRef = useRef(null)

  // 결과가 새로 나오면 제목으로 포커스를 옮겨 화면 읽기와 스크롤 위치를 맞춘다
  useEffect(() => {
    if (advice) headingRef.current?.focus()
  }, [advice])

  if (!advice) return null

  const reasons = advice.reasons || []
  const needs = advice.needs || []
  const unknowns = advice.unknowns || []

  return (
    <section className="card advice">
      <h2 ref={headingRef} tabIndex={-1}>분석 결과</h2>

      <div className="row">
        <code>{advice.language}</code>
        <span className={`badge ${advice.support_level === 'official' ? 'ok' : 'exp'}`}>
          {advice.support_level === 'official' ? '공식 지원' : '실험 지원'}
        </span>
        {advice.app_dir && advice.app_dir !== '.' && <span className="small">앱 폴더: <code>{advice.app_dir}</code></span>}
      </div>

      <div className="advice-tier">
        <span>추천 수준: {tierLabel(advice.tier)}</span>
        <span className={confidenceClass(advice.confidence)}>확신도 {confidenceLabel(advice.confidence)}</span>
      </div>
      {advice.confidence === 'low' && <p className="advice-low small">추정입니다. 근거가 부족해 틀릴 수 있습니다.</p>}

      {reasons.length > 0 && (
        <div className="advice-block">
          <h3>왜 이렇게 추천했나</h3>
          <ul>{reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>
        </div>
      )}

      <CostPanel cost={advice.cost} onChange={onCostChange} disabled={busy} />

      {needs.length > 0 && (
        <div className="advice-block">
          <h3>필요한 것</h3>
          <ul>{needs.map((need, i) => <NeedItem key={`${need.kind}-${i}`} need={need} />)}</ul>
        </div>
      )}

      {unknowns.length > 0 && (
        <details className="advice-block" open>
          <summary>알 수 없었던 것 <span className="muted small">({unknowns.length})</span></summary>
          <ul>{unknowns.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </details>
      )}

      <div className="advice-actions">
        <button type="button" className="primary" onClick={onDeploy} disabled={busy || costState?.valid === false}>
          {costState?.hourly ? `이 레포로 배포 (시간당 약 ${costState.hourly})` : '이 레포로 배포'}
        </button>
        <button type="button" onClick={onReset} disabled={busy}>다른 레포로</button>
      </div>
      <p className="muted small advice-foot">분석은 읽기만 합니다. 배포를 누르기 전에는 AWS에 아무것도 만들지 않습니다.</p>
    </section>
  )
}
