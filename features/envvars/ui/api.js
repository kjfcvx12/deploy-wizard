import { request } from '@shared/ui/api.js'

// features/envvars/router.py 와 1:1 (값은 쓰기 전용 - 응답에 나오지 않는다)
export const envApi = {
  getAll: (d_id) => request(`/api/deploys/${d_id}/env`),
  put: (d_id, name, body) => request(`/api/deploys/${d_id}/env/${encodeURIComponent(name)}`, { method: 'PUT', body }),
  clearValue: (d_id, name) => request(`/api/deploys/${d_id}/env/${encodeURIComponent(name)}/value`, { method: 'DELETE' }),
  continueDeploy: (d_id) => request(`/api/deploys/${d_id}/env/continue`, { method: 'POST' }),
}
