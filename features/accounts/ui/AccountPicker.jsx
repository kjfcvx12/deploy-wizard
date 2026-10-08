import { useEffect, useRef, useState } from 'react'

import { accountsApi } from './api.js'
import { readPickedBlock } from './pickedBlock.js'

// 쓸 수 있는 블록 - AWS 가 확인됐거나 GitHub 가 살아 있는 것
const usable = (block) => block.aws?.status === 'verified' || block.github?.status === 'active'

// 연결 블록 고르기 (M6) - 다른 기능이 가져다 쓴다. 블록 하나를 고르면 그 블록의 AWS 계정과 GitHub 설치가 함께 정해진다
// GitHub 가 살아 있는 블록을 고르면 그 설치가 읽을 수 있는 레포 목록도 넘긴다 (onRepositoriesChange - 주소 입력창의 목록)
export default function AccountPicker({ awsAccountId, onAwsAccountChange, githubInstallationId, onGithubInstallationChange, onRepositoriesChange }) {
  const [blocks, setBlocks] = useState([])
  const [selected, setSelected] = useState('')
  // 블록을 빠르게 바꿔 고르면 늦게 온 목록이 덮어쓰지 않게 한다
  const repositoriesRequest = useRef(0)

  // 레포 목록 불러오기 - 못 불러오면 빈 목록 (주소는 직접 입력할 수 있다)
  const loadRepositories = (g_id) => {
    const request = ++repositoriesRequest.current
    onRepositoriesChange?.([])
    if (!g_id) return

    accountsApi.listGithubRepositories(g_id).then((list) => {
      if (request === repositoriesRequest.current) onRepositoriesChange?.(list)
    }).catch(() => {})
  }

  // 블록 하나를 적용 - 그 블록의 AWS 계정과 GitHub 설치를 함께 넘긴다 (없으면 "연결 안 함")
  const apply = (block) => {
    setSelected(block ? String(block.c_id) : '')
    onAwsAccountChange(block?.aws?.status === 'verified' ? String(block.aws.a_id) : '')
    onGithubInstallationChange(block?.github?.status === 'active' ? String(block.github.g_id) : '')
    loadRepositories(block?.github?.status === 'active' ? block.github.g_id : null)
  }

  useEffect(() => {
    accountsApi.listConnections().then((data) => {
      const next = data.filter(usable)
      setBlocks(next)
      // 연결은 한 번 해 두고 계속 쓰는 것이다 - 블록이 하나뿐이면 그것을, 여럿이면 계정 연결 화면에서 [선택]한 블록을 미리 골라 둔다 (바꿀 수 있다)
      const picked = next.length === 1 ? next[0] : next.find((block) => block.c_id === readPickedBlock())
      if (picked) apply(picked)
    }).catch(() => {})
  }, [])

  // 바깥에서 둘 다 비우면(배포 등록 후 초기화) 선택도 푼다
  useEffect(() => {
    if (!awsAccountId && !githubInstallationId) setSelected('')
  }, [awsAccountId, githubInstallationId])

  const choose = (value) => apply(blocks.find((item) => String(item.c_id) === value))

  if (blocks.length === 0) return null

  return (
    <div className="row" style={{ marginBottom: 10 }}>
      <select value={selected} onChange={(e) => choose(e.target.value)}>
        <option value="">연결 안 함 (개발 계정 · public 레포만)</option>
        {blocks.map((block) => (
          <option key={block.c_id} value={block.c_id}>
            {block.label} — AWS {block.aws?.status === 'verified' ? block.aws.aws_account_id : '개발 계정'}
            {' · '}GitHub {block.github?.status === 'active' ? block.github.account_login : '없음 (public만)'}
          </option>
        ))}
      </select>
    </div>
  )
}
