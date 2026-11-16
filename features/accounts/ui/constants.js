// GitHub 설치 콜백이 화면 주소에 붙여 돌려보내는 결과 (?connected=…) - 서버 features/accounts/services.py 의 GH_CALLBACK_* 와 맞춘다
export const GITHUB_CALLBACK_OK = 'github'
export const GITHUB_CALLBACK_ERROR = 'github_error'
export const GITHUB_CALLBACK_TAKEN = 'github_taken'

// 연결이 안 됐을 때 보일 안내 (연결 성공은 서버에 다시 물어 확인한 결과를 보인다)
export const GITHUB_CALLBACK_ERROR_TEXT = {
  [GITHUB_CALLBACK_ERROR]: 'GitHub 연결에 실패했습니다. 다시 시도해 주세요',
  [GITHUB_CALLBACK_TAKEN]: '이 GitHub 설치는 이미 다른 사용자가 연결했습니다',
}
