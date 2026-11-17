import { createElement, useEffect, useRef } from 'react'
import { loadGoogleIdentity, renderGoogleButton, GIS_LOAD_ERROR_TEXT } from './google.web'

// 웹 번들의 Google 로그인 버튼 - GIS 가 그린 버튼에서 받은 id_token 만 onCredential 에 넘긴다. 불러오기 실패는 한국어 문장을 onError 로 알린다
export default function GoogleWebButton({ clientId, onCredential, onError }) {
  const hostRef = useRef(null)
  const onCredentialRef = useRef(onCredential)
  const onErrorRef = useRef(onError)
  onCredentialRef.current = onCredential
  onErrorRef.current = onError

  useEffect(() => {
    if (!clientId || !hostRef.current) return undefined
    let alive = true
    loadGoogleIdentity()
      .then((gisId) => {
        if (!alive || !hostRef.current) return
        renderGoogleButton(gisId, hostRef.current, {
          client_id: clientId,
          onCredential: (credential) => onCredentialRef.current?.(credential),
        })
      })
      .catch(() => {
        if (alive) onErrorRef.current?.(GIS_LOAD_ERROR_TEXT)
      })
    return () => { alive = false }
  }, [clientId])

  return createElement('div', { ref: hostRef, style: { display: 'flex', justifyContent: 'center', minHeight: 44 } })
}
