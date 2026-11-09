import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'

// 앱이 백그라운드/비활성인지 (모르는 값은 활성으로 본다)
const isPaused = (state) => state === 'background' || state === 'inactive'

// 주기적으로 fn 을 부르는 훅 - 바로 한 번 부르고, 결과(또는 에러)로 다음 간격을 정한다
// getDelayMs(값, 에러): 성공이면 (결과, null), 실패면 (에러, 에러). 백그라운드에서는 멈췄다가 돌아오면 한 번 바로 부른다
export function usePolling(fn, getDelayMs, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const fnRef = useRef(fn)
  const delayRef = useRef(getDelayMs)
  const runRef = useRef(null)
  fnRef.current = fn
  delayRef.current = getDelayMs

  useEffect(() => {
    let alive = true
    let timer = null
    let seq = 0
    let paused = isPaused(AppState.currentState)

    const clear = () => {
      clearTimeout(timer)
      timer = null
    }

    // 한 번 부르고 다음 호출을 예약한다 (더 늦게 온 응답이 먼저 온 응답을 덮지 않게 번호를 붙인다)
    const run = async () => {
      clear()
      const mine = ++seq
      let delay
      try {
        const result = await fnRef.current()
        if (!alive || mine !== seq) return
        setData(result)
        setError(null)
        delay = delayRef.current(result, null)
      } catch (e) {
        if (!alive || mine !== seq) return
        setError(e)
        delay = delayRef.current(e, e)
      }
      setLoading(false)
      if (!paused) timer = setTimeout(run, delay)
    }

    runRef.current = run
    run()

    const subscription = AppState.addEventListener('change', (next) => {
      if (!alive) return
      if (isPaused(next)) {
        paused = true
        clear()
      } else if (paused) {
        paused = false
        run()
      }
    })

    return () => {
      alive = false
      runRef.current = null
      clear()
      subscription.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  // 기다리지 않고 지금 바로 한 번 부른다 (끌어당겨 새로고침, 다시 시도)
  const refresh = useCallback(() => (runRef.current ? runRef.current() : Promise.resolve()), [])

  return { data, error, loading, refresh }
}
