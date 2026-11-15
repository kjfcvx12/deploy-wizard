import { useCallback, useEffect, useRef, useState } from 'react'

// schedule 이 값을 못 정했을 때 쓰는 기본 간격(ms)
const DEFAULT_DELAY_MS = 15000

// 주기적으로 fetcher 를 부르는 훅 - 바로 한 번 부르고 schedule(data, error) 가 돌려준 ms 뒤에 다시 부른다 (null 이면 멈춘다)
// 실패해도 마지막 data 는 그대로 두고, 탭이 숨겨진 동안은 멈췄다가 다시 보이면 한 번 바로 부른다. deps 가 바뀌면 data 를 비운다
export function usePolling(fetcher, schedule, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const fetcherRef = useRef(fetcher)
  const scheduleRef = useRef(schedule)
  const runRef = useRef(null)
  fetcherRef.current = fetcher
  scheduleRef.current = schedule

  useEffect(() => {
    let alive = true
    let timer = null
    let seq = 0
    let lastDelay = DEFAULT_DELAY_MS
    let lastData = null
    let stopped = false
    let paused = document.hidden

    setState({ data: null, error: null, loading: true })

    const clear = () => {
      clearTimeout(timer)
      timer = null
    }

    // 다음 간격을 정한다 - 계산이 던지거나 값이 이상하면 직전 간격으로 (0ms 반복 방지), null 이면 멈춘다
    const nextDelay = (data, error) => {
      let delay
      try {
        delay = scheduleRef.current(data, error)
      } catch (e) {
        return lastDelay
      }
      if (delay === null) return null
      if (typeof delay === 'number' && Number.isFinite(delay) && delay > 0) {
        lastDelay = delay
        return delay
      }
      return lastDelay
    }

    // 한 번 부르고 다음 호출을 예약한다 (늦게 온 응답이 먼저 온 응답을 덮지 않게 번호를 붙인다)
    const run = async () => {
      clear()
      const mine = ++seq
      let result = null
      let failure = null
      try {
        result = await fetcherRef.current()
      } catch (e) {
        failure = e
      }
      if (!alive || mine !== seq) return
      if (failure) {
        setState((prev) => ({ data: prev.data, error: failure, loading: false }))
      } else {
        lastData = result
        setState({ data: result, error: null, loading: false })
      }
      const delay = nextDelay(failure ? lastData : result, failure)
      stopped = delay === null
      if (!paused && !stopped) timer = setTimeout(run, delay)
    }

    runRef.current = run
    run()

    // 숨겨진 탭에서는 멈추고, 다시 보이면 (멈춘 상태가 아니면) 한 번 바로 부른다
    const onVisibility = () => {
      if (!alive) return
      if (document.hidden) {
        paused = true
        clear()
      } else if (paused) {
        paused = false
        if (!stopped) run()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      alive = false
      runRef.current = null
      clear()
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  // 기다리지 않고 지금 바로 한 번 부른다 (새로 고침 버튼, 동작 뒤)
  const refresh = useCallback(() => (runRef.current ? runRef.current() : Promise.resolve()), [])

  return { ...state, refresh }
}
