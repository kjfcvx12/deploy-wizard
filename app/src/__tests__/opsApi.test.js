import { incidentApi, healthApi, notificationApi, deviceApi, deployApi } from '../api'

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

const BASE = 'http://localhost:8081/api'

describe('incidentApi (features/incidents/router.py 와 1:1)', () => {
  test.each([
    ['getAll', [], '/incidents', 'GET', undefined],
    ['getAll', [{}], '/incidents', 'GET', undefined],
    ['getAll', [{ status: 'needs_action' }], '/incidents?status=needs_action', 'GET', undefined],
    ['getAll', [{ d_id: 2 }], '/incidents?d_id=2', 'GET', undefined],
    ['getAll', [{ after: 40 }], '/incidents?after=40', 'GET', undefined],
    ['getAll', [{ status: 'open', d_id: 2, after: 40 }], '/incidents?status=open&d_id=2&after=40', 'GET', undefined],
    ['getAll', [{ status: null, d_id: undefined, after: '' }], '/incidents', 'GET', undefined],
    ['getAll', [{ status: 'a b&c' }], '/incidents?status=a%20b%26c', 'GET', undefined],
    ['getOne', [7], '/incidents/7', 'GET', undefined],
    ['getForDeploy', [2], '/deploys/2/incidents', 'GET', undefined],
    ['getForDeploy', [2, 30], '/deploys/2/incidents?after=30', 'GET', undefined],
  ])('%s(%j)', async (name, args, path, method, body) => {
    await incidentApi[name](...args)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(lastCall()).toEqual({ url: BASE + path, method, body })
  })
})

describe('healthApi', () => {
  test('getHistory 는 시간 수를 쿼리로 보낸다', async () => {
    await healthApi.getHistory(2, 24)
    expect(lastCall()).toEqual({ url: `${BASE}/deploys/2/health-history?hours=24`, method: 'GET', body: undefined })
  })

  test('hours 를 생략하면 24시간', async () => {
    await healthApi.getHistory(2)
    expect(lastCall().url).toBe(`${BASE}/deploys/2/health-history?hours=24`)
  })
})

describe('notificationApi (features/notifications/router.py 와 1:1)', () => {
  test.each([
    ['getAll', [], '/notifications', 'GET', undefined],
    ['getAll', [{}], '/notifications', 'GET', undefined],
    ['getAll', [{ after: 31 }], '/notifications?after=31', 'GET', undefined],
    ['getAll', [{ unread: true }], '/notifications?unread=true', 'GET', undefined],
    ['getAll', [{ unread: false }], '/notifications', 'GET', undefined],
    ['getAll', [{ after: 31, unread: true }], '/notifications?after=31&unread=true', 'GET', undefined],
    ['getAll', [{ after: null, unread: undefined }], '/notifications', 'GET', undefined],
    ['getUnreadCount', [], '/notifications/unread-count', 'GET', undefined],
    ['read', [31], '/notifications/31/read', 'POST', undefined],
    ['readAll', [], '/notifications/read-all', 'POST', undefined],
    ['getSettings', [], '/notifications/settings', 'GET', undefined],
    ['patchSettings', [{ notify_push: false }], '/notifications/settings', 'PATCH', { notify_push: false }],
    ['patchSettings', [{ notify_email: true, kinds: ['deploy_failed'] }], '/notifications/settings', 'PATCH', { notify_email: true, kinds: ['deploy_failed'] }],
  ])('%s(%j)', async (name, args, path, method, body) => {
    await notificationApi[name](...args)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(lastCall()).toEqual({ url: BASE + path, method, body })
  })
})

describe('deviceApi', () => {
  test('register 는 expo_token 과 platform 만 보낸다', async () => {
    await deviceApi.register({ expo_token: 'ExponentPushToken[abc]', platform: 'ios', extra: 'x' })
    expect(lastCall()).toEqual({
      url: `${BASE}/devices`,
      method: 'POST',
      body: { expo_token: 'ExponentPushToken[abc]', platform: 'ios' },
    })
  })

  test('remove 는 DELETE', async () => {
    await deviceApi.remove(4)
    expect(lastCall()).toEqual({ url: `${BASE}/devices/4`, method: 'DELETE', body: undefined })
  })
})

describe('deployApi.patchSettings', () => {
  test('PATCH /deploys/{d_id}/settings 에 보낸 항목만 싣는다', async () => {
    await deployApi.patchSettings(2, { auto_recover: false })
    expect(lastCall()).toEqual({ url: `${BASE}/deploys/2/settings`, method: 'PATCH', body: { auto_recover: false } })
  })
})

describe('에러는 서버 detail 을 그대로 던진다', () => {
  test('404 detail', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse({ detail: '해당 id의 인시던트가 없습니다' }, 404))
    await expect(incidentApi.getOne(99)).rejects.toThrow('해당 id의 인시던트가 없습니다')
  })
})
