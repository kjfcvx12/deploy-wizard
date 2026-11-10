import { useCallback, useEffect, useRef, useState } from 'react'
import { notificationApi } from '../api'
import { getPushState, readCardDismissed, requestAndRegister, writeCardDismissed } from '../ops/push'

// 배포가 running 이 된 뒤 한 번 보이는 알림 안내 카드의 상태 (F-01) - 카드를 보이는 것까지만 하고, 권한 창은 enable() (버튼)에서만 띄운다
// state: null(안 보임) | 'undetermined'(안내 + 버튼) | 'denied'(거부 안내). active 가 false 면 아무것도 읽지 않는다
export function usePushSetup(active) {
  const alive = useRef(false)
  const busyRef = useRef(false)
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // 보여 줄 조건: running + 아직 안 물음 + 닫은 적 없음
  useEffect(() => {
    // running 을 벗어나면 이미 보이던 카드도 거둔다
    if (!active) {
      setState(null)
      return undefined
    }
    let cancelled = false
    const check = async () => {
      if (await readCardDismissed()) return
      const next = await getPushState()
      if (!cancelled && alive.current && next === 'undetermined') setState('undetermined')
    }
    check()
    return () => { cancelled = true }
  }, [active])

  // [알림 켜기] - 권한을 묻고 이 기기를 등록한다. 거부되면 거부 안내로 바꾸고 다시 띄우지 않게 기억한다
  const enable = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const next = await requestAndRegister()
      if (!alive.current) return
      if (next === 'granted') {
        // 서버 쪽 푸시 설정도 켠다 - 기본값이 켜짐이라 실패해도 카드는 성공으로 본다
        notificationApi.patchSettings({ notify_push: true }).catch(() => {})
        await writeCardDismissed()
        if (alive.current) setState(null)
      } else if (next === 'denied') {
        await writeCardDismissed()
        if (alive.current) setState('denied')
      } else if (alive.current) {
        setState(null)
      }
    } catch (e) {
      if (alive.current) setError(e.message)
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }, [])

  // [나중에] - 카드를 닫고 기억한다
  const dismiss = useCallback(async () => {
    setState(null)
    await writeCardDismissed()
  }, [])

  return { state, busy, error, enable, dismiss }
}
