// features/deploys/models.py 의 status 값과 같아야 한다
export const STEPS = [
  { key: 'cloning', label: '클론' },
  { key: 'analyzing', label: '판별' },
  { key: 'generating', label: 'Dockerfile' },
  { key: 'building', label: '빌드' },
  { key: 'pushing', label: '푸시' },
  { key: 'deploying', label: '배포' },
  { key: 'running', label: '완료' },
]

export const STATUS_LABEL = {
  queued: '대기',
  cloning: '클론 중',
  analyzing: '판별 중',
  generating: 'Dockerfile 생성 중',
  building: '빌드 중',
  pushing: '푸시 중',
  deploying: '배포 중',
  running: '정상',
  failed: '실패',
  stopped: '멈춤',
  deleting: '삭제 중',
  deleted: '삭제됨',
}

export const PROGRESS = ['queued', 'cloning', 'analyzing', 'generating', 'building', 'pushing', 'deploying', 'deleting']

export const isProgress = (status) => PROGRESS.includes(status)

export const repoName = (repo_url) => repo_url.replace('https://github.com/', '')
