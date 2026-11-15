import { useEffect, useRef, useState } from 'react'

// 복사됨 표시를 거두는 시간(ms)
const COPIED_MS = 2000

// 원인 · 고칠 곳(고정폭, 선택·복사 가능) · 해야 할 일 - explain 이 null 이거나 일부만 있어도 그린다 (글자로만 그린다). 복사에 성공하면 앞선 복사 실패 안내(onCopyError)를 비운다
export default function IncidentExplain({ explain, onCopyError }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  const cause = explain?.cause || '아직 원인을 확인하지 못했습니다'
  const fixWhere = explain?.fix_where
  const actions = Array.isArray(explain?.actions) ? explain.actions : []

  // 고칠 곳을 복사한다 - 클립보드를 쓸 수 없거나 거절되면 알린다
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('copy failed')
      await navigator.clipboard.writeText(fixWhere)
      onCopyError('')
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    } catch (e) {
      onCopyError('고칠 곳을 복사하지 못했습니다')
    }
  }

  return (
    <>
      <section className="card">
        <h2>원인</h2>
        <p className="body-text">{cause}</p>
      </section>

      {!!fixWhere && (
        <section className="card">
          <h2>고칠 곳</h2>
          <pre className="fix-where">{fixWhere}</pre>
          <button type="button" className={`copy ${copied ? 'done' : ''}`} onClick={copy} aria-label={copied ? '고칠 곳 복사됨' : '고칠 곳 복사'}>{copied ? '복사됨' : '복사'}</button>
          <span className="sr-only" role="status">{copied ? '고칠 곳을 복사했습니다' : ''}</span>
        </section>
      )}

      {actions.length > 0 && (
        <section className="card">
          <h2>해야 할 일</h2>
          <ol className="todo-list">
            {actions.map((action, index) => <li key={`${index}-${action}`}>{action}</li>)}
          </ol>
        </section>
      )}
    </>
  )
}
