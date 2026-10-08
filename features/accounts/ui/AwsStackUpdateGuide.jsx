import { Shot, Step } from './AwsStackGuide.jsx'

const TEMPLATE_FILE = 'deploy_wizard_role.yaml'

// 스택 업데이트 안내 (M6) - 템플릿에 권한이 추가됐을 때. 사용자 계정의 역할은 사용자만 바꿀 수 있다
export default function AwsStackUpdateGuide({ info }) {
  return (
    <div>
      <p className="muted small">
        배포 마법사에 기능이 추가되면서 필요한 권한이 늘었습니다. 지금 연결된 역할은 예전 권한(버전 {info.current_version})이라
        일부 기능이 AWS에서 거부됩니다. 최신 템플릿(버전 {info.latest_version})으로 스택을 한 번 업데이트하면 됩니다.
        연결과 ExternalId는 그대로이고, 비용은 없습니다.
      </p>

      <Step num={1} title="최신 템플릿 내려받기">
        <p className="small"><a href={info.template_download_url} target="_blank" rel="noreferrer">{TEMPLATE_FILE} 내려받기</a> — 다운로드 폴더에 저장됩니다.</p>
      </Step>

      <Step num={2} title="콘솔에서 스택을 고르고 [업데이트]">
        <p className="small"><a href={info.stack_list_url} target="_blank" rel="noreferrer">AWS 콘솔의 스택 목록 열기</a> (새 탭) → 연결할 때 만든 스택을 선택합니다.</p>
        <Shot title="CloudFormation › 스택">
          <div className="shot-line">
            <span className="shot-option on shot-mark"><span className="shot-dot" />deploy-wizard</span>
            <span className="badge ok">CREATE_COMPLETE</span>
            <span className="shot-btn shot-mark">업데이트</span>
          </div>
        </Shot>
        <p className="muted small">"직접 업데이트"와 "변경 세트 생성" 중에 고르라고 나오면 직접 업데이트를 고릅니다.</p>
      </Step>

      <Step num={3} title="기존 템플릿을 새 파일로 교체">
        <Shot title="스택 업데이트 › 템플릿 준비">
          <div className="shot-line">
            <span className="shot-option"><span className="shot-dot" />기존 템플릿 사용</span>
            <span className="shot-option on shot-mark"><span className="shot-dot" />기존 템플릿 교체</span>
          </div>
          <div className="shot-label">템플릿 지정</div>
          <div className="shot-line">
            <span className="shot-option on shot-mark"><span className="shot-dot" />템플릿 파일 업로드</span>
          </div>
          <div className="shot-line">
            <span className="shot-option shot-mark">파일 선택</span>
            <span className="shot-file">{TEMPLATE_FILE}</span>
            <span className="shot-btn">다음</span>
          </div>
        </Shot>
      </Step>

      <Step num={4} title="파라미터와 옵션은 그대로 [다음]">
        <p className="small">TrustedAwsAccountId와 ExternalId는 이미 채워져 있습니다. 바꾸지 않습니다.</p>
      </Step>

      <Step num={5} title="IAM 승인을 체크하고 [전송]">
        <Shot title="검토 — 맨 아래">
          <div className="shot-line">
            <span className="shot-option on shot-mark"><span className="shot-box" />AWS CloudFormation에서 사용자 지정 이름으로 IAM 리소스를 생성할 수 있음을 승인합니다.</span>
          </div>
          <div className="shot-line"><span className="shot-btn">전송</span></div>
        </Shot>
        <p className="muted small">상태가 UPDATE_COMPLETE 가 되면 아래 [업데이트 확인]을 누르세요.</p>
      </Step>
    </div>
  )
}
