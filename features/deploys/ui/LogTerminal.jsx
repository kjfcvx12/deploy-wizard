import { useEffect, useRef } from 'react'

// 터미널형 로그 - 바닥을 보고 있을 때만 따라 내려간다
export default function LogTerminal({ logs }) {
  const box = useRef(null)
  const stick = useRef(true)

  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [logs])

  const onScroll = () => {
    const el = box.current
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  return (
    <div className="terminal" ref={box} onScroll={onScroll}>
      {logs.length === 0 && <span className="term-step">로그를 기다리는 중...</span>}
      {logs.map((log) => (
        <div key={log.d_l_id} className={`term-line ${log.level}`}>
          <span className="term-step">[{log.step}] </span>
          {log.message}
        </div>
      ))}
    </div>
  )
}
