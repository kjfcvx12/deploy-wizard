import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin'
import { googleSignIn, googleSignOut, Google_Sign_In_Error } from '../auth/google'

const DEV_BUILD_TEXT = '개발 빌드에서만 Google 로그인을 할 수 있습니다 (Expo Go 는 지원하지 않습니다)'
const NO_PLAY_TEXT = '이 기기에서 Google Play 서비스를 쓸 수 없습니다'
const GENERIC_TEXT = 'Google 로그인을 하지 못했습니다. 잠시 뒤 다시 시도해 주세요'
const NOT_CONFIGURED_TEXT = 'Google 로그인이 아직 설정되지 않았습니다 (서버의 GOOGLE_CLIENT_ID_WEB)'

// 라이브러리가 던지는 오류 모양 (code 가 붙은 Error)
const codedError = (code, message = 'raw library message') => Object.assign(new Error(message), { code })

beforeEach(() => {
  jest.clearAllMocks()
  GoogleSignin.hasPlayServices.mockResolvedValue(true)
  GoogleSignin.signIn.mockResolvedValue({ type: 'success', data: { idToken: 'idt', user: { email: 'a@b.c' } } })
  GoogleSignin.signOut.mockResolvedValue(null)
})

describe('googleSignIn (native)', () => {
  it('returns idToken - configure gets only webClientId', async () => {
    const result = await googleSignIn({ webClientId: 'web-client.apps.googleusercontent.com' })
    expect(result).toEqual({ idToken: 'idt' })
    expect(GoogleSignin.configure).toHaveBeenCalledWith({ webClientId: 'web-client.apps.googleusercontent.com' })
    expect(GoogleSignin.hasPlayServices).toHaveBeenCalledTimes(1)
    expect(GoogleSignin.signIn).toHaveBeenCalledTimes(1)
  })

  it('cancel response -> cancelled', async () => {
    GoogleSignin.signIn.mockResolvedValue({ type: 'cancelled', data: null })
    await expect(googleSignIn({ webClientId: 'w' })).resolves.toEqual({ cancelled: true })
  })

  it('cancel thrown with SIGN_IN_CANCELLED code -> cancelled', async () => {
    GoogleSignin.signIn.mockRejectedValue(codedError(statusCodes.SIGN_IN_CANCELLED))
    await expect(googleSignIn({ webClientId: 'w' })).resolves.toEqual({ cancelled: true })
  })

  it('no play services (rejected) -> Korean', async () => {
    GoogleSignin.hasPlayServices.mockRejectedValue(codedError(statusCodes.PLAY_SERVICES_NOT_AVAILABLE))
    const error = await googleSignIn({ webClientId: 'w' }).catch((e) => e)
    expect(error).toBeInstanceOf(Google_Sign_In_Error)
    expect(error.message).toBe(NO_PLAY_TEXT)
    expect(GoogleSignin.signIn).not.toHaveBeenCalled()
  })

  it('no play services (false) -> Korean', async () => {
    GoogleSignin.hasPlayServices.mockResolvedValue(false)
    await expect(googleSignIn({ webClientId: 'w' })).rejects.toThrow(NO_PLAY_TEXT)
  })

  it('unknown error -> generic Korean, no raw text', async () => {
    GoogleSignin.signIn.mockRejectedValue(new Error('SECRET raw idt'))
    const error = await googleSignIn({ webClientId: 'w' }).catch((e) => e)
    expect(error).toBeInstanceOf(Google_Sign_In_Error)
    expect(error.message).toBe(GENERIC_TEXT)
    expect(error.message).not.toMatch(/SECRET|idt/)
    expect(String(error.cause ?? '')).not.toMatch(/SECRET|idt/)
  })

  it('success without idToken -> generic Korean', async () => {
    GoogleSignin.signIn.mockResolvedValue({ type: 'success', data: { idToken: null } })
    await expect(googleSignIn({ webClientId: 'w' })).rejects.toThrow(GENERIC_TEXT)
  })

  it('missing or empty webClientId -> not configured, library untouched', async () => {
    await expect(googleSignIn({ webClientId: '' })).rejects.toThrow(NOT_CONFIGURED_TEXT)
    await expect(googleSignIn({})).rejects.toThrow(NOT_CONFIGURED_TEXT)
    await expect(googleSignIn()).rejects.toThrow(NOT_CONFIGURED_TEXT)
    expect(GoogleSignin.configure).not.toHaveBeenCalled()
  })

  it('does not log the id token or raw error', async () => {
    const spies = ['log', 'warn', 'error', 'info'].map((name) => jest.spyOn(console, name).mockImplementation(() => {}))
    GoogleSignin.signIn.mockRejectedValue(new Error('SECRET raw idt'))
    await googleSignIn({ webClientId: 'w' }).catch(() => {})
    GoogleSignin.signIn.mockResolvedValue({ type: 'success', data: { idToken: 'idt' } })
    await googleSignIn({ webClientId: 'w' })
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled())
    spies.forEach((spy) => spy.mockRestore())
  })
})

describe('googleSignOut (native)', () => {
  it('calls the library signOut', async () => {
    await googleSignOut()
    expect(GoogleSignin.signOut).toHaveBeenCalledTimes(1)
  })

  it('never throws', async () => {
    GoogleSignin.signOut.mockRejectedValue(new Error('boom'))
    await expect(googleSignOut()).resolves.toBeUndefined()
  })
})

describe('native module missing (Expo Go)', () => {
  // 네이티브 모듈이 없는 환경을 흉내 낸다 - 라이브러리를 가져오는 순간 던진다
  const loadWithoutNative = () => {
    jest.resetModules()
    jest.doMock('@react-native-google-signin/google-signin', () => { throw new Error('TurboModuleRegistry: RNGoogleSignin could not be found') })
    return require('../auth/google')
  }

  afterEach(() => {
    jest.dontMock('@react-native-google-signin/google-signin')
    jest.resetModules()
  })

  it('signIn -> dev build message', async () => {
    const { googleSignIn: signIn } = loadWithoutNative()
    const error = await signIn({ webClientId: 'w' }).catch((e) => e)
    expect(error.name).toBe('Google_Sign_In_Error')
    expect(error.message).toBe(DEV_BUILD_TEXT)
  })

  it('signOut -> resolves, never throws', async () => {
    const { googleSignOut: signOut } = loadWithoutNative()
    await expect(signOut()).resolves.toBeUndefined()
  })
})
