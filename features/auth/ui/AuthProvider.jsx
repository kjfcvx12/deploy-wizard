import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import {
  clearSession, getSessionStatus, getSessionUser, markBooted, refreshSession, setRefresher, setSession, subscribeSession,
} from '@shared/ui/session.js'
import { onUnauthorized } from '@shared/ui/api.js'
import { authApi } from './api.js'
import { CONFIG_OFF, normalizeConfig, reloadFailureFlagsError, runBoot, runSignOut } from './authLogic.js'
import { clearUserScopedStorage, forgetSessionHint, hadSessionHint, rememberSessionHint } from './userData.js'

// 갱신 호출을 세션에 한 번 등록한다 (화면보다 먼저 - 401 재시도가 이것을 쓴다)
setRefresher(() => authApi.refresh())

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

// 로그인 상태를 앱 전체에 알린다 - 시작할 때 설정을 읽고 필요하면 조용히 세션을 되살린다
export function AuthProvider({ children }) {
  const [config, setConfigState] = useState(null)
  // 지금 아는 설정 - 다시 읽기가 실패했을 때 화면에 설정이 있는지 본다
  const configRef = useRef(null)
  // 설정을 상태와 ref 에 함께 반영한다
  const setConfig = useCallback((next) => {
    configRef.current = next
    setConfigState(next)
  }, [])
  // 설정을 못 읽었거나 시작 갱신이 연결 문제로 끝나 로그인 여부를 정하지 못한 상태
  const [configError, setConfigError] = useState(false)
  const [status, setStatus] = useState(getSessionStatus())
  const [user, setUser] = useState(getSessionUser())
  // 가장 최근 시작 번호 - 늦게 끝난 옛 시작이 상태를 덮어쓰지 않게
  const bootSeq = useRef(0)
  // 가장 최근 설정 읽기 번호 - 시작과 다시 읽기가 겹쳐도 가장 새 것만 반영한다
  const configSeq = useRef(0)

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
      refresh: refreshSession,
      getStatus: getSessionStatus,
      markBooted,
      hasHint: hadSessionHint,
      clearHint: forgetSessionHint,
      live,
      // 더 새로 읽은 설정이 있으면 덮어쓰지 않는다
      onConfig: (loaded) => { if (configAt === configSeq.current) setConfig(loaded) },
    })
    if (result.error && live()) setConfigError(true)
  }, [setConfig])

  // 설정을 다시 읽는다 (서버가 도중에 켜졌거나 꺼졌을 수 있다) - 실패하면 지금 설정을 둔다
  const reloadConfig = useCallback(async () => {
    configSeq.current += 1
    const configAt = configSeq.current
    try {
      const loaded = await loadConfig()
      if (configAt === configSeq.current) setConfig(loaded)
    } catch {
      // 연결이 안 되면 지금 알고 있는 설정으로 계속한다 - 아직 아는 설정이 없으면(시작의 읽기를 이 읽기가 밀어냈다) 오류로 보여 다시 시도할 수 있게 한다
      if (reloadFailureFlagsError({ config: configRef.current, latest: configAt === configSeq.current })) setConfigError(true)
    }
  }, [setConfig])

  useEffect(() => {
    const unsubscribe = subscribeSession((state) => {
      setStatus(state.status)
      setUser(state.user ?? null)
      // 로그인이 되면 이전의 연결 오류 표시는 더 이상 맞지 않는다
      if (state.status === 'signed_in') setConfigError(false)
      // 로그인 만료를 받으면 설정을 다시 읽는다
      if (state.status === 'signed_out' && state.reason === 'expired') reloadConfig()
    })
    // 로그인한 적 없는 탭이 401 을 받으면(서버가 로그인 필수로 바뀐 듯) 설정을 다시 읽는다 - 약속을 돌려줘 끝날 때까지 다시 부르지 않게 한다
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

  // Google 로그인 결과(id_token)를 서버에 보내 세션을 만든다 - 실패는 그대로 던진다 (화면이 문구를 보인다)
  const signInWithCredential = useCallback(async (id_token) => {
    const token = await authApi.loginGoogle(id_token)
    setSession(token)
    rememberSessionHint()
    return token?.user ?? null
  }, [])

  // 로그아웃 - 서버 호출이 실패해도 이 브라우저에서는 끝내고, 서버에서 못 끝냈는지({ serverLoggedOut: false })를 돌려준다
  const signOut = useCallback(() => runSignOut({
    logout: () => authApi.logout(),
    clearSession: () => clearSession('logout'),
    clearStorage: () => clearUserScopedStorage(),
  }), [])

  // 계정 삭제가 끝난 뒤 이 브라우저에 남은 것을 지운다
  const forgetAfterDelete = useCallback(() => {
    clearSession('deleted')
    clearUserScopedStorage()
  }, [])

  const value = useMemo(() => ({
    config, configError, status, user, retryConfig: boot, signInWithCredential, signOut, forgetAfterDelete,
  }), [config, configError, status, user, boot, signInWithCredential, signOut, forgetAfterDelete])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// 로그인 상태를 읽는다
export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth 는 AuthProvider 안에서만 쓸 수 있습니다')
  return value
}
