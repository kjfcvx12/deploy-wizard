import {
  STEPS, STATUS_LABEL, PROGRESS, isProgress, repoName, showsEnvCard,
  ENV_KINDS, ENV_SECRET_KINDS, kindLabel, TIER_LABEL, CONFIDENCE_LABEL, NEED_LABEL,
  tierLabel, confidenceLabel, needLabel,
} from '../constants'

describe('deploys 상수', () => {
  test('needs_input 은 진행 중이 아니다', () => {
    expect(isProgress('needs_input')).toBe(false)
    expect(PROGRESS).not.toContain('needs_input')
  })

  test('진행 중 상태', () => {
    for (const s of ['queued', 'cloning', 'analyzing', 'generating', 'building', 'pushing', 'deploying', 'deleting']) {
      expect(isProgress(s)).toBe(true)
    }
    for (const s of ['running', 'failed', 'stopped', 'deleted']) expect(isProgress(s)).toBe(false)
  })

  test('STATUS_LABEL', () => {
    expect(STATUS_LABEL.needs_input).toBe('입력 필요')
    expect(STATUS_LABEL.running).toBe('정상')
    expect(Object.keys(STATUS_LABEL)).toHaveLength(13)
  })

  test('STEPS 는 클론부터 완료까지 7단계', () => {
    expect(STEPS.map((s) => s.key)).toEqual(['cloning', 'analyzing', 'generating', 'building', 'pushing', 'deploying', 'running'])
  })

  test('repoName', () => {
    expect(repoName('https://github.com/owner/repo')).toBe('owner/repo')
  })

  test('showsEnvCard', () => {
    expect(showsEnvCard('needs_input')).toBe(true)
    expect(showsEnvCard('running')).toBe(true)
    expect(showsEnvCard('queued')).toBe(false)
    expect(showsEnvCard('cloning')).toBe(false)
    expect(showsEnvCard('deleted')).toBe(false)
  })
})

describe('환경변수·분석 상수', () => {
  test('kind 라벨', () => {
    expect(ENV_KINDS.map((k) => k.key)).toEqual(['database', 'cache', 'external_api', 'secret', 'config'])
    expect(kindLabel('database')).toBe('데이터베이스 주소')
    expect(kindLabel('zzz')).toBe('알 수 없음')
  })

  test('시크릿 종류', () => {
    expect([...ENV_SECRET_KINDS].sort()).toEqual(['cache', 'database', 'external_api', 'secret'])
    expect(ENV_SECRET_KINDS.has('config')).toBe(false)
  })

  test('분석 라벨은 모르는 키를 그대로 돌려준다', () => {
    expect(TIER_LABEL.small).toBe('가벼움')
    expect(CONFIDENCE_LABEL.low).toBe('낮음')
    expect(NEED_LABEL.static_site).toBe('정적 사이트')
    expect(tierLabel('large')).toBe('무거움')
    expect(confidenceLabel('high')).toBe('높음')
    expect(needLabel('worker')).toBe('백그라운드 작업')
    expect(tierLabel('x')).toBe('x')
    expect(confidenceLabel('x')).toBe('x')
    expect(needLabel('x')).toBe('x')
  })
})
