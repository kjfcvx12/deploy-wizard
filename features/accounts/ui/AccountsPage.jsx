import { useEffect, useRef, useState } from 'react'

import AccountBox from './AccountBox.jsx'
import { accountsApi } from './api.js'
import AwsStackGuide from './AwsStackGuide.jsx'
import AwsStackUpdateGuide from './AwsStackUpdateGuide.jsx'
import { ACCOUNTS_CHANNEL, openGuideWindow } from './guideWindow.js'
import { readPickedBlock, writePickedBlock } from './pickedBlock.js'

const AWS_STATUS_LABEL = { pending: '역할 등록 대기', verified: '연결됨', invalid: '확인 실패' }
const GITHUB_STATUS_LABEL = { active: '연결됨', suspended: '일시 중지', revoked: '끊김' }

const DELETE_TEXT = {
  block: {
    title: '이 연결 블록을 삭제할까요?',
    body: '이 블록의 AWS 계정 연결이 함께 지워지고, 이 블록으로 배포한 것들의 연결이 끊깁니다. 다른 블록이 같이 쓰는 AWS 계정은 남습니다. GitHub 연결은 다른 블록이 쓸 수 있어 남겨 둡니다. AWS 스택과 GitHub 앱 설치 자체는 지워지지 않습니다 — 그건 각자의 콘솔에서 직접 끊으세요.',
  },
  aws: {
    title: 'AWS 계정 연결을 해제할까요?',
    body: '이 AWS 계정으로 배포한 것들의 연결이 끊깁니다. 블록은 남고 AWS를 다시 연결할 수 있습니다. AWS 스택 자체는 지워지지 않습니다 — 콘솔에서 직접 지우세요.',
  },
}

// 계정 연결 (M6) - 블록 하나 = AWS 계정 하나 + GitHub 하나. [＋ 블록 추가]로 블록을 늘린다. 블록은 한 번에 하나씩 보여주고 화살표로 넘긴다
// AWS는 CloudFormation+AssumeRole, GitHub는 App 설치. 둘 다 액세스 키·PAT를 받지 않는다
export default function AccountsPage() {
  const [connections, setConnections] = useState(null)
  const [awsAccounts, setAwsAccounts] = useState([])
  const [installations, setInstallations] = useState([])
  // 블록의 상자마다 화살표로 넘겨 보고 있는 계정 (`<c_id>:aws`, `<c_id>:github`). 없으면 그 블록이 쓰는 계정을 보여준다
  const [view, setView] = useState({})
  // 지금 보이는 블록(화살표로 넘긴다)과 [선택]한 블록(새 배포 폼이 미리 골라 둔다)
  const [shownBlock, setShownBlock] = useState(null)
  const [pickedBlock, setPickedBlock] = useState(readPickedBlock)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const [label, setLabel] = useState('')
  // 이름을 묻는 창이 무엇을 만드는가 - null 이면 블록, c_id 면 그 블록의 상자에서 누른 AWS [계정 추가]
  const [addTarget, setAddTarget] = useState(null)
  const [setup, setSetup] = useState(null)
  const [roleArn, setRoleArn] = useState('')
  // 연결된 계정별 템플릿 상태 - update_needed 면 "스택 업데이트 필요"를 띄운다
  const [templateStatus, setTemplateStatus] = useState({})
  const [updateInfo, setUpdateInfo] = useState(null)
  const [deleteInfo, setDeleteInfo] = useState(null)

  const addDialog = useRef(null)
  const newDialog = useRef(null)
  const deleteDialog = useRef(null)
  const cleanupTarget = useRef(null)
  const cleanupDialog = useRef(null)
  const updateDialog = useRef(null)
  // 안내 창에 보낼 값 - 안내 창이 준비됐다고 알려 오면 보낸다 (ExternalId 는 주소에 싣지 않는다)
  const guideSetup = useRef(null)

  // 연결된 계정마다 스택이 최신 템플릿인지 확인 - 실패한 계정은 건너뛴다 (연결 자체의 문제는 [다시 확인]이 다룬다)
  const loadTemplateStatus = async (blocks) => {
    const next = {}
    await Promise.all(blocks.filter((block) => block.aws?.status === 'verified').map(async (block) => {
      try {
        next[block.aws.a_id] = await accountsApi.getTemplateStatus(block.aws.a_id)
      } catch {
        // 버전을 못 읽으면 표시하지 않는다
      }
    }))
    setTemplateStatus(next)
    return next
  }

  const load = async () => {
    try {
      const [nextConnections, nextAwsAccounts, nextInstallations] = await Promise.all([accountsApi.listConnections(), accountsApi.listAws(), accountsApi.listGithub()])
      setConnections(nextConnections)
      setAwsAccounts(nextAwsAccounts)
      setInstallations(nextInstallations)
      setError('')
      loadTemplateStatus(nextConnections)
    } catch (e) {
      setError(e.message)
    }
  }

  // 연결 확인 결과 알림 - 실제로 접근이 되는지 서버가 다시 물어본 것을 그대로 보여준다
  const announceGithub = async (g_id) => {
    try {
      const check = await accountsApi.checkGithub(g_id)
      const more = check.repository_count > check.repositories.length ? ' 외' : ''
      const names = check.repositories.length > 0 ? ` (${check.repositories.join(', ')}${more})` : ''
      setNotice(`GitHub 연결 확인됨 — ${check.account_login} · 레포 ${check.repository_count}개에 접근할 수 있습니다${names}`)
    } catch (e) {
      setError(e.message)
    }
  }

  const announceAws = async (a_id) => {
    try {
      const account = (await accountsApi.listAws()).find((item) => item.a_id === a_id)
      if (!account || account.status !== 'verified') return

      const state = await accountsApi.getTemplateStatus(a_id)
      setNotice(`AWS 계정 연결 확인됨 — ${account.label} · 계정 ${account.aws_account_id} · 역할 위임과 템플릿(버전 ${state.current_version})을 확인했습니다`)
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => {
    load()

    // GitHub 설치를 마치고 돌아온 경우 - 주소를 정리하고, 안내 창이 닫히게 알리고, 연결이 잘 됐는지 확인한다
    if (new URLSearchParams(window.location.search).get('connected') === 'github') {
      window.history.replaceState(null, '', '/accounts')

      const channel = new BroadcastChannel(ACCOUNTS_CHANNEL)
      channel.postMessage({ type: 'github-connected' })
      setTimeout(() => channel.close(), 1000)

      accountsApi.listGithub().then((list) => {
        const latest = [...list].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0]
        if (latest) announceGithub(latest.g_id)
      }).catch(() => {})
    }
  }, [])

  // 안내 창과 주고받기 - 준비됐다고 하면 값을 보내고, AWS 연결이 끝났다고 하면 목록을 새로 읽고 확인 결과를 알린다
  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'dw-guide-ready' || !guideSetup.current) return
      event.source.postMessage({ type: 'dw-guide-setup', setup: guideSetup.current }, window.location.origin)
    }

    const channel = new BroadcastChannel(ACCOUNTS_CHANNEL)
    channel.onmessage = (event) => {
      if (event.data?.type !== 'aws-connected') return
      guideSetup.current = null
      load()
      announceAws(event.data.a_id)
    }

    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage); channel.close() }
  }, [])

  // 한 가지 일을 하는 동안 버튼을 잠그고, 실패하면 알린다
  const run = async (work) => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const openAddDialog = () => {
    setAddTarget(null)
    setLabel('')
    setError('')
    addDialog.current?.showModal()
  }

  // 이름 창의 [추가]/[다음] - 빈 블록을 만든다. AWS와 GitHub는 블록 안에서 하나씩 연결한다
  // AWS [계정 추가]로 연 창이면 새 AWS 계정만 만든다. 블록에는 잇지 않는다 - 연결을 마친 뒤 상자에서 [선택]한다
  const addConnection = (e) => {
    e.preventDefault()
    if (addTarget) {
      addDialog.current?.close()
      connectAws(addTarget, () => accountsApi.createAws(label.trim()))
      return
    }
    run(async () => {
      const created = await accountsApi.createConnection(label)
      addDialog.current?.close()
      setShownBlock(created.c_id)
      await load()
    })
  }

  // AWS 상자의 [계정 추가] - 블록에 계정이 없으면 블록 이름으로 바로 연결을 시작하고(블록에 이어진다), 이미 있으면 새 계정의 이름부터 묻는다
  const addAws = (block) => {
    if (!block.aws) return connectAws(block.c_id, () => accountsApi.createConnectionAws(block.c_id))

    setAddTarget(block.c_id)
    setLabel('')
    setError('')
    addDialog.current?.showModal()
  }

  // AWS 연결 시작 - 안내 창은 클릭 처리 안에서 바로 열어야 팝업 차단에 안 걸린다. 값은 서버 응답을 받은 뒤 보낸다
  const connectAws = async (c_id, create) => {
    const guide = openGuideWindow('aws')
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const created = await create()
      // 다른 계정을 넘겨 보던 중이었어도 방금 만든 계정이 보이게 한다
      setView((prev) => ({ ...prev, [`${c_id}:aws`]: created.a_id }))

      if (guide) {
        guideSetup.current = created
        guide.postMessage({ type: 'dw-guide-setup', setup: created }, window.location.origin)
      } else {
        // 팝업이 차단됐다 - 이 창 안에서 안내한다
        setRoleArn('')
        setSetup(created)
        newDialog.current?.showModal()
      }
      await load()
    } catch (e) {
      guide?.close()
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  // 대기 중인 연결 이어서 하기 - 안내 창을 닫았어도 스택을 이미 만들었으면 RoleArn만 넣으면 된다
  const openResumeDialog = (account) => {
    setSetup({ a_id: account.a_id, label: account.label, resume: true })
    setRoleArn('')
    setError('')
    newDialog.current?.showModal()
  }

  const attachRole = (e) => {
    e.preventDefault()
    run(async () => {
      await accountsApi.attachRole(setup.a_id, roleArn.trim())
      newDialog.current?.close()
      await load()
      await announceAws(setup.a_id)
    })
  }

  // [다시 확인]·[연결 확인] - 역할을 다시 빌려 보고 결과를 알린다
  const verifyAws = async (a_id) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await accountsApi.reverifyAws(a_id)
      await load()
      await announceAws(a_id)
    } catch (e) {
      setError(e.message)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const verifyGithub = async (g_id) => {
    setBusy(true)
    setError('')
    setNotice('')
    await announceGithub(g_id)
    setBusy(false)
  }

  // GitHub 상자의 [계정 추가] - 안내 창을 먼저 띄우고(클릭 처리 안에서), 이 창은 GitHub 설치 화면으로 간다
  // 설치가 끝나면 GitHub가 이 창을 연결 화면으로 돌려보내고, 서버가 그 설치를 이 블록에 잇는다
  const connectGithub = async (c_id) => {
    const guide = openGuideWindow('github')
    setBusy(true)
    setError('')
    try {
      const { url } = await accountsApi.getGithubInstallUrl(c_id)
      window.location.href = url
    } catch (e) {
      guide?.close()
      setError(e.message)
      setBusy(false)
    }
  }

  // 이미 연결한 GitHub를 이 블록에 잇거나(g_id), 뗀다(null). 설치 자체는 그대로다
  const setGithub = (c_id, g_id) => run(async () => {
    await accountsApi.setConnectionGithub(c_id, g_id)
    await load()
  })

  // 이미 연결한 AWS 계정을 이 블록에 잇거나(a_id), 뗀다(null). 계정 연결 자체는 그대로다
  const setAws = (c_id, a_id) => run(async () => {
    await accountsApi.setConnectionAws(c_id, a_id)
    await load()
  })

  // 상자에 지금 보이는 계정 - 넘겨 본 것이 있으면 그것, 없으면 이 블록이 쓰는 것, 그것도 없으면 첫 번째
  const shown = (list, idKey, viewKey, pickedId) => {
    const wanted = view[viewKey] ?? pickedId
    const index = Math.max(0, list.findIndex((item) => item[idKey] === wanted))
    return { index, item: list[index] || null }
  }

  // 화살표 - 연결해 둔 계정을 한 칸씩 넘긴다 (끝에서 처음으로 돈다)
  const move = (list, idKey, viewKey, index, step) => {
    const next = list[(index + step + list.length) % list.length]
    setView((prev) => ({ ...prev, [viewKey]: next[idKey] }))
  }

  // 블록 화살표 - 블록을 한 칸씩 넘긴다 (끝에서 처음으로 돈다)
  const moveBlock = (index, step) => setShownBlock(connections[(index + step + connections.length) % connections.length].c_id)

  // 블록 [선택] - 새 배포 폼이 이 블록을 미리 골라 둔다
  const pickBlock = (c_id) => {
    writePickedBlock(c_id)
    setPickedBlock(c_id)
  }

  // AWS [연결 해제] - 다른 블록도 쓰는 계정이면 이 블록에서만 떼고, 이 블록만 쓰거나 어느 블록도 안 쓰는 계정이면 확인을 받고 연결을 지운다
  const releaseAws = (block, account) => {
    const users = connections.filter((item) => item.aws?.a_id === account.a_id)
    if (users.length > 1) setAws(block.c_id, null)
    else confirmDelete('aws', account.a_id)
  }

  const openUpdateDialog = (account) => {
    setUpdateInfo({ ...templateStatus[account.a_id], label: account.label, checked: false })
    setError('')
    updateDialog.current?.showModal()
  }

  // [업데이트 확인] - 스택을 업데이트했는지 다시 읽는다. 됐으면 닫고, 아니면 창 안에서 알려준다
  const checkUpdate = () => run(async () => {
    const next = await accountsApi.getTemplateStatus(updateInfo.a_id)
    setTemplateStatus((prev) => ({ ...prev, [next.a_id]: next }))

    if (next.update_needed) {
      setUpdateInfo((prev) => ({ ...prev, ...next, checked: true }))
    } else {
      updateDialog.current?.close()
      setNotice('스택이 최신 템플릿으로 업데이트되었습니다.')
    }
  })

  const confirmCleanup = (a_id) => {
    cleanupTarget.current = a_id
    cleanupDialog.current?.showModal()
  }

  // 콘솔에 올렸던 템플릿 파일 지우기 - 사용자 계정 S3 에 남은 것. 연결과 스택은 그대로다
  const cleanupTemplateFiles = () => {
    cleanupDialog.current?.close()
    setNotice('')
    run(async () => {
      const { deleted } = await accountsApi.deleteTemplateFiles(cleanupTarget.current)
      setNotice(deleted > 0
        ? `올렸던 템플릿 파일 ${deleted}개를 삭제했습니다. 스택과 연결은 그대로라 다시 등록할 것은 없습니다.`
        : '지울 템플릿 파일이 없습니다. 이미 깨끗합니다.')
      // 지운 뒤 상태를 다시 읽어 버튼과 "남은 파일" 표시를 바꾼다
      await loadTemplateStatus(connections || [])
    })
  }

  const confirmDelete = (kind, id) => {
    setDeleteInfo({ kind, id })
    deleteDialog.current?.showModal()
  }

  const remove = () => {
    deleteDialog.current?.close()
    run(async () => {
      if (deleteInfo.kind === 'block') await accountsApi.deleteConnection(deleteInfo.id)
      else await accountsApi.deleteAws(deleteInfo.id)
      await load()
    })
  }

  // 지금 보이는 블록 - 넘겨 본 것이 있으면 그것, 없으면 [선택]한 블록, 그것도 없으면 첫 번째
  const blockIndex = Math.max(0, (connections || []).findIndex((item) => item.c_id === (shownBlock ?? pickedBlock)))

  return (
    <>
      {error && <div className="notice err" style={{ marginBottom: 16 }}>{error}</div>}
      {notice && <div className="notice ok" style={{ marginBottom: 16 }}>{notice}</div>}

      <div className="row spread" style={{ marginBottom: 12 }}>
        <h1 className="page-title">계정 연결</h1>
        {connections?.length === 0 && <button className="primary" onClick={openAddDialog} disabled={busy}>＋ 블록 추가</button>}
      </div>

      <p className="muted" style={{ marginTop: 0 }}>
        블록 하나에 AWS 계정 하나와 GitHub 하나를 묶어 연결합니다. 한 번 연결해 두면 그 블록으로 몇 개든 배포할 수 있어 보통 블록 하나면 충분합니다. 다른 AWS 계정에도 배포할 때만 블록을 추가하세요.
        {connections && connections.length === 0 && ' 아직 블록이 없습니다 — 위 [＋ 블록 추가]로 시작하세요. 연결 없이도 public 레포는 개발용 계정으로 배포됩니다.'}
      </p>

      {connections?.slice(blockIndex, blockIndex + 1).map((block) => {
        // 블록이 하나뿐이면 고를 것도 없이 그 블록이 쓰인다 (AccountPicker 와 같은 규칙)
        const blockPicked = connections.length === 1 || block.c_id === pickedBlock
        const awsKey = `${block.c_id}:aws`
        const githubKey = `${block.c_id}:github`
        const { index: awsIndex, item: account } = shown(awsAccounts, 'a_id', awsKey, block.aws?.a_id)
        const { index: githubIndex, item: github } = shown(installations, 'g_id', githubKey, block.github?.g_id)
        // 지금 보이는 계정이 이 블록이 쓰는 계정인가 - 아니면 넘겨 보는 중이라 [선택]을 누를 수 있다
        const awsPicked = !!account && account.a_id === block.aws?.a_id
        const githubPicked = !!github && github.g_id === block.github?.g_id
        // 어느 블록도 안 쓰는 계정 - 넘겨 보는 중에도 [연결 해제]로 지울 수 있다
        const awsUnused = !!account && !connections.some((item) => item.aws?.a_id === account.a_id)
        const state = account ? templateStatus[account.a_id] : null

        return (
          <section key={block.c_id} className="card">
            <div className="row spread" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>{block.label}</h2>
              <div className="row">
                <button className="primary" onClick={openAddDialog} disabled={busy}>＋ 블록 추가</button>
                <button className="danger" onClick={() => confirmDelete('block', block.c_id)} disabled={busy}>블록 삭제</button>
              </div>
            </div>

            <div className="account-boxes">
              <AccountBox
                title="AWS 계정"
                badge={awsPicked
                  ? { text: AWS_STATUS_LABEL[account.status] || account.status, tone: account.status === 'verified' ? 'ok' : account.status === 'invalid' ? 'err' : '' }
                  : { text: '연결 안 됨', tone: '' }}
                count={awsAccounts.length}
                index={awsIndex}
                onMove={(step) => move(awsAccounts, 'a_id', awsKey, awsIndex, step)}
                picked={awsPicked}
                onPick={() => setAws(block.c_id, account.a_id)}
                busy={busy}
                left={<button className={block.aws ? '' : 'primary'} onClick={() => addAws(block)} disabled={busy}>계정 추가</button>}
                center={account?.status === 'pending'
                  ? <button onClick={() => openResumeDialog(account)} disabled={busy}>역할 ARN 입력</button>
                  : <button onClick={() => verifyAws(account.a_id)} disabled={busy || !account}>{account?.status === 'invalid' ? '다시 확인' : '연결 확인'}</button>}
                right={<button className="danger" onClick={() => releaseAws(block, account)} disabled={busy || !(awsPicked || awsUnused)}>연결 해제</button>}
              >
                {account && (
                  <>
                    <div className="deploy-name">{account.label}</div>
                    <div className="deploy-meta">
                      {account.aws_account_id ? `계정 ${account.aws_account_id}` : '역할 미등록 — 스택을 만들고 RoleArn을 넣으면 연결됩니다'}
                      {account.role_arn && ` · ${account.role_arn.split('/').pop()}`}
                    </div>
                  </>
                )}
                {!block.aws && <div className="deploy-meta">이 블록은 아직 AWS 연결 전입니다. 연결하지 않으면 개발용 계정으로 배포됩니다.</div>}
                {state && !state.update_needed && (
                  <div className="deploy-meta">
                    템플릿 최신 (버전 {state.current_version})
                    {' · '}
                    {state.template_file_count > 0 ? `S3에 올린 템플릿 파일 ${state.template_file_count}개 남음` : 'S3에 남은 템플릿 파일 없음'}
                  </div>
                )}
                {account?.status === 'invalid' && account.last_error && (
                  <div className="notice err" style={{ marginTop: 6 }}>{account.last_error}</div>
                )}
                {state?.update_needed && (
                  <div className="notice warn" style={{ marginTop: 6 }}>
                    <strong>스택 업데이트 필요</strong> — 새 기능에 필요한 권한이 템플릿에 추가됐습니다. 업데이트 전에는 템플릿 파일 삭제, 배포 삭제 시 이미지 정리 같은 일부 기능이 AWS에서 거부됩니다.
                  </div>
                )}
                {(state?.update_needed || state?.template_file_count > 0) && (
                  <div className="row">
                    {state.update_needed && <button className="primary" onClick={() => openUpdateDialog(account)} disabled={busy}>스택 업데이트</button>}
                    {state.template_file_count > 0 && <button onClick={() => confirmCleanup(account.a_id)} disabled={busy}>템플릿 파일 삭제</button>}
                  </div>
                )}
              </AccountBox>

              <AccountBox
                title="GitHub 계정"
                badge={githubPicked
                  ? { text: GITHUB_STATUS_LABEL[github.status] || github.status, tone: github.status === 'active' ? 'ok' : 'err' }
                  : { text: '연결 안 됨', tone: '' }}
                count={installations.length}
                index={githubIndex}
                onMove={(step) => move(installations, 'g_id', githubKey, githubIndex, step)}
                picked={githubPicked}
                onPick={() => setGithub(block.c_id, github.g_id)}
                busy={busy}
                left={<button className={block.github ? '' : 'primary'} onClick={() => connectGithub(block.github ? null : block.c_id)} disabled={busy}>계정 추가</button>}
                center={<button onClick={() => verifyGithub(github.g_id)} disabled={busy || !github}>연결 확인</button>}
                right={<button className="danger" onClick={() => setGithub(block.c_id, null)} disabled={busy || !githubPicked}>연결 해제</button>}
              >
                {github && (
                  <>
                    <div className="deploy-name">{github.account_login}</div>
                    <div className="deploy-meta">
                      {github.account_type === 'Organization' ? '조직' : '개인'}
                      {' · '}{github.repository_selection === 'all' ? '전체 레포' : '선택한 레포'}
                    </div>
                  </>
                )}
                {!block.github && <div className="deploy-meta">이 블록은 아직 GitHub 연결 전입니다. 연결하지 않으면 public 레포만 배포할 수 있습니다.</div>}
              </AccountBox>
            </div>

            <div className="block-pick">
              <button className="account-arrow" onClick={() => moveBlock(blockIndex, -1)} disabled={busy || connections.length < 2} aria-label="이전 블록">‹</button>
              <div className="account-choose">
                <span className="muted small">{blockIndex + 1} / {connections.length}</span>
                <button className={blockPicked ? '' : 'primary'} onClick={() => pickBlock(block.c_id)} disabled={busy || blockPicked}>{blockPicked ? '선택됨' : '선택'}</button>
                <span className="muted small">선택한 블록이 새 배포에서 미리 골라집니다.</span>
              </div>
              <button className="account-arrow" onClick={() => moveBlock(blockIndex, 1)} disabled={busy || connections.length < 2} aria-label="다음 블록">›</button>
            </div>
          </section>
        )
      })}

      <dialog ref={addDialog}>
        <form onSubmit={addConnection}>
          <h2 style={{ marginTop: 0 }}>{addTarget ? 'AWS 계정 추가' : '연결 블록 추가'}</h2>
          <p className="muted small">
            {addTarget
              ? '새로 연결할 AWS 계정을 구분할 이름을 정하세요. [다음]을 누르면 안내 창이 뜹니다. 연결을 마친 뒤 상자에서 화살표로 찾아 [선택]하면 이 블록에 이어집니다.'
              : '이 블록을 구분할 이름을 정하세요 (서비스 이름이 아닙니다). 블록이 만들어지면 그 안에서 AWS와 GitHub를 하나씩 연결합니다.'}
          </p>
          <input className="grow" placeholder="예: 운영 계정" value={label} onChange={(e) => setLabel(e.target.value)} required autoFocus />
          {error && <div className="notice err">{error}</div>}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" onClick={() => addDialog.current?.close()}>취소</button>
            <button className="primary" type="submit" disabled={busy || !label.trim()}>{addTarget ? '다음' : '추가'}</button>
          </div>
        </form>
      </dialog>

      <dialog ref={newDialog} className={setup && !setup.resume ? 'wide' : ''}>
        {setup && (
          <form onSubmit={attachRole}>
            <h2 style={{ marginTop: 0 }}>역할 만들고 붙여넣기 — {setup.label}</h2>
            {setup.resume ? (
              <p className="muted small">ExternalId는 처음 한 번만 보여주기 때문에 다시 볼 수 없습니다. 스택을 이미 만들었다면 [출력] 탭의 RoleArn을 아래에 붙여넣으세요. 아직 안 만들었다면 이 블록의 AWS 연결을 해제하고 새로 시작하세요.</p>
            ) : (
              <AwsStackGuide setup={setup} />
            )}
            <div className="guide-step">
              <div className="guide-num">{setup.resume ? 1 : 7}</div>
              <div>
                <h3>RoleArn 붙여넣고 [확인]</h3>
                <div className="row">
                  <input className="grow" placeholder="arn:aws:iam::...:role/DeployWizardCrossAccountRole" value={roleArn} onChange={(e) => setRoleArn(e.target.value)} required />
                </div>
              </div>
            </div>
            {error && <div className="notice err">{error}</div>}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" onClick={() => newDialog.current?.close()}>나중에</button>
              <button className="primary" type="submit" disabled={busy || !roleArn}>확인</button>
            </div>
          </form>
        )}
      </dialog>

      <dialog ref={updateDialog} className="wide">
        {updateInfo && (
          <>
            <h2 style={{ marginTop: 0 }}>스택 업데이트가 필요합니다 — {updateInfo.label}</h2>
            <AwsStackUpdateGuide info={updateInfo} />
            {updateInfo.checked && <div className="notice warn">아직 예전 버전({updateInfo.current_version})입니다. 스택 상태가 UPDATE_COMPLETE 인지 확인한 뒤 다시 눌러 주세요.</div>}
            {error && <div className="notice err">{error}</div>}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => updateDialog.current?.close()}>나중에</button>
              <button className="primary" onClick={checkUpdate} disabled={busy}>업데이트 확인</button>
            </div>
          </>
        )}
      </dialog>

      <dialog ref={cleanupDialog}>
        <h2 style={{ marginTop: 0 }}>올렸던 템플릿 파일을 지울까요?</h2>
        <p>스택을 만들 때 콘솔에 올린 <code>deploy_wizard_role.yaml</code>이 내 AWS 계정의 S3에 남아 있습니다. 그 파일만 지웁니다. 버킷과 다른 파일은 건드리지 않습니다.</p>
        <p className="muted small">지워도 다시 등록할 필요는 없습니다. 이 파일은 올릴 때 쓴 사본일 뿐이고, 스택은 템플릿 내용을 따로 보관하고 있어 연결이 그대로 유지됩니다. 나중에 스택을 업데이트할 때는 최신 템플릿을 새로 올리면 됩니다.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={() => cleanupDialog.current?.close()}>그대로 두기</button>
          <button className="danger" onClick={cleanupTemplateFiles}>삭제</button>
        </div>
      </dialog>

      <dialog ref={deleteDialog}>
        {deleteInfo && (
          <>
            <h2 style={{ marginTop: 0 }}>{DELETE_TEXT[deleteInfo.kind].title}</h2>
            <p>{DELETE_TEXT[deleteInfo.kind].body}</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => deleteDialog.current?.close()}>그대로 두기</button>
              <button className="danger" onClick={remove}>{deleteInfo.kind === 'block' ? '블록 삭제' : '연결 해제'}</button>
            </div>
          </>
        )}
      </dialog>
    </>
  )
}
