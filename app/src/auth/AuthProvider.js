import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSegments } from 'expo-router'
import { authApi, onUnauthorized } from '../api'
import { forgetPushDevice, reRegisterIfGranted, unregister } from '../ops/push'
import { useOnForeground } from '../hooks/useOnForeground'
import { googleSignIn, googleSignOut } from './google'
import {
  CONFIG_OFF, UNSUPPORTED_PLATFORM_TEXT, afterLogoutPath, normalizeConfig, runBoot, runSignOut, shouldTryRefresh,
} from './logic'
import { loginPlatform } from './platform'
import {
  clearSession, getRefreshToken, getSessionStatus, getSessionUser, markBooted, refreshSession, setRefresher, setSession, subscribeSession,
} from './session'
import { clearRefreshToken } from './tokenStore'
import { clearUserScopedData } from './userData'

const LOGIN_FAILED_TEXT = '로그인하지 못했습니다. 잠시 뒤 다시 시도해 주세요'

// 갱신 함수를 세션에 등록한다 - 원문은 getRefreshToken() (보안 저장소 쓰기가 실패했으면 메모리의 것). 웹 번들은 쿠키라 본문이 없다
export function installRefresher() {
  setRefresher(async () => authApi.refresh(await getRefreshToken()))
}

// 화면보다 먼저 한 번 등록한다 - 자식 화면의 effect 가 부모보다 먼저 돌아 첫 401 재시도가 이것을 쓴다
installRefresher()

const AuthContext = createContext(null)

// 서버 설정을 읽는다 - 옛 서버(404)는 "로그인 끔", 그 밖의 실패는 던진다
async function loadConfig() {
  try {
    return normalizeConfig(await authApi.getConfig())
  } catch (e) {
    if (e?.status === 404) return CONFIG_OFF
    throw e
  }
}

// 로그인 상태를 앱 전체에 알린다 - 시작할 때 설정을 읽고 필요하면 저장된 리프레시로 조용히 세션을 되살린다
export function AuthProvider({ children }) {
  const router = useRouter()
  const segments = useSegments()
  const [config, setConfig] = useState(null)
  // 설정을 못 읽었거나 시작 갱신이 연결 문제로 끝나 로그인 여부를 정하지 못한 상태
  const [configError, setConfigError] = useState(false)
  const [status, setStatus] = useState(getSessionStatus())
  const [user, setUser] = useState(getSessionUser())
  // 가장 최근 시작 번호 - 늦게 끝난 옛 시작이 상태를 덮어쓰지 않게
  const bootSeq = useRef(0)
  // 가장 최근 설정 읽기 번호 - 시작과 다시 읽기가 겹쳐도 가장 새 것만 반영한다
  const configSeq = useRef(0)
  // 진행 중인 로그인 하나 - 연타해도 Google 창과 서버 호출은 한 번
  const signingIn = useRef(null)
  // 콜백 안에서 쓰는 최신 값
  const latest = useRef({})
  latest.current = { config, router, segments }

  // 설정 읽기 → (필요하면) 갱신 → 첫 확인 끝내기. 다시 시도도 이 함수
  const boot = useCallback(async () => {
    bootSeq.current += 1
    const seq = bootSeq.current
    const live = () => seq === bootSeq.current
    configSeq.current += 1
    const configAt = configSeq.current
    setConfigError(false)

    const result = await runBoot({
      getConfig: () => authApi.getConfig(),
      canRefresh: async (loaded) => shouldTryRefresh({ platform: loginPlatform(), config: loaded, hasStoredRefresh: Boolean(await getRefreshToken()) }),
      refresh: refreshSession,
      getStatus: getSessionStatus,
      markBooted,
      clearStored: clearRefreshToken,
      live,
      // 더 새로 읽은 설정이 있으면 덮어쓰지 않는다
      onConfig: (loaded) => { if (configAt === configSeq.current) setConfig(loaded) },
    })
    if (result.error && live()) setConfigError(true)
  }, [])

  // 설정을 다시 읽는다 (서버가 도중에 켜졌거나 꺼졌을 수 있다) - 실패하면 지금 설정을 둔다
  const reloadConfig = useCallback(async () => {
    configSeq.current += 1
    const configAt = configSeq.current
    try {
      const loaded = await loadConfig()
      if (configAt === configSeq.current) setConfig(loaded)
    } catch {
      // 연결이 안 되면 지금 알고 있는 설정으로 계속한다
    }
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeSession((state) => {
      setStatus(state.status)
      setUser(state.user ?? null)
      // 로그인이 되면 이전의 연결 오류 표시는 더 이상 맞지 않는다
      if (state.status === 'signed_in') setConfigError(false)
      // 로그인 만료를 받으면 설정을 다시 읽는다
      if (state.status === 'signed_out' && state.reason === 'expired') reloadConfig()
    })
    // 로그인한 적 없는 상태에서 401 을 받으면(서버가 로그인 필수로 바뀐 듯) 설정을 다시 읽는다 - 약속을 돌려줘 끝날 때까지 다시 부르지 않게 한다
    const unsubscribeUnauthorized = onUnauthorized(() => reloadConfig())
    // 구독하기 전에 바뀐 상태를 따라잡는다
    setStatus(getSessionStatus())
    setUser(getSessionUser())
    boot()
    return () => {
      unsubscribe()
      unsubscribeUnauthorized()
      // 이 시작·설정 읽기가 끝나도 상태를 건드리지 않게 한다
      bootSeq.current += 1
      configSeq.current += 1
    }
  }, [boot, reloadConfig])

  // 앱이 다시 앞으로 오면 - 로그인 상태면 아무것도 하지 않고(401 은 요청이 알아서 갱신한다), 연결 오류로 멈춰 있으면 다시 시도한다
  useOnForeground(() => {
    if (getSessionStatus() === 'signed_in') return
    if (configError) boot()
  })

  // 실제 로그인 - id_token 을 받아(네이티브는 Google 창, 웹 번들은 GIS 버튼이 준 것) 서버에 보내고 세션을 둔다. 'signed_in' | 'cancelled', 실패는 던진다
  const runSignIn = useCallback(async (webIdToken) => {
    const platform = loginPlatform()
    if (!platform) throw new Error(UNSUPPORTED_PLATFORM_TEXT)
    let idToken = typeof webIdToken === 'string' && webIdToken ? webIdToken : null
    if (!idToken) {
      const picked = await googleSignIn({ webClientId: latest.current.config?.google_client_id_web ?? null })
      if (picked?.cancelled) return 'cancelled'
      idToken = picked?.idToken
    }
    const token = await authApi.loginGoogle(idToken, platform)
    await setSession(token)
    if (getSessionStatus() !== 'signed_in') throw new Error(LOGIN_FAILED_TEXT)
    // 이 기기가 알림을 받고 있었으면 새 사용자로 다시 등록한다 - 실패해도 로그인은 성공이다 (권한 창은 띄우지 않는다)
    reRegisterIfGranted().catch(() => {})
    return 'signed_in'
  }, [])

  // 로그인 - 진행 중이면 같은 약속을 돌려준다 (두 번째 누름은 새 로그인을 만들지 않는다)
  const signIn = useCallback((webIdToken) => {
    if (!signingIn.current) signingIn.current = runSignIn(webIdToken).finally(() => { signingIn.current = null })
    return signingIn.current
  }, [runSignIn])

  // 로그아웃 - 기기 해제(토큰이 살아 있을 때) → 서버 로그아웃 → 세션 → 사용자 저장값 → Google → 로그인(끔 모드는 처음) 화면. { serverLoggedOut }
  const signOut = useCallback(async () => {
    const result = await runSignOut({
      unregisterPush: unregister,
      // 세션을 지우기 전에 읽는다 (clearSession 은 메모리의 원문도 바로 지운다)
      readRefresh: getRefreshToken,
      logout: (refresh) => authApi.logout(refresh),
      clearSession: () => clearSession('logout'),
      clearUserData: clearUserScopedData,
      googleSignOut,
    })
    const { config: current, router: nav, segments: here } = latest.current
    const target = afterLogoutPath(current)
    // 경로 보호가 이미 로그인 화면으로 보냈으면 한 번 더 보내지 않는다
    const already = target === '/login' ? here?.[0] === 'login' : !here?.length
    if (!already) {
      try {
        nav.replace(target)
      } catch {
        // 아직 화면 이동을 받을 수 없는 순간 - 경로 보호가 처리한다
      }
    }
    return result
  }, [])

  // 계정 삭제가 끝난 뒤 이 기기에 남은 것을 지운다 - 서버가 기기 행을 이미 지웠으니 기기 번호는 저장값만 지운다
  const forgetAfterDelete = useCallback(async () => {
    await clearSession('deleted')
    await forgetPushDevice()
    await clearUserScopedData()
    await googleSignOut()
  }, [])

  const value = useMemo(() => ({
    config, configError, status, user, retryConfig: boot, signIn, signOut, forgetAfterDelete,
  }), [config, configError, status, user, boot, signIn, signOut, forgetAfterDelete])

  return createElement(AuthContext.Provider, { value }, children)
}

// 로그인 상태를 읽는다
export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth 는 AuthProvider 안에서만 쓸 수 있습니다')
  return value
}
