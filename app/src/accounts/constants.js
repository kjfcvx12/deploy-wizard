// 계정 연결 화면의 고정 글자 - 웹 features/accounts/ui/AccountsPage.jsx 와 같은 글
export const AWS_STATUS_LABEL = { pending: '역할 등록 대기', verified: '연결됨', invalid: '확인 실패' }
export const GITHUB_STATUS_LABEL = { active: '연결됨', suspended: '일시 중지', revoked: '끊김' }

export const DELETE_TEXT = {
  block: {
    title: '이 연결 블록을 삭제할까요?',
    body: '이 블록의 AWS 계정 연결이 함께 지워지고, 이 블록으로 배포한 것들의 연결이 끊깁니다. 다른 블록이 같이 쓰는 AWS 계정은 남습니다. GitHub 연결은 다른 블록이 쓸 수 있어 남겨 둡니다. AWS 스택과 GitHub 앱 설치 자체는 지워지지 않습니다 — 그건 각자의 콘솔에서 직접 끊으세요.',
  },
  aws: {
    title: 'AWS 계정 연결을 해제할까요?',
    body: '이 AWS 계정으로 배포한 것들의 연결이 끊깁니다. 블록은 남고 AWS를 다시 연결할 수 있습니다. AWS 스택 자체는 지워지지 않습니다 — 콘솔에서 직접 지우세요.',
  },
}

// 올렸던 템플릿 파일 삭제 확인 - 웹 AccountsPage 의 cleanupDialog 두 문단을 한 본문으로 잇는다
export const CLEANUP_TEXT = {
  title: '올렸던 템플릿 파일을 지울까요?',
  body: '스택을 만들 때 콘솔에 올린 deploy_wizard_role.yaml이 내 AWS 계정의 S3에 남아 있습니다. 그 파일만 지웁니다. 버킷과 다른 파일은 건드리지 않습니다.\n\n지워도 다시 등록할 필요는 없습니다. 이 파일은 올릴 때 쓴 사본일 뿐이고, 스택은 템플릿 내용을 따로 보관하고 있어 연결이 그대로 유지됩니다. 나중에 스택을 업데이트할 때는 최신 템플릿을 새로 올리면 됩니다.',
}

// 바깥 주소는 https:// 로 시작하는 것만 연다 (대소문자 무시, 앞뒤 공백·가운데 공백이나 호스트 없는 주소는 거절)
export const isHttps = (url) => typeof url === 'string' && /^https:\/\/\S+$/i.test(url)
