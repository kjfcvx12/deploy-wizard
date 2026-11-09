import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'

// 앱이 백그라운드/비활성인지 (모르는 값은 활성으로 본다)
const isPaused = (state) => state === 'background' || state === 'inactive'

// 간격을 못 정했을 때 쓰는 기본 간격(ms)
const DEFAULT_DELAY_MS = 15000

// getDelayMs 가 이 값을 돌려주면 더 예약하지 않는다 (refresh() 나 앱 복귀 때만 다시 부른다)
export const STOP_POLLING = Symbol('STOP_POLLING')

// 주기적으로 fn 을 부르는 훅 - 바로 한 번 부르고, 결과(또는 에러)로 다음 간격을 정한다
// getDelayMs(값, 에러): 성공이면 (결과, null), 실패면 (에러, 에러). 던지거나 유효하지 않은 값이면 직전 간격(없으면 15초)을 쓴다
// 백그라운드에서는 멈췄다가 돌아오면 한 번 바로 부른다. deps 가 바뀌면 data/error 를 비우고 loading 으로 돌아간다
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
    let lastDelay = DEFAULT_DELAY_MS
    let paused = isPaused(AppState.currentState)

    // 이전 deps 의 데이터가 남아 보이지 않게 비운다
    setData(null)
    setError(null)
    setLoading(true)

    const clear = () => {
      clearTimeout(timer)
      timer = null
    }

    // 다음 간격을 정한다 - 계산이 던지거나 값이 이상하면 직전 간격으로 (0ms 반복 방지)
    const nextDelay = (value, failure) => {
      let delay
      try {
        delay = delayRef.current(value, failure)
      } catch (e) {
        return lastDelay
      }
      if (delay === STOP_POLLING) return STOP_POLLING
      if (typeof delay === 'number' && Number.isFinite(delay) && delay > 0) {
        lastDelay = delay
        return delay
      }
      return lastDelay
    }

    // 한 번 부르고 다음 호출을 예약한다 (더 늦게 온 응답이 먼저 온 응답을 덮지 않게 번호를 붙인다)
    const run = async () => {
      clear()
      const mine = ++seq
      let result
      let failure
      let failed = false
      try {
        result = await fnRef.current()
      } catch (e) {
        failed = true
        failure = e
      }
      if (!alive || mine !== seq) return
      if (failed) {
        setError(failure)
      } else {
        setData(result)
        setError(null)
      }
      const delay = failed ? nextDelay(failure, failure) : nextDelay(result, null)
      setLoading(false)
      if (!paused && delay !== STOP_POLLING) timer = setTimeout(run, delay)
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
