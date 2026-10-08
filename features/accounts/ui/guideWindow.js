// 연결 화면과 안내 창이 주고받는 채널 이름 (같은 출처의 창끼리만 들린다)
export const ACCOUNTS_CHANNEL = 'dw-accounts'

// 안내 창 열기 - 화면 오른쪽에 좁게. 반드시 클릭 처리 안에서 바로 불러야 팝업 차단에 안 걸린다
// 차단되면 null 을 돌려준다
export const openGuideWindow = (kind) => {
  const width = 480
  const height = Math.min(900, window.screen.availHeight - 40)
  const left = Math.max(0, window.screen.availWidth - width - 10)

  return window.open(`/guide/${kind}`, 'dw-guide', `popup,width=${width},height=${height},left=${left},top=20`)
}
