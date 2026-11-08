import { request } from '@shared/ui/api.js'

// features/advice/router.py 와 1:1 (배포 기록을 만들지 않는 읽기 전용 분석)
export const adviceApi = {
  analyze: ({ repo_url, branch, aws_account_id, github_installation_id }) => request('/api/deploys/advice', {
    method: 'POST',
    body: { repo_url, branch: branch || null, aws_account_id: aws_account_id || null, github_installation_id: github_installation_id || null },
  }),
}
