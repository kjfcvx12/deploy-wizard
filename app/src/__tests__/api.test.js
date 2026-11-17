import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import {
  request, deployApi, envApi, adviceApi, accountApi, authApi,
  AUTH_NO_RETRY_PATHS, onUnauthorized, resetUnauthorizedForTest,
} from '../api'
import { getAccessToken, getSessionStatus, setSession, setRefresher, markBooted, resetSessionForTest } from '../auth/session'

const okResponse = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
})

beforeEach(() => {
  global.fetch = jest.fn()
  resetSessionForTest()
  resetUnauthorizedForTest()
  SecureStore.__reset()
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

describe('request: 로그인 토큰', () => {
  const unauthorized = () => okResponse({ detail: '로그인이 필요합니다' }, 401)

  test('no token no header: 끔 모드 요청은 지금과 같다 (Authorization·credentials 없음)', async () => {
    global.fetch.mockResolvedValue(okResponse({}))
    await request('/api/deploys', { method: 'POST', body: { a: 1 } })
    const [, init] = global.fetch.mock.calls[0]
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(init.credentials).toBeUndefined()
    expect(init).not.toHaveProperty('auth')
  })

  test('토큰이 있으면 Bearer, 호출자가 준 헤더는 합친다', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    global.fetch.mockResolvedValue(okResponse({}))
    await request('/api/deploys', { headers: { 'X-Test': '1' } })
    expect(global.fetch.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer A1', 'X-Test': '1' })
  })

  test('401 refresh retry once: 갱신 뒤 새 토큰으로 한 번만 다시 보낸다', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const refresher = jest.fn(async () => ({ access_token: 'A2', refresh_token: 'dwr_2' }))
    setRefresher(refresher)
    global.fetch.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(okResponse({ ok: 1 }))
    await expect(request('/api/deploys')).resolves.toEqual({ ok: 1 })
    expect(refresher).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer A2')
  })

  test('다시 보낸 것도 401 이면 그 오류를 던지고 더 갱신하지 않는다', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const refresher = jest.fn(async () => ({ access_token: 'A2', refresh_token: 'dwr_2' }))
    setRefresher(refresher)
    global.fetch.mockResolvedValue(unauthorized())
    await expect(request('/api/deploys')).rejects.toMatchObject({ status: 401, message: '로그인이 필요합니다' })
    expect(refresher).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  test('갱신이 거절되면 원래 401 을 던진다', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    setRefresher(async () => { throw Object.assign(new Error('만료'), { status: 401 }) })
    global.fetch.mockResolvedValue(unauthorized())
    await expect(request('/api/deploys')).rejects.toMatchObject({ status: 401, message: '로그인이 필요합니다' })
    expect(getSessionStatus()).toBe('signed_out')
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test('동시에 401 을 받은 다섯 요청은 갱신 한 번을 같이 기다렸다가 모두 다시 간다', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const refresher = jest.fn(async () => { await gate; return { access_token: 'A2', refresh_token: 'dwr_2' } })
    setRefresher(refresher)
    global.fetch.mockImplementation(async (url, init) => (init.headers.Authorization === 'Bearer A2' ? okResponse({ url }) : unauthorized()))
    const runs = [1, 2, 3, 4, 5].map((n) => request(`/api/deploys/${n}`))
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    const results = await Promise.all(runs)
    expect(results).toHaveLength(5)
    expect(refresher).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledTimes(10)
  })

  test('auth paths never refresh: 네 경로는 401 이어도 갱신·재시도하지 않는다', async () => {
    expect(AUTH_NO_RETRY_PATHS).toEqual(['/api/auth/google', '/api/auth/refresh', '/api/auth/logout', '/api/auth/config'])
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    const refresher = jest.fn(async () => ({ access_token: 'A2' }))
    setRefresher(refresher)
    global.fetch.mockResolvedValue(unauthorized())
    for (const path of AUTH_NO_RETRY_PATHS) {
      await expect(request(`${path}?x=1`, { method: 'POST' })).rejects.toMatchObject({ status: 401 })
    }
    expect(refresher).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledTimes(4)
  })

  test('오프라인에서 갱신이 실패하면 그 오류를 던지고 로그아웃하지 않는다', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    setRefresher(async () => { throw new Error('서버에 연결할 수 없습니다') })
    global.fetch.mockResolvedValue(unauthorized())
    await expect(request('/api/deploys')).rejects.toThrow('서버에 연결할 수 없습니다')
    expect(getSessionStatus()).toBe('signed_in')
    expect(getAccessToken()).toBe('A1')
    await expect(SecureStore.getItemAsync('dw-refresh')).resolves.toBe('dwr_1')
  })

  test('토큰 없이 signed_out 이면 갱신하지 않고 onUnauthorized 를 5초에 한 번 부른다', async () => {
    markBooted('signed_out')
    const refresher = jest.fn(async () => ({ access_token: 'A2' }))
    setRefresher(refresher)
    const handler = jest.fn()
    onUnauthorized(handler)
    global.fetch.mockResolvedValue(unauthorized())
    await expect(request('/api/deploys')).rejects.toMatchObject({ status: 401 })
    await expect(request('/api/deploys')).rejects.toMatchObject({ status: 401 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(refresher).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  test('auth:false 요청은 토큰을 붙이지 않는다', async () => {
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    global.fetch.mockResolvedValue(okResponse({}))
    await request('/api/auth/config', { auth: false })
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })
})

describe('authApi', () => {
  const lastCall = () => global.fetch.mock.calls[global.fetch.mock.calls.length - 1]
  beforeEach(() => global.fetch.mockResolvedValue(okResponse({})))

  test('web auth calls include credentials: 웹 번들의 /api/auth/ 호출은 쿠키를 싣고 갱신·로그아웃 본문이 없다', async () => {
    jest.replaceProperty(Platform, 'OS', 'web')
    await authApi.refresh('dwr_1')
    expect(lastCall()[0]).toBe('http://localhost:8081/api/auth/refresh')
    expect(lastCall()[1].credentials).toBe('include')
    expect(lastCall()[1].method).toBe('POST')
    expect(lastCall()[1].body).toBeUndefined()
    await authApi.logout(null)
    expect(lastCall()[0]).toBe('http://localhost:8081/api/auth/logout')
    expect(lastCall()[1].credentials).toBe('include')
    expect(lastCall()[1].body).toBeUndefined()
    await authApi.loginGoogle('idt', 'web')
    expect(lastCall()[1].credentials).toBe('include')
    await deployApi.getAll()
    expect(lastCall()[1].credentials).toBeUndefined()
  })

  test('native refresh sends body: 안드로이드는 본문으로 보내고 쿠키를 싣지 않는다', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    await authApi.refresh('dwr_1')
    expect(lastCall()[0]).toBe('http://localhost:8081/api/auth/refresh')
    expect(JSON.parse(lastCall()[1].body)).toEqual({ refresh_token: 'dwr_1' })
    expect(lastCall()[1].credentials).toBeUndefined()
    await authApi.logout('dwr_2')
    expect(lastCall()[0]).toBe('http://localhost:8081/api/auth/logout')
    expect(JSON.parse(lastCall()[1].body)).toEqual({ refresh_token: 'dwr_2' })
  })

  test('loginGoogle 은 id_token 과 platform 을 보내고 토큰을 붙이지 않는다', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    await setSession({ access_token: 'A1', refresh_token: 'dwr_1' })
    await authApi.loginGoogle('idt', 'android')
    expect(lastCall()[0]).toBe('http://localhost:8081/api/auth/google')
    expect(lastCall()[1].method).toBe('POST')
    expect(JSON.parse(lastCall()[1].body)).toEqual({ id_token: 'idt', platform: 'android' })
    expect(lastCall()[1].headers.Authorization).toBeUndefined()
  })

  test('getConfig·getMe·deleteMe', async () => {
    await authApi.getConfig()
    expect(lastCall()[0]).toBe('http://localhost:8081/api/auth/config')
    await authApi.getMe()
    expect(lastCall()[0]).toBe('http://localhost:8081/api/me')
    await authApi.deleteMe()
    expect(lastCall()[0]).toBe('http://localhost:8081/api/me')
    expect(lastCall()[1].method).toBe('DELETE')
    expect(JSON.parse(lastCall()[1].body)).toEqual({ confirm: true })
  })
})
