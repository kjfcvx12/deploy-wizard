// 실패 해설 + 선택지 (M5)
// 묻는 방식은 열린 질문이 아니라 버튼 두세 개 (기획서 03장)
const SOURCE_LABEL = { rule: '알려진 에러', llm: 'AI 해설', none: '' }

export default function ExplainCard({ explain, errorStep, errorMsg, hasResources, busy, onRedeploy, onCleanup }) {
  return (
    <section className="card explain">
      <div className="row spread">
        <h2>{explain?.summary || `${errorStep} 단계에서 실패했습니다.`}</h2>
        {explain && SOURCE_LABEL[explain.source] && (
          <span className="badge">{SOURCE_LABEL[explain.source]}{explain.cached ? ' (캐시)' : ''}</span>
        )}
      </div>

      {explain?.cause && <p style={{ margin: '0 0 4px' }}>{explain.cause}</p>}

      {explain?.actions?.length > 0 && (
        <ol>
          {explain.actions.map((action) => <li key={action}>{action}</li>)}
        </ol>
      )}

      {errorMsg && <div className="explain-raw">{errorMsg}</div>}

      <div className="row" style={{ marginTop: 16 }}>
        <button className="primary" onClick={onRedeploy} disabled={busy}>다시 배포</button>
        {hasResources && <button className="danger" onClick={onCleanup} disabled={busy}>만들어진 리소스 정리</button>}
        <span className="muted small">아무것도 누르지 않으면 그대로 둡니다. 자동으로 지우지 않습니다.</span>
      </div>
    </section>
  )
}
