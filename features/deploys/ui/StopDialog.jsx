// 멈춤 확인 창 - 기본 초점은 안전한 [그대로 두기]
export default function StopDialog({ dialogRef, onStop }) {
  return (
    <dialog ref={dialogRef}>
      <h2 style={{ marginTop: 0 }}>이 배포를 멈출까요?</h2>
      <p>ECS 서비스를 내려서 컨테이너 요금이 멈춥니다. 주소는 접속되지 않게 됩니다. 이미지와 설정은 남겨 두므로 [다시 켜기] 한 번으로 다시 띄울 수 있습니다.</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button autoFocus onClick={() => dialogRef.current?.close()}>그대로 두기</button>
        <button className="danger" onClick={onStop}>멈춤</button>
      </div>
    </dialog>
  )
}
