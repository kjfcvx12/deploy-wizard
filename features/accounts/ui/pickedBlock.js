// 고른 연결 블록 - 계정 연결 화면에서 [선택]한 블록을 새 배포 폼(AccountPicker)이 미리 골라 둔다
// 이 브라우저에만 기억한다 (서버에는 저장하지 않는다)
const PICKED_BLOCK_KEY = 'dw-picked-block'

export const readPickedBlock = () => {
  try {
    return Number(window.localStorage.getItem(PICKED_BLOCK_KEY)) || null
  } catch {
    return null
  }
}

export const writePickedBlock = (c_id) => {
  try {
    window.localStorage.setItem(PICKED_BLOCK_KEY, String(c_id))
  } catch {
    // 저장이 막힌 브라우저 - 이번 화면에서만 기억한다
  }
}
