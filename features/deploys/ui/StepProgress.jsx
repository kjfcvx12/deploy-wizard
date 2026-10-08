import { STEPS } from './constants.js'

// 단계별 진행률 - 실패하면 멈춘 단계를 빨갛게
export default function StepProgress({ status, errorStep }) {
  const current = status === 'failed' ? errorStep : status
  const currentIndex = STEPS.findIndex((step) => step.key === current)

  return (
    <ol className="steps">
      {STEPS.map((step, index) => {
        let state = ''
        if (status === 'running' || index < currentIndex) state = 'done'
        else if (index === currentIndex) state = status === 'failed' ? 'fail' : 'now'

        return (
          <li key={step.key} className={`step ${state}`}>
            <div className="step-bar" />
            {step.label}
          </li>
        )
      })}
    </ol>
  )
}
