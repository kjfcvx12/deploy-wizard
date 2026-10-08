import { STEPS } from './constants.js'

const STEP_LABEL = Object.fromEntries(STEPS.map((step) => [step.key, step.label]))

// 문제 이력 - 다시 배포해도 지난 실패를 모아서 본다 (M5)
export default function IssueHistory({ issues }) {
  if (!issues?.length) return null

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <details>
        <summary>문제 이력 <span className="muted small">({issues.length}건)</span></summary>
        <ul className="issue-list">
          {issues.map((issue) => (
            <li key={issue.d_i_id} className="issue-item">
              <div className="row spread">
                <strong>{STEP_LABEL[issue.step] || issue.step}</strong>
                <span className="muted small">{new Date(issue.created_at).toLocaleString('ko-KR')}</span>
              </div>
              <p className="muted small" style={{ margin: '4px 0 0' }}>
                {issue.explain?.summary || issue.error_msg}
              </p>
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
