// 계정 연결 화면의 알림 문장 - 웹 AccountsPage.jsx 의 announceGithub / announceAws / cleanupTemplateFiles 와 같은 글

// GitHub 연결 확인 결과 (접근 가능한 저장소 수와 이름)
export const githubCheckNotice = (check) => {
  const more = check.repository_count > check.repositories.length ? ' 외' : ''
  const names = check.repositories.length > 0 ? ` (${check.repositories.join(', ')}${more})` : ''
  return `GitHub 연결 확인됨 — ${check.account_login} · 레포 ${check.repository_count}개에 접근할 수 있습니다${names}`
}

// AWS 연결 확인됨 (계정 정보 + 템플릿 상태)
export const awsVerifiedNotice = (account, state) => (
  `AWS 계정 연결 확인됨 — ${account.label} · 계정 ${account.aws_account_id} · 역할 위임과 템플릿(버전 ${state.current_version})을 확인했습니다`
)

// 올렸던 템플릿 파일 삭제 결과
export const cleanupNotice = (deleted) => (deleted > 0
  ? `올렸던 템플릿 파일 ${deleted}개를 삭제했습니다. 스택과 연결은 그대로라 다시 등록할 것은 없습니다.`
  : '지울 템플릿 파일이 없습니다. 이미 깨끗합니다.')

export const STACK_UPDATED_NOTICE = '스택이 최신 템플릿으로 업데이트되었습니다.'
