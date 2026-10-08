// 연결 블록 안의 상자 하나 (GitHub 또는 AWS 계정)
// 위: 왼쪽 이름 · 오른쪽 상태 / 가운데: 화살표로 연결해 둔 계정을 넘겨 보고, 그 밑 `n / 전체` 아래의 [선택]으로 이 블록에 잇는다 / 아래: 왼쪽 [계정 추가] · 가운데 [연결 확인] · 오른쪽 [연결 해제]
export default function AccountBox({ title, badge, count, index, onMove, picked, onPick, busy, left, center, right, children }) {
  return (
    <div className="account-box">
      <div className="row spread">
        <div className="deploy-name">{title}</div>
        <span className={`badge ${badge.tone}`}>{badge.text}</span>
      </div>

      <div className="account-pick">
        <button className="account-arrow" onClick={() => onMove(-1)} disabled={busy || count < 2} aria-label="이전 계정">‹</button>
        <div className="account-info">{children}</div>
        <button className="account-arrow" onClick={() => onMove(1)} disabled={busy || count < 2} aria-label="다음 계정">›</button>
      </div>

      {count > 0 && (
        <div className="account-choose">
          <span className="muted small">{index + 1} / {count}</span>
          <button className={picked ? '' : 'primary'} onClick={onPick} disabled={busy || picked}>{picked ? '선택됨' : '선택'}</button>
        </div>
      )}

      <div className="account-foot">
        <div>{left}</div>
        <div>{center}</div>
        <div>{right}</div>
      </div>
    </div>
  )
}
