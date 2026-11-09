import { accountApi } from '../api'

const okResponse = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
})

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue(okResponse({}))
})

// 첫 호출의 [주소, 메서드, 본문]을 읽는다
const lastCall = () => {
  const [url, init] = global.fetch.mock.calls[0]
  return { url, method: init.method || 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) }
}

const BASE = 'http://localhost:8081/api/accounts'

describe('accountApi (features/accounts/ui/api.js 와 1:1)', () => {
  test.each([
    ['getConnections', [], '/connections', 'GET', undefined],
    ['createConnection', ['내 블록'], '/connections', 'POST', { label: '내 블록' }],
    ['createConnectionAws', [3], '/connections/3/aws', 'POST', undefined],
    ['setConnectionAws', [3, 7], '/connections/3', 'PATCH', { aws_account_id: 7 }],
    ['setConnectionGithub', [3, 9], '/connections/3', 'PATCH', { github_installation_id: 9 }],
    ['deleteConnection', [3], '/connections/3', 'DELETE', undefined],
    ['listAws', [], '/aws', 'GET', undefined],
    ['createAws', ['회사', 'ap-northeast-2'], '/aws', 'POST', { label: '회사', region: 'ap-northeast-2' }],
    ['createAws', ['회사', ''], '/aws', 'POST', { label: '회사', region: null }],
    ['attachRole', [5, 'arn:aws:iam::123456789012:role/dw'], '/aws/5/role-arn', 'PATCH', { role_arn: 'arn:aws:iam::123456789012:role/dw' }],
    ['reverifyAws', [5], '/aws/5/reverify', 'POST', undefined],
    ['getTemplateStatus', [5], '/aws/5/template-status', 'GET', undefined],
    ['deleteTemplateFiles', [5], '/aws/5/template-files', 'DELETE', undefined],
    ['deleteAws', [5], '/aws/5', 'DELETE', undefined],
    ['listGithub', [], '/github', 'GET', undefined],
    ['getGithubInstallUrl', [3], '/github/install-url?c_id=3', 'GET', undefined],
    ['getGithubInstallUrl', [], '/github/install-url', 'GET', undefined],
    ['getGithubRepositories', [9], '/github/9/repositories', 'GET', undefined],
    ['checkGithub', [9], '/github/9/check', 'GET', undefined],
    ['deleteGithub', [9], '/github/9', 'DELETE', undefined],
  ])('%s(%j)', async (name, args, path, method, body) => {
    await accountApi[name](...args)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const call = lastCall()
    expect(call.url).toBe(`${BASE}${path}`)
    expect(call.method).toBe(method)
    expect(call.body).toEqual(body)
  })

  test('서버가 준 응답을 그대로 돌려준다', async () => {
    global.fetch.mockResolvedValue(okResponse([{ c_id: 1 }]))
    await expect(accountApi.getConnections()).resolves.toEqual([{ c_id: 1 }])
  })

  test('204(삭제)는 null', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 204, json: async () => { throw new Error('no body') } })
    await expect(accountApi.deleteConnection(3)).resolves.toBeNull()
  })

  test('409 같은 서버 메시지를 그대로 던진다', async () => {
    global.fetch.mockResolvedValue(okResponse({ detail: '이미 AWS 계정이 연결되어 있습니다' }, 409))
    await expect(accountApi.createConnectionAws(3)).rejects.toThrow('이미 AWS 계정이 연결되어 있습니다')
  })
})
