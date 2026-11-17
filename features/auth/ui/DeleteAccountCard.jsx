import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { authApi } from './api.js'
import { parseLiveDeploys } from './authLogic.js'

const DELETE_DESCRIPTION = '계정과 이 마법사의 기록(배포 기록·연결·알림)을 지웁니다. AWS 의 서비스·CloudFormation 스택·ECR 이미지와 GitHub 앱 설치는 지우지 않습니다. 되돌릴 수 없습니다.'
const DELETE_FAILED_TEXT = '계정을 삭제하지 못했습니다'

// 계정 삭제 카드 (빨간 테두리) - 확인 창 뒤에 지우고, 성공하면 응답을 onDeleted 로 넘긴다. 서비스를 대신 멈추거나 지우지 않고 링크만 준다
export default function DeleteAccountCard({ onDeleted }) {
  const dialog = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // 확인 창에서 [삭제]를 눌렀을 때
  async function remove() {
    dialog.current?.close()
    setBusy(true)
    setError(null)
    try {
      const response = await authApi.deleteMe()
      onDeleted(response)
    } catch (e) {
      // 409 는 살아 있는 서비스 목록으로 나누고, 그 밖(403·503·500)은 서버 문구 그대로
      const text = typeof e?.message === 'string' && e.message ? e.message : DELETE_FAILED_TEXT
      setError(e?.status === 409 ? parseLiveDeploys(text) : { message: text, items: [] })
      setBusy(false)
    }
  }

  return (
    <section className="card delete-card">
      <h2>계정 삭제</h2>
      <p>{DELETE_DESCRIPTION}</p>
      <div className="row">
        <button className="danger" onClick={() => dialog.current?.showModal()} disabled={busy}>{busy ? '삭제하는 중…' : '계정 삭제'}</button>
      </div>

      {error && (
        <div className="notice err" role="alert">
          <div>{error.message}</div>
          {error.items.length > 0 && (
            <>
              <ul className="delete-live">
                {error.items.map((item) => (
                  <li key={item.d_id}><Link to={`/deploys/${item.d_id}`}>#{item.d_id} {item.label}</Link></li>
                ))}
              </ul>
              <div>먼저 이 서비스들을 멈추거나 삭제한 뒤 다시 시도하세요.</div>
            </>
          )}
        </div>
      )}

      <dialog ref={dialog}>
        <h2 style={{ marginTop: 0 }}>계정을 삭제할까요?</h2>
        <p>{DELETE_DESCRIPTION}</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button autoFocus onClick={() => dialog.current?.close()}>취소</button>
          <button className="danger" onClick={remove}>삭제</button>
        </div>
      </dialog>
    </section>
  )
}
