import { AWS_STATUS_LABEL, GITHUB_STATUS_LABEL, DELETE_TEXT, isHttps } from '../accounts/constants'
import { githubCheckNotice, awsVerifiedNotice, cleanupNotice, STACK_UPDATED_NOTICE } from '../accounts/notices'

describe('상태 글자와 삭제 안내 (웹 AccountsPage.jsx 와 같은 글)', () => {
  test('AWS 상태 글자', () => {
    expect(AWS_STATUS_LABEL).toEqual({ pending: '역할 등록 대기', verified: '연결됨', invalid: '확인 실패' })
  })

  test('GitHub 상태 글자', () => {
    expect(GITHUB_STATUS_LABEL).toEqual({ active: '연결됨', suspended: '일시 중지', revoked: '끊김' })
  })

  test('DELETE_TEXT.block', () => {
    expect(DELETE_TEXT.block).toEqual({
      title: '이 연결 블록을 삭제할까요?',
      body: '이 블록의 AWS 계정 연결이 함께 지워지고, 이 블록으로 배포한 것들의 연결이 끊깁니다. 다른 블록이 같이 쓰는 AWS 계정은 남습니다. GitHub 연결은 다른 블록이 쓸 수 있어 남겨 둡니다. AWS 스택과 GitHub 앱 설치 자체는 지워지지 않습니다 — 그건 각자의 콘솔에서 직접 끊으세요.',
    })
  })

  test('DELETE_TEXT.aws', () => {
    expect(DELETE_TEXT.aws).toEqual({
      title: 'AWS 계정 연결을 해제할까요?',
      body: '이 AWS 계정으로 배포한 것들의 연결이 끊깁니다. 블록은 남고 AWS를 다시 연결할 수 있습니다. AWS 스택 자체는 지워지지 않습니다 — 콘솔에서 직접 지우세요.',
    })
  })
})

describe('isHttps', () => {
  test.each([
    ['https://github.com/apps/x/installations/new', true],
    ['HTTPS://example.com', true],
    ['Https://example.com/a?b=1', true],
    ['http://example.com', false],
    ['javascript:alert(1)', false],
    ['data:text/html,x', false],
    ['ftp://example.com', false],
    ['//example.com', false],
    ['https:/example.com', false],
    ['https://', false],
    ['https://a b', false],
    ['https://a\nb', false],
    ['https://example.com/a b', false],
    ['https://example.com/a?b=1&c=2#frag', true],
    [' https://example.com', false],
    ['xhttps://example.com', false],
    ['', false],
    [null, false],
    [undefined, false],
    [42, false],
  ])('%j -> %s', (url, expected) => {
    expect(isHttps(url)).toBe(expected)
  })
})

describe('알림 문장 (웹과 같은 글)', () => {
  test('GitHub 확인 - 저장소 이름이 보일 때', () => {
    expect(githubCheckNotice({ account_login: 'octo', repository_count: 2, repositories: ['a', 'b'] }))
      .toBe('GitHub 연결 확인됨 — octo · 레포 2개에 접근할 수 있습니다 (a, b)')
  })

  test('GitHub 확인 - 보인 것보다 많으면 외', () => {
    expect(githubCheckNotice({ account_login: 'octo', repository_count: 30, repositories: ['a', 'b'] }))
      .toBe('GitHub 연결 확인됨 — octo · 레포 30개에 접근할 수 있습니다 (a, b 외)')
  })

  test('GitHub 확인 - 저장소 0개', () => {
    expect(githubCheckNotice({ account_login: 'octo', repository_count: 0, repositories: [] }))
      .toBe('GitHub 연결 확인됨 — octo · 레포 0개에 접근할 수 있습니다')
  })

  test('AWS 확인됨', () => {
    expect(awsVerifiedNotice({ label: '회사', aws_account_id: '123456789012' }, { current_version: 4 }))
      .toBe('AWS 계정 연결 확인됨 — 회사 · 계정 123456789012 · 역할 위임과 템플릿(버전 4)을 확인했습니다')
  })

  test('템플릿 파일 정리 - 0개와 N개', () => {
    expect(cleanupNotice(0)).toBe('지울 템플릿 파일이 없습니다. 이미 깨끗합니다.')
    expect(cleanupNotice(3)).toBe('올렸던 템플릿 파일 3개를 삭제했습니다. 스택과 연결은 그대로라 다시 등록할 것은 없습니다.')
  })

  test('스택 업데이트 완료', () => {
    expect(STACK_UPDATED_NOTICE).toBe('스택이 최신 템플릿으로 업데이트되었습니다.')
  })
})
