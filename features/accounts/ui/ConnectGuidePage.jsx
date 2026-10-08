import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

import { accountsApi } from './api.js'
import AwsStackGuide, { Shot, Step } from './AwsStackGuide.jsx'
import { ACCOUNTS_CHANNEL } from './guideWindow.js'

// 일을 끝낸 안내 창 - 연결 화면을 앞으로 가져오고 스스로 닫는다
const finish = () => {
  window.opener?.focus()
  window.close()
}

// GitHub 설치 안내 - 원래 창은 GitHub 화면으로 넘어가 있다. 설치가 끝나 원래 창이 돌아오면 이 창은 닫힌다
function GithubGuide() {
  const [done, setDone] = useState(false)

  useEffect(() => {
    const channel = new BroadcastChannel(ACCOUNTS_CHANNEL)
    let timer = null

    channel.onmessage = (event) => {
      if (event.data?.type !== 'github-connected') return
      setDone(true)
      timer = setTimeout(finish, 1500)
    }

    return () => { channel.close(); clearTimeout(timer) }
  }, [])

  if (done) return <div className="notice ok">GitHub 연결이 끝났습니다. 이 창은 곧 닫힙니다.</div>

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>GitHub 연결 방법</h2>
      <p className="muted small">원래 창에 GitHub 화면(영어)이 열려 있습니다. 이 창을 옆에 두고 따라 하세요. 끝나면 원래 창이 연결 화면으로 돌아오고, 이 창은 저절로 닫힙니다.</p>

      <Step num={1} title="설치할 계정 고르기">
        <p className="small">계정이나 조직이 여러 개면 목록이 나옵니다. 배포할 레포가 있는 곳을 누릅니다. 하나뿐이면 이 화면은 나오지 않습니다.</p>
      </Step>

      <Step num={2} title="접근을 허락할 레포 고르기">
        <Shot title="GitHub 설치 화면 › Repository access">
          <div className="shot-line"><span className="shot-option on shot-mark"><span className="shot-dot" />All repositories</span><span className="shot-file">한 번만 연결하면 끝</span></div>
          <div className="shot-line"><span className="shot-option"><span className="shot-dot" />Only select repositories</span><span className="shot-file">고른 레포만</span></div>
        </Shot>
        <p className="small">이 화면은 "어떤 레포를 배포할지"가 아니라 <strong>"배포 마법사가 읽어도 되는 범위"</strong>를 정하는 GitHub의 화면입니다. 실제로 배포할 레포는 나중에 홈에서 주소로 넣습니다.</p>
        <p className="muted small"><strong>All repositories</strong> — 이후 어떤 레포든(새로 만든 것도) 주소만 넣으면 배포됩니다. 다시 올 필요가 없습니다.<br /><strong>Only select repositories</strong> — 고른 레포만 읽을 수 있습니다. 다른 private 레포를 배포하려면 GitHub 설정에서 그 레포를 추가해야 합니다.<br />어느 쪽이든 받는 권한은 코드 읽기(Contents)와 기본 정보(Metadata) 읽기뿐이고, 쓰기 권한은 없습니다. public 레포는 연결 없이도 배포됩니다.</p>
      </Step>

      <Step num={3} title="초록색 [Install] 누르기">
        <Shot title="화면 아래">
          <div className="shot-line"><span className="shot-btn shot-mark" style={{ marginLeft: 0 }}>Install</span><span className="shot-option">Cancel</span></div>
        </Shot>
        <p className="muted small">이미 설치한 적이 있으면 버튼이 [Save]로 보입니다. GitHub가 비밀번호를 다시 물을 수 있습니다.</p>
      </Step>

      <Step num={4} title="자동으로 돌아옵니다">
        <p className="small">설치가 끝나면 원래 창이 배포 마법사의 연결 화면으로 돌아와 연결이 잘 됐는지 확인한 결과를 보여줍니다.</p>
      </Step>
    </div>
  )
}

// AWS 스택 안내 - 연결 화면이 보내 주는 값(ExternalId 등)을 받아 보여주고, 마지막에 RoleArn 을 여기서 바로 등록한다
function AwsGuide() {
  const [setup, setSetup] = useState(null)
  const [waited, setWaited] = useState(false)
  const [roleArn, setRoleArn] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const receive = (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'dw-guide-setup') return
      setSetup(event.data.setup)
    }

    window.addEventListener('message', receive)
    window.opener?.postMessage({ type: 'dw-guide-ready' }, window.location.origin)
    const timer = setTimeout(() => setWaited(true), 4000)

    return () => { window.removeEventListener('message', receive); clearTimeout(timer) }
  }, [])

  const attachRole = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await accountsApi.attachRole(setup.a_id, roleArn.trim())

      const channel = new BroadcastChannel(ACCOUNTS_CHANNEL)
      channel.postMessage({ type: 'aws-connected', a_id: setup.a_id })
      channel.close()
      finish()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  if (!setup) {
    return waited
      ? <div className="notice warn">연결 정보를 받지 못했습니다. 이 창을 닫고 연결 화면의 블록에서 [역할 ARN 입력]으로 이어서 하거나, AWS 연결을 해제한 뒤 [AWS 연결]을 다시 눌러 주세요.</div>
      : <p className="muted">준비 중...</p>
  }

  return (
    <form onSubmit={attachRole}>
      <h2 style={{ marginTop: 0 }}>AWS 계정 연결 방법 — {setup.label}</h2>
      <p className="muted small">이 창을 AWS 콘솔 옆에 두고 따라 하세요. 마지막에 여기서 [확인]을 누르면 이 창이 닫히고 연결 화면에 결과가 나옵니다.</p>

      <AwsStackGuide setup={setup} />

      <Step num={7} title="RoleArn 붙여넣고 [확인]">
        <div className="row">
          <input className="grow" placeholder="arn:aws:iam::...:role/DeployWizardCrossAccountRole" value={roleArn} onChange={(e) => setRoleArn(e.target.value)} required />
        </div>
      </Step>

      {error && <div className="notice err">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" onClick={finish}>나중에</button>
        <button className="primary" type="submit" disabled={busy || !roleArn}>확인</button>
      </div>
      <p className="muted small">[나중에]를 눌러도 연결은 대기 상태로 남습니다. 다만 ExternalId는 다시 볼 수 없으니, 스택을 만든 뒤에 닫으세요.</p>
    </form>
  )
}

// 연결 안내 창 (M6) - [연결]을 누르면 따로 뜨는 작은 창. 작업 화면(GitHub·AWS 콘솔) 옆에 두고 따라 한다
export default function ConnectGuidePage() {
  const { kind } = useParams()

  return (
    <main className="guide-page">
      {kind === 'github' && <GithubGuide />}
      {kind === 'aws' && <AwsGuide />}
      {kind !== 'github' && kind !== 'aws' && <p className="muted">없는 안내입니다.</p>}
    </main>
  )
}
