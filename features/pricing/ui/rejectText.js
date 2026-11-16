// 서버가 거절한 이유를 보여 줄 때 쓰는 한국어 안내 (영어 검증 문장 대신)
export const REJECT_FALLBACK = '입력값을 확인해 주세요'

// 서버 문장에 한글이 있으면 그대로, 아니면(pydantic 영어 등) 한국어 안내로 바꾼다
export function rejectText(message) {
  if (typeof message === 'string' && /[가-힣]/.test(message)) return message
  return REJECT_FALLBACK
}
