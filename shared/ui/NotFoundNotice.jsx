import { useLocation, useNavigate } from 'react-router-dom'

// 없는 항목 안내 - 바로 연 화면이라 돌아갈 곳이 없으면 목록으로
export default function NotFoundNotice({ text }) {
  const navigate = useNavigate()
  const location = useLocation()
  const leave = () => { if (location.key === 'default') navigate('/'); else navigate(-1) }
  return (
    <>
      <div className="notice err" style={{ marginTop: 0 }}>{text}</div>
      <div className="row" style={{ marginTop: 16 }}><button onClick={leave}>돌아가기</button></div>
    </>
  )
}
