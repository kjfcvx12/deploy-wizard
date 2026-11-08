import { STATUS_LABEL, isProgress } from './constants.js'

export default function StatusBadge({ status }) {
  const tone = status === 'running' ? 'ok' : status === 'failed' ? 'err' : status === 'needs_input' ? 'exp' : isProgress(status) ? 'run' : ''

  return <span className={`badge ${tone}`}>{STATUS_LABEL[status] || status}</span>
}
