import { request, deployApi, envApi, adviceApi, accountApi } from '../api'

const okResponse = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
})

beforeEach(() => {
  global.fetch = jest.fn()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('request', () => {
  test('성공하면 JSON을 돌려준다', async () => {
    global.fetch.mockResolvedValue(okResponse({ a: 1 }))
    await expect(request('/api/deploys')).resolves.toEqual({ a: 1 })
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe('http://localhost:8081/api/deploys')
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  test('204는 null', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 204, json: async () => { throw new Error('no body') } })
    await expect(request('/api/deploys/1', { method: 'DELETE' })).resolves.toBeNull()
  })

  test('detail 문자열을 그대로 던진다', async () => {
    global.fetch.mockResolvedValue(okResponse({ detail: '배포를 찾을 수 없습니다' }, 404))
    await expect(request('/x')).rejects.toThrow(new Error('배포를 찾을 수 없습니다'))
  })

  test('서버가 거절한 오류에는 status 가 붙고, 연결 실패에는 붙지 않는다', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ detail: '배포를 찾을 수 없습니다' }, 404))
    await expect(request('/x')).rejects.toMatchObject({ message: '배포를 찾을 수 없습니다', status: 404 })
    global.fetch.mockResolvedValueOnce(okResponse(null, 502))
    await expect(request('/x')).rejects.toMatchObject({ message: '요청 실패 (502)', status: 502 })
    global.fetch.mockRejectedValueOnce(new TypeError('Network request failed'))
    const failure = await request('/x').catch((e) => e)
    expect(failure.message).toBe('서버에 연결할 수 없습니다')
    expect(failure.status).toBeUndefined()
  })

  test('422 detail 배열은 msg를 ", "로 잇는다', async () => {
    global.fetch.mockResolvedValue(okResponse({ detail: [{ msg: '첫째' }, { msg: '둘째' }] }, 422))
    await expect(request('/x')).rejects.toThrow('첫째, 둘째')
  })

  test('2xx 인데 본문을 읽지 못하면(잘림·JSON 아님) 성공이 아니라 연결 실패', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input') } })
    await expect(request('/api/deploys')).rejects.toThrow(new Error('서버에 연결할 수 없습니다'))
  })

  test('본문을 읽는 중에 시간이 다 되면 연결 실패', async () => {
    jest.useFakeTimers()
    global.fetch.mockImplementation((url, init) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    }))
    const pending = request('/x')
    const assertion = expect(pending).rejects.toThrow(new Error('서버에 연결할 수 없습니다'))
    await jest.advanceTimersByTimeAsync(15000)
    await assertion
  })

  test('JSON이 아닌 오류는 요청 실패 (500)', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500, json: async () => { throw new SyntaxError('bad') } })
    await expect(request('/x')).rejects.toThrow('요청 실패 (500)')
  })

  test('detail이 없는 오류 본문도 요청 실패 (status)', async () => {
    global.fetch.mockResolvedValue(okResponse({}, 502))
    await expect(request('/x')).rejects.toThrow('요청 실패 (502)')
  })

  test('fetch가 거부되면 서버에 연결할 수 없습니다', async () => {
    global.fetch.mockRejectedValue(new TypeError('Network request failed'))
    await expect(request('/x')).rejects.toThrow('서버에 연결할 수 없습니다')
  })

  test('15초 안에 응답이 없으면 중단하고 같은 메시지', async () => {
    jest.useFakeTimers()
    global.fetch.mockImplementation((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const pending = request('/x')
    const assertion = expect(pending).rejects.toThrow('서버에 연결할 수 없습니다')
    await jest.advanceTimersByTimeAsync(15000)
    await assertion
  })

  test('body는 JSON 문자열로 보낸다', async () => {
    global.fetch.mockResolvedValue(okResponse({}))
    await request('/x', { method: 'POST', body: { a: 1 } })
    expect(global.fetch.mock.calls[0][1].body).toBe('{"a":1}')
    expect(global.fetch.mock.calls[0][1].method).toBe('POST')
  })
})

describe('deployApi', () => {
  beforeEach(() => global.fetch.mockResolvedValue(okResponse({})))
  const lastCall = () => global.fetch.mock.calls[global.fetch.mock.calls.length - 1]

  test('create: 빈 값은 null로 보낸다', async () => {
    await deployApi.create('https://github.com/a/b', '', undefined, 0)
    const [url, init] = lastCall()
    expect(url).toBe('http://localhost:8081/api/deploys')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      repo_url: 'https://github.com/a/b', branch: null, aws_account_id: null, github_installation_id: null,
    })
  })

  test('create: 값이 있으면 그대로 보낸다', async () => {
    await deployApi.create('https://github.com/a/b', 'dev', 3, 5)
    expect(JSON.parse(lastCall()[1].body)).toEqual({
      repo_url: 'https://github.com/a/b', branch: 'dev', aws_account_id: 3, github_installation_id: 5,
    })
  })

  test('getLogs: after 기본값 0', async () => {
    await deployApi.getLogs(7)
    expect(lastCall()[0]).toBe('http://localhost:8081/api/deploys/7/logs?after=0')
    await deployApi.getLogs(7, 12)
    expect(lastCall()[0]).toBe('http://localhost:8081/api/deploys/7/logs?after=12')
  })

  test('getRemote: 주소를 인코딩하고 설치 번호는 있을 때만 붙인다', async () => {
    await deployApi.getRemote('https://github.com/a/b')
    expect(lastCall()[0]).toBe('http://localhost:8081/api/deploys/remote?repo_url=https%3A%2F%2Fgithub.com%2Fa%2Fb')
    await deployApi.getRemote('https://github.com/a/b', 9)
    expect(lastCall()[0]).toContain('&github_installation_id=9')
  })

  test('redeploy/stop/start/remove 메서드와 경로', async () => {
    await deployApi.redeploy(1)
    expect(lastCall()[0]).toBe('http://localhost:8081/api/deploys/1/redeploy')
    expect(lastCall()[1].method).toBe('POST')
    await deployApi.stop(1)
    expect(lastCall()[0]).toMatch(/\/api\/deploys\/1\/stop$/)
    expect(lastCall()[1].method).toBe('POST')
    await deployApi.start(1)
    expect(lastCall()[0]).toMatch(/\/api\/deploys\/1\/start$/)
    expect(lastCall()[1].method).toBe('POST')
    await deployApi.remove(1)
    expect(lastCall()[0]).toBe('http://localhost:8081/api/deploys/1')
    expect(lastCall()[1].method).toBe('DELETE')
  })

  test('getAll/getOne/getIssues/getHealth 경로', async () => {
    await deployApi.getAll()
    expect(lastCall()[0]).toBe('http://localhost:8081/api/deploys')
    await deployApi.getOne(4)
    expect(lastCall()[0]).toBe('http://localhost:8081/api/deploys/4')
    await deployApi.getIssues(4)
    expect(lastCall()[0]).toBe('http://localhost:8081/api/deploys/4/issues')
    await deployApi.getHealth(4)
    expect(lastCall()[0]).toBe('http://localhost:8081/api/deploys/4/health')
  })
})

describe('envApi', () => {
  beforeEach(() => global.fetch.mockResolvedValue(okResponse({})))
  const lastCall = () => global.fetch.mock.calls[global.fetch.mock.calls.length - 1]

  test('put: 이름을 URL 인코딩한다', async () => {
    await envApi.put(7, 'A/B C', { value: 'x' })
    const [url, init] = lastCall()
    expect(url).toBe('http://localhost:8081/api/deploys/7/env/A%2FB%20C')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ value: 'x' })
  })

  test('clearValue: 인코딩 + DELETE', async () => {
    await envApi.clearValue(7, 'A/B')
    const [url, init] = lastCall()
    expect(url).toBe('http://localhost:8081/api/deploys/7/env/A%2FB/value')
    expect(init.method).toBe('DELETE')
  })

  test('getAll / continueDeploy', async () => {
    await envApi.getAll(7)
    expect(lastCall()[0]).toBe('http://localhost:8081/api/deploys/7/env')
    await envApi.continueDeploy(7)
    expect(lastCall()[0]).toBe('http://localhost:8081/api/deploys/7/env/continue')
    expect(lastCall()[1].method).toBe('POST')
  })
})

describe('adviceApi', () => {
  test('analyze: /api/deploys/advice 로 보내고 빈 값은 null', async () => {
    global.fetch.mockResolvedValue(okResponse({}))
    await adviceApi.analyze({ repo_url: 'https://github.com/a/b', branch: '', aws_account_id: null })
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe('http://localhost:8081/api/deploys/advice')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      repo_url: 'https://github.com/a/b', branch: null, aws_account_id: null, github_installation_id: null,
    })
  })

  test('analyze: 값이 있으면 그대로', async () => {
    global.fetch.mockResolvedValue(okResponse({}))
    await adviceApi.analyze({ repo_url: 'u', branch: 'dev', aws_account_id: 2, github_installation_id: 4 })
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
      repo_url: 'u', branch: 'dev', aws_account_id: 2, github_installation_id: 4,
    })
  })
})

describe('accountApi (읽기 전용)', () => {
  test('경로', async () => {
    global.fetch.mockResolvedValue(okResponse([]))
    await accountApi.getConnections()
    expect(global.fetch.mock.calls[0][0]).toBe('http://localhost:8081/api/accounts/connections')
    await accountApi.getGithubRepositories(3)
    expect(global.fetch.mock.calls[1][0]).toBe('http://localhost:8081/api/accounts/github/3/repositories')
  })
})
