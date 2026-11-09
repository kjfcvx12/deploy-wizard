// 서버 호출 - 웹의 shared/ui/api.js · features/*/ui/api.js 와 같은 의미 (앱은 app/ 밖을 가져오지 않는다)
// 기본 주소는 EXPO_PUBLIC_API_BASE_URL (빌드 때 코드에 박힌다), 없으면 로컬 서버
const BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8081'
const TIMEOUT_MS = 15000
const NETWORK_ERROR = '서버에 연결할 수 없습니다'

// 공용 fetch 래퍼 - 에러는 FastAPI의 detail(한국어)을 그대로 던진다
export async function request(path, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    let response
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      })
    } catch (e) {
      throw new Error(NETWORK_ERROR)
    }

    if (response.status === 204) return null

    let data = null
    try {
      data = await response.json()
    } catch (e) {
      // 성공(2xx)인데 본문이 잘렸거나 JSON 이 아니면, 또는 읽는 중 시간이 다 되면 성공으로 넘기지 않는다 (204 는 위에서 null)
      if (response.ok || controller.signal.aborted) throw new Error(NETWORK_ERROR)
      data = null
    }

    if (!response.ok) {
      const detail = data?.detail
      const message = Array.isArray(detail) ? detail.map((d) => d.msg).join(', ') : detail
      throw new Error(message || `요청 실패 (${response.status})`)
    }

    return data
  } finally {
    clearTimeout(timer)
  }
}

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
}

// features/envvars/router.py 와 1:1 (값은 쓰기 전용 - 응답에 나오지 않는다)
export const envApi = {
  getAll: (d_id) => request(`/api/deploys/${d_id}/env`),
  put: (d_id, name, body) => request(`/api/deploys/${d_id}/env/${encodeURIComponent(name)}`, { method: 'PUT', body }),
  clearValue: (d_id, name) => request(`/api/deploys/${d_id}/env/${encodeURIComponent(name)}/value`, { method: 'DELETE' }),
  continueDeploy: (d_id) => request(`/api/deploys/${d_id}/env/continue`, { method: 'POST' }),
}

// features/advice/router.py 와 1:1 (배포 기록을 만들지 않는 읽기 전용 분석)
export const adviceApi = {
  analyze: ({ repo_url, branch, aws_account_id, github_installation_id }) => request('/api/deploys/advice', {
    method: 'POST',
    body: { repo_url, branch: branch || null, aws_account_id: aws_account_id || null, github_installation_id: github_installation_id || null },
  }),
}

// features/accounts/router.py 와 1:1 (웹 features/accounts/ui/api.js 와 같은 주소·본문)
export const accountApi = {
  // 연결 블록 - AWS 계정 하나 + GitHub 설치 하나
  getConnections: () => request('/api/accounts/connections'),
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
  getGithubRepositories: (g_id) => request(`/api/accounts/github/${g_id}/repositories`),
  checkGithub: (g_id) => request(`/api/accounts/github/${g_id}/check`),
  deleteGithub: (g_id) => request(`/api/accounts/github/${g_id}`, { method: 'DELETE' }),
}
