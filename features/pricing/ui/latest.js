// 요청 번호 가드 - 마지막으로 시작한 요청의 결과만 받아들이고, 취소하면 모두 버린다
export function createLatest() {
  let current = 0
  let cancelled = false

  return {
    // 새 요청을 시작하고 번호를 돌려준다 (앞선 요청은 낡은 것이 된다)
    start: () => {
      current += 1
      return current
    },
    // 이 번호의 결과를 화면에 써도 되는지
    accept: (id) => !cancelled && id > 0 && id === current,
    // 화면이 사라질 때 - 이후 도착하는 결과는 전부 버린다
    cancel: () => {
      cancelled = true
    },
  }
}
