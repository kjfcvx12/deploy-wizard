import { useEffect, useRef, useState } from 'react'

import { isProgress } from '@features/deploys/ui/constants.js'

import { envApi } from './api.js'
import { ENV_KINDS, ENV_SECRET_KINDS, canContinue, groupEnvVars, kindLabel } from './constants.js'

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/
const NAME_MESSAGE = '이름은 영문자나 _로 시작하고, 영문자·숫자·_만 100자까지 쓸 수 있습니다.'

// 변수 한 줄 - 종류에 따라 값 입력 / 종류 고르기 / 시크릿 안내를 다르게 보여 준다
function EnvRow({ row, busy, onPut, onClear }) {
  const [value, setValue] = useState('')
  // 다섯 종류가 아닌 값은 모르는 종류로 다룬다 - 값 입력창을 절대 주지 않기 위해서다
  const kind = ENV_KINDS.some((k) => k.key === row.kind) ? row.kind : 'unknown'
  const isSecret = ENV_SECRET_KINDS.has(kind)
  const isDone = row.status === 'set' || row.status === 'skipped'

  // 값은 저장에 성공했을 때만 비운다 - 실패하면 다시 시도할 수 있게 남겨 둔다
  const save = async (event) => {
    event.preventDefault()
    if (await onPut(row.name, { value })) setValue('')
  }

  return (
    <li className="env-row">
      <div className="env-head">
        <code className="env-name">{row.name}</code>
        <span className="badge">{kindLabel(row.kind)}</span>
        {isDone && <span className={`badge ${row.status === 'set' ? 'ok' : ''}`}>{row.status === 'set' ? '입력됨' : '건너뜀'}</span>}
      </div>
      {row.source_hint && <div className="muted small env-hint">{row.source_hint}</div>}

      {isDone ? (
        <div className="env-actions">
          {row.status === 'set' && <button onClick={() => onClear(row.name)} disabled={busy} aria-label={`${row.name} 값 지우기`}>값 지우기</button>}
          {row.status === 'skipped' && <button onClick={() => onPut(row.name, { skip: false })} disabled={busy} aria-label={`${row.name} 건너뛰기 취소`}>건너뛰기 취소</button>}
        </div>
      ) : kind === 'unknown' ? (
        <div className="env-actions">
          <span className="muted small">이 변수는 어떤 종류인가요?</span>
          {ENV_KINDS.map((k) => (
            <button key={k.key} onClick={() => onPut(row.name, { kind: k.key })} disabled={busy} aria-label={`${row.name} 종류: ${k.label}`}>{k.label}</button>
          ))}
          <button onClick={() => onPut(row.name, { skip: true })} disabled={busy} aria-label={`${row.name} 건너뛰기`}>건너뛰기</button>
        </div>
      ) : isSecret ? (
        <div className="env-actions">
          <span className="muted small env-note">이 종류의 값은 아직 저장할 수 없습니다. 지금은 건너뛰기만 됩니다.</span>
          <button onClick={() => onPut(row.name, { skip: true })} disabled={busy} aria-label={`${row.name} 건너뛰기`}>건너뛰기</button>
        </div>
      ) : (
        <form className="env-actions" onSubmit={save}>
          <input
            className="env-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={2000}
            autoComplete="off"
            spellCheck={false}
            aria-label={`${row.name} 값`}
            disabled={busy}
          />
          <button type="submit" disabled={busy || value === ''} aria-label={`${row.name} 저장`}>저장</button>
          <button type="button" onClick={() => onPut(row.name, { skip: true })} disabled={busy} aria-label={`${row.name} 건너뛰기`}>건너뛰기</button>
        </form>
      )}
    </li>
  )
}

// 같은 성격의 변수 묶음 - fold 이면 접을 수 있게 하되 처음부터 펼쳐 두어 내용이 가려지지 않게 한다
function EnvGroup({ title, rows, fold, ...rowProps }) {
  if (rows.length === 0) return null

  const list = <ul className="env-list">{rows.map((row) => <EnvRow key={row.name} row={row} {...rowProps} />)}</ul>

  if (fold) {
    return (
      <details className="env-group" open>
        <summary>{title} <span className="muted small">({rows.length})</span></summary>
        {list}
      </details>
    )
  }

  return (
    <div className="env-group">
      <h3>{title} <span className="muted small">({rows.length})</span></h3>
      {list}
    </div>
  )
}

// 환경변수 입력 카드 (S-19) - 값은 쓰기 전용이라 저장 뒤에는 화면에도 상태에도 남기지 않는다
export default function EnvVarsCard({ deploy, onContinued, onRedeploy }) {
  const { d_id, status } = deploy
  const cardRef = useRef(null)
  const headingRef = useRef(null)
  const refocus = useRef(false)

  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [redeployHint, setRedeployHint] = useState(false)
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState('config')
  const [nameError, setNameError] = useState('')

  // 상태가 바뀔 때마다 목록을 다시 받는다 (needs_input 이후에는 페이지 폴링이 멈추기 때문)
  useEffect(() => {
    let alive = true
    envApi.getAll(d_id)
      .then((data) => { if (alive) { setRows(data); setError('') } })
      .catch((e) => alive && setError(e.message))
    return () => { alive = false }
  }, [d_id, status])

  // 누른 버튼이 사라져 포커스를 잃었으면 카드 제목으로 돌려 키보드 순서를 이어 준다
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    if (!cardRef.current?.contains(document.activeElement)) headingRef.current?.focus({ preventScroll: true })
  }, [rows])

  // 변경 요청을 보내고 목록을 새로 받는다 - 요청이 성공했는지를 돌려준다
  const mutate = async (call) => {
    setBusy(true)
    setError('')
    let done = false
    try {
      const row = await call()
      done = true
      if (row?.needs_redeploy) setRedeployHint(true)
      refocus.current = true
      setRows(await envApi.getAll(d_id))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
    return done
  }

  const put = (name, body) => mutate(() => envApi.put(d_id, name, body))
  const clear = (name) => mutate(() => envApi.clearValue(d_id, name))

  // 변수 직접 추가 - 이름 규칙은 서버와 같게 먼저 확인한다
  const add = async (event) => {
    event.preventDefault()
    if (!NAME_PATTERN.test(newName)) { setNameError(NAME_MESSAGE); return }
    if (rows?.some((r) => r.name === newName)) { setNameError('이미 목록에 있는 변수입니다'); return }
    setNameError('')
    if (await put(newName, { kind: newKind })) setNewName('')
  }

  // 이어서 배포 - 서버가 거절(409)하면 이유를 보여 주고 입력은 그대로 둔다
  const goOn = async () => {
    setBusy(true)
    setError('')
    try {
      await envApi.continueDeploy(d_id)
      onContinued()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const redeploy = () => {
    setRedeployHint(false)
    onRedeploy()
  }

  if (rows === null && !error) return null
  if (rows?.length === 0 && status !== 'needs_input' && !error) return null

  // 목록을 받지 못했으면 제목과 오류만 보여 준다
  if (rows === null) {
    return (
      <section className="card">
        <h2>환경변수</h2>
        <div className="notice err">{error}</div>
      </section>
    )
  }

  const list = rows
  const groups = groupEnvVars(list)
  const waiting = status === 'needs_input'
  const ready = canContinue(list)
  const rowProps = { busy, onPut: put, onClear: clear }

  return (
    <section className="card" ref={cardRef}>
      <h2 ref={headingRef} tabIndex={-1}>환경변수</h2>

      {list.length === 0 && waiting ? (
        <p className="muted" style={{ margin: 0 }}>입력할 환경변수를 찾지 못했습니다. [이어서 배포]를 눌러 계속하세요.</p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>코드에서 필요한 값을 찾았습니다. 값은 이 화면에서만 입력하고, 한 번 저장하면 다시 보여 드리지 않습니다.</p>
      )}

      <EnvGroup title="꼭 필요해 보이는 것" rows={groups.need} {...rowProps} />
      <EnvGroup title="종류를 모르는 것" rows={groups.unknown} {...rowProps} />
      <EnvGroup title="기본값이 있어 비워도 되는 것" rows={groups.optional} fold {...rowProps} />
      <EnvGroup title="입력 완료" rows={groups.done} fold {...rowProps} />

      <form className="env-add" onSubmit={add}>
        <input
          className="env-input"
          value={newName}
          onChange={(e) => { setNewName(e.target.value); setNameError('') }}
          placeholder="변수 이름 (예: API_BASE_URL)"
          autoComplete="off"
          spellCheck={false}
          aria-label="추가할 변수 이름"
          aria-invalid={Boolean(nameError)}
          aria-describedby={nameError ? 'env-name-error' : undefined}
          disabled={busy}
        />
        <select value={newKind} onChange={(e) => setNewKind(e.target.value)} aria-label="추가할 변수 종류" disabled={busy}>
          {ENV_KINDS.map((kind) => <option key={kind.key} value={kind.key}>{kind.label}</option>)}
        </select>
        <button type="submit" disabled={busy || newName === ''}>변수 직접 추가</button>
      </form>
      {nameError && <div id="env-name-error" className="small env-field-err" role="alert">{nameError}</div>}

      <p className="muted small" style={{ margin: '12px 0 0' }}>자동으로 찾지 못한 변수가 있을 수 있습니다. 배포 후 앱이 시작하지 못하면 알려 드립니다.</p>

      {redeployHint && (
        <div className="notice warn">
          <div className="row spread">
            <span>다시 배포해야 적용됩니다</span>
            {!isProgress(status) && <button onClick={redeploy} disabled={busy}>다시 배포</button>}
          </div>
        </div>
      )}

      {error && <div className="notice err">{error}</div>}

      {waiting && (
        <div className="env-foot">
          <button className="primary" onClick={goOn} disabled={busy || !ready} aria-describedby={ready ? undefined : 'env-block-reason'}>이어서 배포</button>
          {!ready && <span id="env-block-reason" className="muted small">필수 환경변수에 값이 없습니다</span>}
        </div>
      )}
    </section>
  )
}
