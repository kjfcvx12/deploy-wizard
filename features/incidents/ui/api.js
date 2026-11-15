import { request } from '@shared/ui/api.js'

// features/incidents/router.py 중 웹이 쓰는 것만 (읽기 전용 - 인시던트는 서버가 만들고 닫는다)
export const incidentApi = {
  getOne: (i_id) => request(`/api/incidents/${i_id}`),
}
