import { useCallback, useEffect, useRef, useState } from 'react'

import { formatTime } from '@shared/ui/time.js'

import { authApi } from './api.js'
import { useAuth } from './AuthProvider.jsx'
import { copyText, mcpEnvLine, shouldCloseIssuedPanel, tokenExpiryText, validateTokenForm } from './authLogic.js'

const TITLE = '개인 토큰 (MCP)'
const DESCRIPTION = 'Claude Code 같은 MCP 클라이언트가 이 계정으로 마법사를 쓰게 하는 토큰입니다. 원문은 만들 때 한 번만 보입니다.'
const COPY_FALLBACK_TEXT = '직접 선택해 복사해 주세요'
const REVOKE_WARNING = '이 토큰을 쓰는 MCP 연결이 바로 끊깁니다.'
const CLOSE_WARNING = '이 창을 닫으면 다시 볼 수 없습니다.'

// 서버 문구가 있으면 그대로, 없으면 기본 문구
const errorText = (e, fallback) => (typeof e?.message === 'string' && e.message ? e.message : fallback)

// 개인 토큰 카드 (S-15) - 목록·만들기·폐기. 원문은 발급 패널의 이 컴포넌트 상태에만 있고 패널을 닫거나 화면을 떠나면 null 이 된다
export default function TokensCard() {
  const { config } = useAuth()
  const [tokens, setTokens] = useState(null)
  const [listError, setListError] = useState(null)
  const [name, setName] = useState('mcp')
  const [days, setDays] = useState('')
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)
  // 방금 만든 토큰 원문 - { token, name, a_t_id } 이거나 null (a_t_id 는 비밀이 아니다). 원문은 다른 곳에 두지 않는다
  const [issued, setIssued] = useState(null)
  // 복사 결과 - 각 칸이 'ok' | 'fail' | undefined (원문은 담지 않는다)
  const [copied, setCopied] = useState({})
  const [revokeTarget, setRevokeTarget] = useState(null)
  const [revoking, setRevoking] = useState(false)
  const [notice, setNotice] = useState(null)
  const live = useRef(true)
  const seq = useRef(0)
  const dialog = useRef(null)
  const cancelRef = useRef(null)
  const panel = useRef(null)

  // 목록 읽기 - 늦게 도착한 옛 응답은 버린다
  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const list = await authApi.listTokens()
      if (!live.current || mine !== seq.current) return
      setTokens(Array.isArray(list) ? list : [])
      setListError(null)
    } catch (e) {
      if (!live.current || mine !== seq.current) return
      setListError(errorText(e, '토큰 목록을 읽지 못했습니다'))
    }
  }, [])

  // 처음 읽기, 화면을 떠나면(언마운트) 원문을 비운다
  useEffect(() => {
    live.current = true
    load()
    return () => {
      live.current = false
      setIssued(null)
    }
  }, [load])

  // 발급 패널이 뜨면 키보드 사용자가 바로 읽을 수 있게 초점을 옮긴다
  useEffect(() => {
    if (issued) panel.current?.focus()
  }, [issued])

  // 만들기 - 폼을 먼저 검사하고 서버 오류는 서버 문구 그대로
  async function create(event) {
    event.preventDefault()
    const { body, error } = validateTokenForm({ name, days }, config)
    if (error) {
      setFormError(error)
      return
    }
    setFormError(null)
    setNotice(null)
    setBusy(true)
    try {
      const response = await authApi.createToken(body)
      if (!live.current) return
      if (typeof response?.token !== 'string' || !response.token) {
        setFormError('토큰을 받지 못했습니다. 목록을 확인하고 다시 만들어 주세요')
      } else {
        setCopied({})
        setIssued({ token: response.token, name: typeof response.name === 'string' ? response.name : body.name, a_t_id: response.a_t_id })
      }
      load()
    } catch (e) {
      if (live.current) setFormError(errorText(e, '토큰을 만들지 못했습니다'))
    } finally {
      if (live.current) setBusy(false)
    }
  }

  // 발급 패널 닫기 - 원문을 지운다
  function closeIssued() {
    setIssued(null)
    setCopied({})
  }

  // 복사 - 못 하면 직접 선택하라고 알린다
  async function copy(which, text) {
    const ok = await copyText(text, typeof navigator === 'undefined' ? undefined : navigator.clipboard)
    if (live.current) setCopied((prev) => ({ ...prev, [which]: ok ? 'ok' : 'fail' }))
  }

  // 폐기 확인 창 열기 - 초점을 [취소]에 둔다 (기본 초점이 버튼 순서에 기대지 않게)
  function askRevoke(item) {
    setRevokeTarget(item)
    dialog.current?.showModal()
    cancelRef.current?.focus()
  }

  // Esc·바깥 닫기로 창이 닫히면 폐기 대상을 비운다 (폐기 중에는 revoke 가 끝나고 비운다)
  function onRevokeDialogClose() {
    if (!revoking) setRevokeTarget(null)
  }

  // 확인 창에서 [폐기]를 눌렀을 때 - 404 는 이미 없는 것이니 목록만 새로 읽는다
  async function revoke() {
    const target = revokeTarget
    dialog.current?.close()
    if (!target) return
    setRevoking(true)
    setNotice(null)
    try {
      await authApi.revokeToken(target.a_t_id)
      // 지금 원문이 보이는 토큰을 폐기했으면 죽은 토큰의 원문이 남지 않게 패널을 닫는다
      if (live.current && shouldCloseIssuedPanel(issued, target.a_t_id)) closeIssued()
      await load()
      if (live.current) setNotice({ kind: 'ok', text: '개인 토큰을 폐기했습니다' })
    } catch (e) {
      if (e?.status === 404) {
        if (live.current && shouldCloseIssuedPanel(issued, target.a_t_id)) closeIssued()
        await load()
        if (live.current) setNotice({ kind: 'warn', text: '이미 폐기되었거나 없는 토큰입니다. 목록을 새로 읽었습니다' })
      } else if (live.current) {
        setNotice({ kind: 'err', text: errorText(e, '토큰을 폐기하지 못했습니다') })
      }
    } finally {
      if (live.current) {
        setRevoking(false)
        setRevokeTarget(null)
      }
    }
  }

  const now = Date.now()
  const maxDays = config?.pat_max_days
  const defaultDays = config?.pat_default_days
  return (
    <section className="card token-card">
      <h2>{TITLE}</h2>
      <p className="token-desc">{DESCRIPTION}</p>

      {listError && (
        <div className="notice err" role="alert">
          <div>{listError}</div>
          <div className="row" style={{ marginTop: 8 }}><button onClick={load}>다시 읽기</button></div>
        </div>
      )}
      {!listError && tokens === null && <p className="muted">불러오는 중…</p>}
      {tokens && tokens.length === 0 && <p className="muted">만든 토큰이 없습니다</p>}
      {tokens && tokens.length > 0 && (
        <ul className="token-list">
          {tokens.map((item) => (
            <li key={item.a_t_id} className="token-item">
              <div className="token-info">
                <div className="token-name">{item.name} <span className="token-last4 muted">…{item.last4}</span></div>
                <div className="token-meta muted">{tokenExpiryText(item.expires_at, now)}</div>
                <div className="token-meta muted">
                  {item.last_used_at ? `마지막 사용 ${formatTime(item.last_used_at) || item.last_used_at}` : '아직 쓰지 않음'}
                </div>
              </div>
              <button className="danger" onClick={() => askRevoke(item)} disabled={revoking}>폐기</button>
            </li>
          ))}
        </ul>
      )}
      {notice && <div className={`notice ${notice.kind}`} role={notice.kind === 'err' ? 'alert' : 'status'}>{notice.text}</div>}

      {issued && (
        <div className="token-issued" ref={panel} tabIndex={-1} role="region" aria-label="새 개인 토큰">
          <div className="token-issued-title">{issued.name} 토큰을 만들었습니다</div>
          <div className="token-copy">
            <code className="token-raw">{issued.token}</code>
            <button onClick={() => copy('token', issued.token)}>복사</button>
          </div>
          {copied.token === 'ok' && <div className="token-copy-note ok-text">복사했습니다</div>}
          {copied.token === 'fail' && <div className="token-copy-note err-text">{COPY_FALLBACK_TEXT}</div>}
          <div className="token-guide muted">MCP 등록에는 아래 한 줄을 환경변수로 넣으세요.</div>
          <div className="token-copy">
            <code className="token-raw">{mcpEnvLine(issued.token)}</code>
            <button onClick={() => copy('env', mcpEnvLine(issued.token))}>복사</button>
          </div>
          {copied.env === 'ok' && <div className="token-copy-note ok-text">복사했습니다</div>}
          {copied.env === 'fail' && <div className="token-copy-note err-text">{COPY_FALLBACK_TEXT}</div>}
          <div className="notice warn">{CLOSE_WARNING}</div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" onClick={closeIssued}>닫았습니다</button>
          </div>
        </div>
      )}

      <form className="token-form" onSubmit={create} noValidate>
        <h3>새 토큰 만들기</h3>
        <fieldset className="token-fields" disabled={busy || issued !== null}>
          <div className="token-field">
            <label htmlFor="token-name">이름</label>
            <input id="token-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
          <div className="token-field">
            <label htmlFor="token-days">기간 (일)</label>
            <input
              id="token-days"
              type="text"
              inputMode="numeric"
              value={days}
              placeholder={defaultDays ? String(defaultDays) : ''}
              onChange={(e) => setDays(e.target.value)}
              autoComplete="off"
              aria-describedby="token-days-hint"
            />
            <span id="token-days-hint" className="token-hint muted">{maxDays ? `최대 ${maxDays}일` : ''}</span>
          </div>
        </fieldset>
        {formError && <div className="notice err" role="alert">{formError}</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" type="submit" disabled={busy || issued !== null}>{busy ? '만드는 중…' : '토큰 만들기'}</button>
        </div>
        {issued && <div className="token-hint muted" style={{ marginTop: 8 }}>위 토큰을 먼저 닫아야 새로 만들 수 있습니다.</div>}
      </form>

      <dialog ref={dialog} onClose={onRevokeDialogClose}>
        <h2 style={{ marginTop: 0 }}>토큰을 폐기할까요?</h2>
        {revokeTarget && <p className="token-dialog-name">{revokeTarget.name} <span className="muted">…{revokeTarget.last4}</span></p>}
        <p>{REVOKE_WARNING}</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button ref={cancelRef} onClick={() => dialog.current?.close()}>취소</button>
          <button className="danger" onClick={revoke}>폐기</button>
        </div>
      </dialog>
    </section>
  )
}
