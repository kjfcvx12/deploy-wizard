import { request } from '@shared/ui/api.js'

// features/pricing/router.py 와 1:1 (옵션 목록, 비용 추정)
export const pricingApi = {
  getOptions: () => request('/api/pricing/options'),
  estimate: (body) => request('/api/pricing/estimate', { method: 'POST', body }),
}
