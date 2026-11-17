import { request } from '@shared/ui/api.js'

// features/auth/router.py 와 1:1 - 설정·로그인·갱신·로그아웃은 공개라 토큰을 붙이지 않고 401 재시도도 하지 않는다
export const authApi = {
  getConfig: () => request('/api/auth/config', { auth: false }),
  loginGoogle: (id_token) => request('/api/auth/google', { method: 'POST', body: { id_token, platform: 'web' }, auth: false }),
  // 리프레시 토큰은 httpOnly 쿠키(dw_refresh)라 본문이 없다
  refresh: () => request('/api/auth/refresh', { method: 'POST', auth: false }),
  logout: () => request('/api/auth/logout', { method: 'POST', auth: false }),

  getMe: () => request('/api/me'),
  deleteMe: () => request('/api/me', { method: 'DELETE', body: { confirm: true } }),

  listTokens: () => request('/api/auth/tokens'),
  createToken: ({ name, expires_in_days }) => request('/api/auth/tokens', { method: 'POST', body: { name, expires_in_days } }),
  revokeToken: (a_t_id) => request(`/api/auth/tokens/${a_t_id}`, { method: 'DELETE' }),
}
