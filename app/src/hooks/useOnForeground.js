import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'

// 앱이 백그라운드/비활성이었다가 다시 활성이 될 때마다 callback 을 한 번 부르는 훅 (언마운트하면 리스너를 뗀다, 항상 가장 최근 callback 을 부른다)
export function useOnForeground(callback) {
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    // 화면을 떠나 있었는지 - 활성이 아닌 상태를 본 뒤의 첫 active 만 복귀로 센다
    let away = AppState.currentState === 'background' || AppState.currentState === 'inactive'
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        away = true
      } else if (next === 'active' && away) {
        away = false
        callbackRef.current()
      }
    })
    return () => { subscription?.remove?.() }
  }, [])
}
