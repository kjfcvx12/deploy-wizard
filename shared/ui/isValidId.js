// 주소의 id 가 서버가 받는 양의 정수(2147483647 이하)인지 본다 - 아니면 요청을 보내지 않는다
export function isValidId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value)) return false
  return Number(value) <= 2147483647
}
