import { Link } from 'react-router-dom'

import { repoName } from '@features/deploys/ui/constants.js'

import { problemLabel } from './constants.js'

// 목록 위 문제 배너 - 끝나지 않은 인시던트가 있는 배포 하나당 한 줄, 누르면 인시던트 화면 (같은 레포를 구분하도록 접근성 라벨에 배포 번호를 넣는다)
export default function ProblemBanner({ deploy }) {
  const text = `${repoName(deploy.repo_url)}에 문제가 있습니다 · ${problemLabel(deploy)}`
  return (
    <Link to={`/incidents/${deploy.open_incident_id}`} className="problem-banner" aria-label={`${text} (배포 #${deploy.d_id})`}>
      {text}
    </Link>
  )
}
