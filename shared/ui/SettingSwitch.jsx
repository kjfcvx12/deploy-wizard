import { useEffect, useId, useRef } from 'react'

// 설정 한 줄 - 줄 전체가 하나의 스위치(이름·설명·상태). 폼 없이 쓰고, 저장 중에는 잠근다
export default function SettingSwitch({ title, description, checked, busy, label, onToggle }) {
  const descId = useId()
  const input = useRef(null)
  const hadFocus = useRef(false)

  // 저장 중에는 입력이 잠겨 포커스가 빠지므로, 끝나면 키보드 사용자의 자리로 되돌린다 (그 사이 다른 곳을 눌렀으면 두고)
  useEffect(() => {
    if (busy || !hadFocus.current) return
    hadFocus.current = false
    const active = document.activeElement
    if (!active || active === document.body) input.current?.focus()
  }, [busy])

  const change = () => {
    hadFocus.current = document.activeElement === input.current
    onToggle()
  }

  return (
    <label className={`setting-row${busy ? ' busy' : ''}`}>
      <span className="setting-body">
        <span className="setting-title">{title}</span>
        <span className="setting-desc" id={descId}>{description}</span>
      </span>
      <span className="setting-control">
        <input
          ref={input}
          className="setting-input"
          type="checkbox"
          role="switch"
          checked={!!checked}
          disabled={!!busy}
          aria-label={label}
          aria-describedby={descId}
          onChange={change}
        />
        <span className="setting-track" aria-hidden="true" />
      </span>
    </label>
  )
}
