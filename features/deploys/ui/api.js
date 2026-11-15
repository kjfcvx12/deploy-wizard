import { request } from '@shared/ui/api.js'

// features/deploys/router.py 와 1:1
export const deployApi = {
  getAll: () => request('/api/deploys'),
  getOne: (d_id) => request(`/api/deploys/${d_id}`),
  getLogs: (d_id, after = 0) => request(`/api/deploys/${d_id}/logs?after=${after}`),
  getIssues: (d_id) => request(`/api/deploys/${d_id}/issues`),
  getHealth: (d_id) => request(`/api/deploys/${d_id}/health`),
  getRemote: (repo_url, github_installation_id) => request(
    `/api/deploys/remote?repo_url=${encodeURIComponent(repo_url)}` +
    (github_installation_id ? `&github_installation_id=${github_installation_id}` : '')),
  create: (repo_url, branch, aws_account_id, github_installation_id) => request('/api/deploys', {
    method: 'POST',
    body: { repo_url, branch: branch || null, aws_account_id: aws_account_id || null, github_installation_id: github_installation_id || null },
  }),
  redeploy: (d_id) => request(`/api/deploys/${d_id}/redeploy`, { method: 'POST' }),
  stop: (d_id) => request(`/api/deploys/${d_id}/stop`, { method: 'POST' }),
  start: (d_id) => request(`/api/deploys/${d_id}/start`, { method: 'POST' }),
  remove: (d_id) => request(`/api/deploys/${d_id}`, { method: 'DELETE' }),
  // 보낸 항목만 바뀐다 ({ auto_redeploy, auto_recover })
  patchSettings: (d_id, body) => request(`/api/deploys/${d_id}/settings`, { method: 'PATCH', body }),
  // 헬스체크 이력 - hours 는 1~168
  getHealthHistory: (d_id, hours = 24) => request(`/api/deploys/${d_id}/health-history?hours=${hours}`),
}
