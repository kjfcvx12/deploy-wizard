import { STEPS } from './constants.js'

// 단계별 진행률 - 실패하면 멈춘 단계를 빨갛게
export default function StepProgress({ status, errorStep }) {
  // 입력 대기는 푸시가 끝난 뒤 배포 직전에서 기다리는 것
  const waiting = status === 'needs_input'
  const current = status === 'failed' ? errorStep : waiting ? 'deploying' : status
  const currentIndex = STEPS.findIndex((step) => step.key === current)

  return (
    <ol className="steps">
      {STEPS.map((step, index) => {
        let state = ''
        if (status === 'running' || index < currentIndex) state = 'done'
        else if (index === currentIndex) state = status === 'failed' ? 'fail' : waiting ? 'wait' : 'now'

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
