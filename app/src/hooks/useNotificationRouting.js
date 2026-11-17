import { useEffect, useRef } from 'react'
import { Platform } from 'react-native'
import { useRouter } from 'expo-router'
import * as Notifications from '../ops/notifications'
import { routeFromNotificationResponse } from '../ops/push'

// 앱이 켜져 있는 동안 들어온 알림도 배너와 목록에 보인다 - 소리와 앱 아이콘 숫자는 쓰지 않는다 (SDK 58 NotificationBehavior)
// 안드로이드는 shouldPlaySound 가 false 면 앞에서 받은 알림의 상단 배너가 뜨지 않는다 (타입 정의 설명) - 그래서 안드로이드만 true
const foregroundBehavior = () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: Platform.OS === 'android', shouldSetBadge: false })

// 알림 처리 연결 (루트 레이아웃에서 한 번) - 앞에서 받은 알림의 표시 방식, 알림을 눌렀을 때의 이동(켜져 있을 때·꺼져 있다가 눌러 켠 첫 실행)
// 이동은 routeFromNotificationResponse 가 허용한 경로 두 가지뿐이고 그 밖의 알림은 모두 무시한다. 웹에서는 아무것도 하지 않는다. 권한은 절대 묻지 않는다
// allowed 가 false 인 동안(로그인 확인 전·로그인 필요)은 이동하지 않고 마지막 하나만 기억했다가, true 가 되면 한 번 이동한다
export function useNotificationRouting(allowed = true) {
  const router = useRouter()
  const routerRef = useRef(router)
  routerRef.current = router
  const allowedRef = useRef(allowed)
  allowedRef.current = allowed
  // 허용되기 전에 누른 알림의 갈 곳
  const pendingRef = useRef(null)

  // 허용되면 기다리던 이동을 한 번 한다
  useEffect(() => {
    if (!allowed || !pendingRef.current) return
    const route = pendingRef.current
    pendingRef.current = null
    try {
      routerRef.current.push(route)
    } catch {
      // 아직 화면 이동을 받을 수 없는 순간 - 이 알림은 건너뛴다
    }
  }, [allowed])

  useEffect(() => {
    if (Platform.OS === 'web') return undefined
    // 첫 실행으로 이미 처리한 알림의 id - 같은 알림이 리스너로 또 오면 한 번만 이동하도록 건너뛴다
    let handledId = null
    let subscription = null
    const go = (response) => {
      // 알림 본문을 누른 것(기본 액션)만 이동한다 - 닫기·다른 액션 버튼은 무시
      if (response?.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
      const target = routeFromNotificationResponse(response)
      if (!target) return
      if (!allowedRef.current) {
        pendingRef.current = target.route
        return
      }
      try {
        routerRef.current.push(target.route)
      } catch {
        // 아직 화면 이동을 받을 수 없는 순간 - 이 알림은 건너뛴다
      }
    }
    try {
      Notifications.setNotificationHandler({ handleNotification: async () => foregroundBehavior() })
      subscription = Notifications.addNotificationResponseReceivedListener((response) => {
        const id = response?.notification?.request?.identifier
        if (handledId && id === handledId) {
          handledId = null
          return
        }
        go(response)
      })
      // 앱이 꺼져 있다가 알림을 눌러 켜진 경우 - 마지막 응답을 한 번 처리하고 비운다
      const last = Notifications.getLastNotificationResponse()
      if (last) {
        const id = last?.notification?.request?.identifier
        handledId = typeof id === 'string' ? id : null
        go(last)
        Notifications.clearLastNotificationResponse()
      }
    } catch {
      // 알림 모듈을 쓸 수 없는 환경 - 알림 탭 이동만 빠진다
    }
    return () => {
      subscription?.remove?.()
      try {
        Notifications.setNotificationHandler(null)
      } catch {
        // 이미 정리된 환경
      }
    }
  }, [])
}
