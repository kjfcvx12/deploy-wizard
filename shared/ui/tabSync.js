// 탭 사이 잠금·메시지 - 잠금(navigator.locks)과 채널(BroadcastChannel)은 주입한다. 없으면 이 탭 혼자인 것처럼 동작
export function createTabSync({ locks, channel } = {}) {
  return {
    // 같은 이름의 잠금을 다른 탭과 나눠 한 번에 하나만 fn 을 실행한다
    runExclusive(name, fn) {
      if (!locks || typeof locks.request !== 'function') return Promise.resolve().then(fn)
      return locks.request(name, () => fn())
    },
    // 다른 탭에 메시지를 보낸다 (보낸 탭에는 돌아오지 않는다)
    post(message) {
      if (!channel) return
      try { channel.postMessage(message) } catch { /* 닫힌 채널 등은 무시 */ }
    },
    // 다른 탭이 보낸 메시지를 받는다 - 구독 해제 함수를 돌려준다
    onMessage(fn) {
      if (!channel) return () => {}
      const handler = (event) => fn(event?.data)
      channel.addEventListener('message', handler)
      return () => channel.removeEventListener('message', handler)
    },
  }
}

// 브라우저 기본 채널을 만든다 - 지원하지 않으면 없음
function createDefaultChannel() {
  if (typeof BroadcastChannel !== 'function') return undefined
  try {
    const channel = new BroadcastChannel('dw-auth')
    // node(테스트)에서 채널 하나 때문에 프로세스가 끝나지 않는 일을 막는다. 브라우저에는 unref 가 없다
    channel.unref?.()
    return channel
  } catch {
    return undefined
  }
}

export const tabSync = createTabSync({
  locks: typeof navigator !== 'undefined' ? navigator.locks : undefined,
  channel: createDefaultChannel(),
})
