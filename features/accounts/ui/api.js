import { request } from '@shared/ui/api.js'

// features/accounts/router.py 와 1:1
export const accountsApi = {
  // 연결 블록 - AWS 계정 하나 + GitHub 설치 하나
  listConnections: () => request('/api/accounts/connections'),
  createConnection: (label) => request('/api/accounts/connections', { method: 'POST', body: { label } }),
  createConnectionAws: (c_id) => request(`/api/accounts/connections/${c_id}/aws`, { method: 'POST' }),
  setConnectionAws: (c_id, aws_account_id) => request(`/api/accounts/connections/${c_id}`, { method: 'PATCH', body: { aws_account_id } }),
  setConnectionGithub: (c_id, github_installation_id) => request(`/api/accounts/connections/${c_id}`, { method: 'PATCH', body: { github_installation_id } }),
  deleteConnection: (c_id) => request(`/api/accounts/connections/${c_id}`, { method: 'DELETE' }),

  listAws: () => request('/api/accounts/aws'),
  createAws: (label, region) => request('/api/accounts/aws', { method: 'POST', body: { label, region: region || null } }),
  attachRole: (a_id, role_arn) => request(`/api/accounts/aws/${a_id}/role-arn`, { method: 'PATCH', body: { role_arn } }),
  reverifyAws: (a_id) => request(`/api/accounts/aws/${a_id}/reverify`, { method: 'POST' }),
  getTemplateStatus: (a_id) => request(`/api/accounts/aws/${a_id}/template-status`),
  deleteTemplateFiles: (a_id) => request(`/api/accounts/aws/${a_id}/template-files`, { method: 'DELETE' }),
  deleteAws: (a_id) => request(`/api/accounts/aws/${a_id}`, { method: 'DELETE' }),

  listGithub: () => request('/api/accounts/github'),
  getGithubInstallUrl: (c_id) => request('/api/accounts/github/install-url' + (c_id ? `?c_id=${c_id}` : '')),
  listGithubRepositories: (g_id) => request(`/api/accounts/github/${g_id}/repositories`),
  checkGithub: (g_id) => request(`/api/accounts/github/${g_id}/check`),
  deleteGithub: (g_id) => request(`/api/accounts/github/${g_id}`, { method: 'DELETE' }),
}
