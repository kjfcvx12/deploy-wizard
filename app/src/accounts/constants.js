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

// 바깥 주소는 https:// 로 시작하는 것만 연다 (대소문자 무시, 앞뒤 공백이나 호스트 없는 주소는 거절)
export const isHttps = (url) => typeof url === 'string' && /^https:\/\/\S+/i.test(url)
