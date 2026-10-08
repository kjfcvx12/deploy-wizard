import { useEffect, useRef, useState } from 'react'

const STACK_NAME = 'deploy-wizard'
const TEMPLATE_FILE = 'deploy_wizard_role.yaml'

// 값 하나를 클립보드로 - 콘솔 입력 칸에 그대로 붙여넣게 한다
function CopyButton({ value }) {
  const [done, setDone] = useState(false)
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async (e) => {
    // 모달 밖(body)은 선택이 안 되므로 대화상자 안을 쓴다. await 뒤에는 이벤트 대상이 사라지므로 먼저 잡아 둔다
    const host = e.currentTarget.closest('dialog') || document.body

    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // 클립보드 권한이 막힌 브라우저 - 임시 입력 칸으로 복사한다
      const area = document.createElement('textarea')
      area.value = value
      host.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    setDone(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setDone(false), 1500)
  }

  return <button type="button" className={`copy ${done ? 'done' : ''}`} onClick={copy}>{done ? '복사됨' : '복사'}</button>
}

// 콘솔 화면을 단순하게 그린 그림 한 장
export function Shot({ title, children }) {
  return (
    <figure className="shot">
      <figcaption className="shot-bar">{title}</figcaption>
      <div className="shot-body">{children}</div>
    </figure>
  )
}

// 그림 속 입력 칸 - 넣을 값이 들어 있고 옆에서 바로 복사한다
function ShotField({ label, value }) {
  return (
    <div>
      <div className="shot-label">{label}</div>
      <div className="shot-line">
        <div className="shot-input shot-mark">{value}</div>
        <CopyButton value={value} />
      </div>
    </div>
  )
}

export function Step({ num, title, children }) {
  return (
    <div className="guide-step">
      <div className="guide-num">{num}</div>
      <div>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

// AWS 계정 연결 안내 (M6) - 템플릿 받기부터 RoleArn 복사까지, 콘솔 화면 순서 그대로
export default function AwsStackGuide({ setup }) {
  return (
    <div>
      <p className="muted small">그림은 콘솔 화면을 단순하게 그린 것입니다. 실제 화면과 문구가 조금 다를 수 있습니다. 주황색 테두리가 직접 건드릴 곳입니다.</p>

      <Step num={1} title="템플릿 내려받기">
        <p className="small"><a href={setup.template_download_url} target="_blank" rel="noreferrer">{TEMPLATE_FILE} 내려받기</a> — 다운로드 폴더에 저장됩니다.</p>
      </Step>

      <Step num={2} title="스택 생성 화면에서 파일 올리기">
        <p className="small"><a href={setup.stack_create_url} target="_blank" rel="noreferrer">AWS 콘솔의 스택 생성 화면 열기</a> (새 탭)</p>
        <Shot title="CloudFormation › 스택 생성">
          <div className="shot-label">사전 조건 - 템플릿 준비</div>
          <div className="shot-line">
            <span className="shot-option on"><span className="shot-dot" />기존 템플릿 선택</span>
          </div>
          <div className="shot-label">템플릿 지정</div>
          <div className="shot-line">
            <span className="shot-option"><span className="shot-dot" />Amazon S3 URL</span>
            <span className="shot-option on shot-mark"><span className="shot-dot" />템플릿 파일 업로드</span>
          </div>
          <div className="shot-line">
            <span className="shot-option shot-mark">파일 선택</span>
            <span className="shot-file">{TEMPLATE_FILE}</span>
            <span className="shot-btn">다음</span>
          </div>
        </Shot>
      </Step>

      <Step num={3} title="스택 이름과 파라미터 넣기">
        <p className="small">값마다 [복사]를 눌러 같은 이름의 칸에 붙여넣습니다.</p>
        <Shot title="스택 세부 정보 지정">
          <ShotField label="스택 이름" value={STACK_NAME} />
          <div className="shot-label">파라미터</div>
          <ShotField label="TrustedAwsAccountId" value={setup.our_account_id} />
          <ShotField label="ExternalId" value={setup.external_id} />
          <div className="shot-line"><span className="shot-btn">다음</span></div>
        </Shot>
        <p className="muted small">ExternalId는 지금 한 번만 보여줍니다. 이 창을 닫으면 다시 볼 수 없습니다.</p>
      </Step>

      <Step num={4} title="스택 옵션은 그대로 두고 [다음]">
        <p className="small">태그·권한·실패 옵션은 아무것도 바꾸지 않고 맨 아래 [다음]을 누릅니다.</p>
      </Step>

      <Step num={5} title="IAM 승인을 체크하고 [전송]">
        <Shot title="검토 및 생성 — 맨 아래">
          <div className="shot-label">기능</div>
          <div className="shot-line">
            <span className="shot-option on shot-mark"><span className="shot-box" />AWS CloudFormation에서 사용자 지정 이름으로 IAM 리소스를 생성할 수 있음을 승인합니다.</span>
          </div>
          <div className="shot-line"><span className="shot-btn">전송</span></div>
        </Shot>
        <p className="muted small">체크하지 않으면 생성이 거부됩니다. 만들어지는 것은 IAM 역할 3개뿐이고 비용은 없습니다.</p>
      </Step>

      <Step num={6} title="완료되면 [출력] 탭에서 RoleArn 복사">
        <p className="small">상태가 CREATE_COMPLETE 가 될 때까지 1~2분 기다립니다. 새로고침 버튼으로 확인합니다.</p>
        <Shot title={`스택 › ${STACK_NAME}`}>
          <div className="shot-line"><span className="badge ok">CREATE_COMPLETE</span></div>
          <div className="shot-tabs">
            <span>스택 정보</span><span>이벤트</span><span>리소스</span><span className="on shot-mark">출력</span>
          </div>
          <div className="shot-label">키 · 값</div>
          <div className="shot-line">
            <span>RoleArn</span>
            <div className="shot-input shot-mark">arn:aws:iam::…:role/DeployWizardCrossAccountRole</div>
          </div>
        </Shot>
        <p className="muted small">CREATE_FAILED 나 ROLLBACK 이 나오면 [이벤트] 탭의 빨간 줄 "상태 이유"를 확인하세요.</p>
      </Step>
    </div>
  )
}
