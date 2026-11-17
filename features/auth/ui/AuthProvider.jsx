import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import {
  clearSession, getSessionStatus, getSessionUser, markBooted, refreshSession, setRefresher, setSession, subscribeSession,
} from '@shared/ui/session.js'
import { authApi } from './api.js'
import { CONFIG_OFF, normalizeConfig } from './authLogic.js'
import { clearUserScopedStorage, hadSessionHint, rememberSessionHint } from './userData.js'

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
  const [config, setConfig] = useState(null)
  // 설정을 못 읽었거나 시작 갱신이 연결 문제로 끝나 로그인 여부를 정하지 못한 상태
  const [configError, setConfigError] = useState(false)
  const [status, setStatus] = useState(getSessionStatus())
  const [user, setUser] = useState(getSessionUser())
  // 가장 최근 시작 번호 - 늦게 끝난 옛 시작이 상태를 덮어쓰지 않게
  const bootSeq = useRef(0)

  // 설정 읽기 → (필요하면) 갱신 → 첫 확인 끝내기. 다시 시도도 이 함수
  const boot = useCallback(async () => {
    bootSeq.current += 1
    const seq = bootSeq.current
    const live = () => seq === bootSeq.current
    setConfigError(false)

    let loaded
    try {
      loaded = await loadConfig()
    } catch {
      if (live()) setConfigError(true)
      return
    }
    if (!live()) return
    setConfig(loaded)

    // 다른 탭의 로그인 등으로 이미 정해졌으면 더 하지 않는다
    if (getSessionStatus() !== 'unknown') return
    // 로그인이 필요 없고 로그인한 적도 없으면 갱신하지 않는다 (끔 모드에서 쓸데없는 호출 방지)
    if (!loaded.auth_required && !hadSessionHint()) {
      markBooted('signed_out')
      return
    }
    try {
      await refreshSession()
    } catch {
      // 연결 실패·서버 오류는 "로그아웃"이 아니다 - 로그인 여부를 정하지 않고 다시 시도하게 한다
      if (live()) setConfigError(true)
      return
    }
    if (!live()) return
    // 갱신이 성공했거나 서버가 쿠키를 거절한 확실한 결과일 때만 첫 확인을 끝낸다
    markBooted(getSessionStatus())
  }, [])

  // 로그인 만료를 받으면 설정을 다시 읽는다 (서버가 도중에 켜졌거나 꺼졌을 수 있다) - 실패하면 지금 설정을 둔다
  const reloadConfig = useCallback(async () => {
    try {
      setConfig(await loadConfig())
    } catch {
      // 연결이 안 되면 지금 알고 있는 설정으로 계속한다
    }
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeSession((state) => {
      setStatus(state.status)
      setUser(state.user ?? null)
      if (state.status === 'signed_out' && state.reason === 'expired') reloadConfig()
    })
    // 구독하기 전에 바뀐 상태를 따라잡는다
    setStatus(getSessionStatus())
    setUser(getSessionUser())
    boot()
    return () => {
      unsubscribe()
      // 이 시작이 끝나도 상태를 건드리지 않게 한다
      bootSeq.current += 1
    }
  }, [boot, reloadConfig])

  // Google 로그인 결과(id_token)를 서버에 보내 세션을 만든다 - 실패는 그대로 던진다 (화면이 문구를 보인다)
  const signInWithCredential = useCallback(async (id_token) => {
    const token = await authApi.loginGoogle(id_token)
    setSession(token)
    rememberSessionHint()
    return token?.user ?? null
  }, [])

  // 로그아웃 - 서버 호출이 실패해도 이 브라우저에서는 끝낸다
  const signOut = useCallback(async () => {
    try {
      await authApi.logout()
    } catch {
      // 연결이 안 돼도 이 브라우저의 세션은 지운다
    }
    clearSession('logout')
    clearUserScopedStorage()
  }, [])

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
