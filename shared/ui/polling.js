// 폴링 간격 - 연속 실패 횟수만큼 두 배로 늘리고 최대값에서 멈춘다 (실패 0 이면 기본 간격)
export function backoffDelay(baseMs, failures, maxMs = 30000) {
  if (failures <= 0) return baseMs
  return Math.min(maxMs, baseMs * 2 ** (failures - 1))
}
