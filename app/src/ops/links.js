// 서버 id 는 32비트 양의 정수 (앞에 0 없이)
const MAX_ID = 2147483647

// 허용하는 링크 두 가지뿐: deploywizard://deploys/{n}, deploywizard://incidents/{n} (이미 풀린 /deploys/{n}, /incidents/{n} 도 같다)
// 대소문자 구분, 쿼리·조각·뒤 슬래시·공백은 모두 거절 - 알림 data.link 는 믿을 수 없는 입력이다
const LINK = /^(?:deploywizard:\/\/|\/)(deploys|incidents)\/([1-9][0-9]{0,9})$/

// 알림·딥링크 주소를 앱 안 경로로 바꾼다 - 허용 밖이면 null (라우터에 넘기지 않는다)
export function parseAppLink(url) {
  if (typeof url !== 'string') return null
  const match = LINK.exec(url)
  if (!match) return null
  const id = Number(match[2])
  if (id < 1 || id > MAX_ID) return null
  return match[1] === 'deploys'
    ? { route: `/deploys/${id}`, params: { d_id: String(id) } }
    : { route: `/incidents/${id}`, params: { i_id: String(id) } }
}
