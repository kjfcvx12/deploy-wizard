import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { accountApi } from '../../api'
import { AWS_STATUS_LABEL, CLEANUP_TEXT, DELETE_TEXT } from '../../accounts/constants'
import { awsVerifiedNotice, cleanupNotice, STACK_UPDATED_NOTICE } from '../../accounts/notices'
import { confirmAction } from '../../confirm'
import { monoFont, radius, spacing, useColors, wrapAnywhere } from '../../theme'
import { Button, Notice } from '../ui'
import AwsGuide from './AwsGuide'
import AwsUpdateGuide from './AwsUpdateGuide'
import ExistingPicker from './ExistingPicker'

// 블록에 이어지지 않은 새 계정을 등록했을 때 알림에 덧붙이는 앱 전용 안내 (웹은 화살표로 넘겨 본다)
const PICK_HINT = ' — 이 블록에 쓰려면 [이미 연결한 계정에서 고르기]로 고르세요'

// 연결 블록 안의 AWS 상자 (웹 AccountsPage 의 AWS AccountBox) - 연결 안내·역할 ARN·재확인·업데이트·템플릿 파일 정리·해제·기존 계정 고르기
// run/reload/setNotice/busy 는 화면(AccountsScreen)이 주고, connections 는 해제할 때 다른 블록이 같은 계정을 쓰는지 보려고 받는다
export default function AwsBox({ block, connections, awsAccounts, templateStatus, busy, run, reload, setNotice }) {
  const colors = useColors()
  const account = block.aws
  const state = account ? templateStatus?.[account.a_id] : null
  // 안내(ExternalId 가 든 setup 은 여기 상태에만 있고 안내를 닫으면 비운다), 안내 안의 오류, 새 계정 이름 폼, 업데이트 안내, 고르기 창
  const [guide, setGuide] = useState(null)
  const [guideError, setGuideError] = useState('')
  const [naming, setNaming] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [update, setUpdate] = useState(null)
  const [updateError, setUpdateError] = useState('')
  const [picking, setPicking] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  // 이 블록이 쓰지 않는 AWS 계정들 - 고르기 목록
  const others = (awsAccounts || []).filter((item) => item.a_id !== account?.a_id)

  // 연결 시작 - 계정을 만들어 안내를 열고 목록을 다시 받는다. linked 는 만든 계정이 이 블록에 이어졌는가
  const connect = (create, linked) => run(async () => {
    const created = await create()
    if (!alive.current) return
    setGuideError('')
    setGuide({ setup: created, resume: false, linked })
    await reload()
  })

  // 계정 추가 - 블록에 계정이 없으면 블록 이름으로 바로 시작하고, 있으면 새 계정의 이름부터 묻는다
  const add = () => {
    if (!account) connect(() => accountApi.createConnectionAws(block.c_id), true)
    else { setNewLabel(''); setNaming(true) }
  }

  // 이름 폼의 다음 - 공백을 지운 이름으로 새 계정을 만든다 (블록에는 잇지 않는다)
  const submitName = () => {
    const name = newLabel.trim()
    if (busy || !name) return
    setNaming(false)
    connect(() => accountApi.createAws(name), false)
  }

  // 대기 중인 연결 이어서 하기 - ExternalId 없이 RoleArn 만 받는다
  const resume = () => {
    setGuideError('')
    setGuide({ setup: { a_id: account.a_id, label: account.label }, resume: true, linked: true })
  }

  // 연결 확인됨 알림 - 계정 정보와 템플릿 상태. 이 블록에 안 이어진 새 계정이면 잇는 방법을 덧붙인다
  const announce = async (done, linked) => {
    if (done.status !== 'verified') return
    const current = await accountApi.getTemplateStatus(done.a_id)
    setNotice(awsVerifiedNotice(done, current) + (linked ? '' : PICK_HINT))
  }

  // 역할 ARN 등록 - 거절되면 안내 안에 메시지를 보이고 안내를 그대로 둔다. 되면 안내를 닫아 ExternalId 를 비운다
  const attach = (arn) => run(async () => {
    const { setup, linked } = guide
    let done
    try {
      done = await accountApi.attachRole(setup.a_id, arn)
    } catch (e) {
      if (alive.current) setGuideError(e.message)
      return
    }
    if (!alive.current) return
    setGuideError('')
    setGuide(null)
    await reload()
    await announce(done, linked)
  })

  // 연결 확인·다시 확인 - 역할을 다시 빌려 보고 결과를 알린다. 실패해도 목록은 다시 받는다
  const verify = () => {
    run(async () => {
      try {
        const done = await accountApi.reverifyAws(account.a_id)
        await reload()
        await announce(done, true)
      } catch (e) {
        await reload()
        throw e
      }
    })
  }

  // 연결 해제 - 다른 블록도 쓰는 계정이면 이 블록에서만 떼고, 아니면 확인을 받고 연결을 지운다
  const release = () => {
    const users = (connections || []).filter((item) => item.aws?.a_id === account.a_id)
    if (users.length > 1) {
      run(async () => {
        await accountApi.setConnectionAws(block.c_id, null)
        await reload()
      })
      return
    }
    confirmAction({
      title: DELETE_TEXT.aws.title,
      message: DELETE_TEXT.aws.body,
      cancelText: '그대로 두기',
      confirmText: '연결 해제',
      onConfirm: () => {
        run(async () => {
          await accountApi.deleteAws(account.a_id)
          await reload()
        })
      },
    })
  }

  // 스택 업데이트 안내 열기
  const openUpdate = () => {
    setUpdateError('')
    setUpdate({ ...state, label: account.label, checked: false })
  }

  // 업데이트 확인 - 최신이 됐으면 닫고 알리고, 아니면 안내 안에서 알린다
  const checkUpdate = () => {
    run(async () => {
      let next
      try {
        next = await accountApi.getTemplateStatus(update.a_id)
      } catch (e) {
        if (alive.current) setUpdateError(e.message)
        return
      }
      if (!alive.current) return
      setUpdateError('')
      if (next.update_needed) {
        setUpdate((prev) => ({ ...prev, ...next, checked: true }))
        return
      }
      setUpdate(null)
      setNotice(STACK_UPDATED_NOTICE)
      await reload()
    })
  }

  // 올렸던 템플릿 파일 삭제 - 확인 뒤에만. 내 AWS 계정 S3 의 사본만 지우고 연결과 스택은 그대로다
  const cleanup = () => confirmAction({
    title: CLEANUP_TEXT.title,
    message: CLEANUP_TEXT.body,
    cancelText: '그대로 두기',
    confirmText: '삭제',
    onConfirm: () => {
      run(async () => {
        const { deleted } = await accountApi.deleteTemplateFiles(account.a_id)
        setNotice(cleanupNotice(deleted))
        await reload()
      })
    },
  })

  // 이미 연결한 계정을 이 블록에 잇는다
  const pickExisting = (item) => {
    setPicking(false)
    run(async () => {
      await accountApi.setConnectionAws(block.c_id, item.key)
      await reload()
    })
  }

  const tone = account?.status === 'verified' ? 'ok' : account?.status === 'invalid' ? 'err' : 'none'
  const badgeColors = { ok: [colors.okBg, colors.ok], err: [colors.errBg, colors.err], none: [colors.surface2, colors.muted] }[tone]
  const L = block.label

  return (
    <View testID={`aws-box-${block.c_id}`} style={[styles.box, { borderColor: colors.border, backgroundColor: colors.bg }]}>
      <View style={styles.head}>
        <Text style={[styles.name, { color: colors.text }]}>AWS 계정</Text>
        <View style={[styles.badge, { backgroundColor: badgeColors[0] }]}>
          <Text style={[styles.badgeText, { color: badgeColors[1] }]}>{account ? (AWS_STATUS_LABEL[account.status] || account.status) : '연결 안 됨'}</Text>
        </View>
      </View>

      {account ? (
        <View style={styles.info}>
          <Text style={[styles.label, wrapAnywhere, { color: colors.text }]}>{account.label}</Text>
          <Text style={[styles.meta, wrapAnywhere, { color: colors.muted }]}>
            {account.aws_account_id ? `계정 ${account.aws_account_id}` : '역할 미등록 — 스택을 만들고 RoleArn을 넣으면 연결됩니다'}
          </Text>
          {!!account.role_arn && <Text selectable style={[styles.arn, wrapAnywhere, { color: colors.muted, fontFamily: monoFont }]}>{account.role_arn}</Text>}
        </View>
      ) : (
        <Text style={[styles.meta, { color: colors.muted }]}>이 블록은 아직 AWS 연결 전입니다. 연결하지 않으면 개발용 계정으로 배포됩니다.</Text>
      )}

      {!!state && !state.update_needed && (
        <Text style={[styles.meta, { color: colors.muted }]}>
          {`템플릿 최신 (버전 ${state.current_version}) · ${state.template_file_count > 0 ? `S3에 올린 템플릿 파일 ${state.template_file_count}개 남음` : 'S3에 남은 템플릿 파일 없음'}`}
        </Text>
      )}
      {account?.status === 'invalid' && !!account.last_error && <Notice>{account.last_error}</Notice>}
      {!!state?.update_needed && (
        <Notice tone="warn">
          <Text style={styles.strong}>스택 업데이트 필요</Text>
          {' — 새 기능에 필요한 권한이 템플릿에 추가됐습니다. 업데이트 전에는 템플릿 파일 삭제, 배포 삭제 시 이미지 정리 같은 일부 기능이 AWS에서 거부됩니다.'}
        </Notice>
      )}

      {naming && (
        <View style={styles.form}>
          <Text accessibilityRole="header" style={[styles.label, { color: colors.text }]}>AWS 계정 추가</Text>
          <Text style={[styles.meta, { color: colors.muted }]}>
            새로 연결할 AWS 계정을 구분할 이름을 정하세요. [다음]을 누르면 안내 창이 뜹니다. 연결을 마친 뒤 [이미 연결한 계정에서 고르기]로 이 블록에 이을 수 있습니다.
          </Text>
          <TextInput
            style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
            placeholder="예: 운영 계정"
            placeholderTextColor={colors.muted}
            value={newLabel}
            onChangeText={setNewLabel}
            onSubmitEditing={submitName}
            returnKeyType="done"
            autoFocus
            accessibilityLabel={`${L} 새 AWS 계정 이름`}
          />
          <View style={styles.row}>
            <Button label="취소" accessibilityLabel={`${L} AWS 계정 추가 취소`} onPress={() => setNaming(false)} disabled={busy} style={styles.grow} />
            <Button label="다음" accessibilityLabel={`${L} AWS 계정 추가 다음`} variant="primary" onPress={submitName} disabled={busy || !newLabel.trim()} style={styles.grow} />
          </View>
        </View>
      )}

      <View style={styles.actions}>
        <Button label="계정 추가" accessibilityLabel={`${L} AWS 계정 추가`} variant={account ? 'default' : 'primary'} onPress={add} disabled={busy} />
        {account?.status === 'pending' && <Button label="역할 ARN 입력" accessibilityLabel={`${L} AWS 역할 ARN 입력`} onPress={resume} disabled={busy} />}
        {!!account && account.status !== 'pending' && (
          <Button
            label={account.status === 'invalid' ? '다시 확인' : '연결 확인'}
            accessibilityLabel={`${L} AWS ${account.status === 'invalid' ? '다시 확인' : '연결 확인'}`}
            onPress={verify}
            disabled={busy}
          />
        )}
        {!!state?.update_needed && <Button label="스택 업데이트" accessibilityLabel={`${L} AWS 스택 업데이트`} variant="primary" onPress={openUpdate} disabled={busy} />}
        {state?.template_file_count > 0 && <Button label="템플릿 파일 삭제" accessibilityLabel={`${L} AWS 템플릿 파일 삭제`} onPress={cleanup} disabled={busy} />}
        {others.length > 0 && <Button label="이미 연결한 계정에서 고르기" accessibilityLabel={`${L} AWS 이미 연결한 계정에서 고르기`} onPress={() => setPicking(true)} disabled={busy} />}
        {!!account && <Button label="연결 해제" accessibilityLabel={`${L} AWS 연결 해제`} variant="danger" onPress={release} disabled={busy} />}
      </View>

      {guide && (
        <AwsGuide setup={guide.setup} resume={guide.resume} busy={busy} error={guideError} onSubmit={attach} onClose={() => setGuide(null)} />
      )}
      {update && (
        <AwsUpdateGuide info={update} busy={busy} error={updateError} onCheck={checkUpdate} onClose={() => setUpdate(null)} />
      )}
      {picking && (
        <ExistingPicker
          title={`${L}에 이을 AWS 계정`}
          items={others.map((item) => ({
            key: item.a_id,
            title: item.label,
            subtitle: `${AWS_STATUS_LABEL[item.status] || item.status} · ${item.aws_account_id ? `계정 ${item.aws_account_id}` : '역할 미등록'}`,
          }))}
          onPick={pickExisting}
          onClose={() => setPicking(false)}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  name: { fontSize: 15, fontWeight: '700' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  badgeText: { fontSize: 12, fontWeight: '700' },
  info: { gap: 2 },
  label: { fontSize: 15, fontWeight: '600' },
  meta: { fontSize: 13, lineHeight: 18 },
  arn: { fontSize: 12, lineHeight: 17 },
  strong: { fontWeight: '700' },
  form: { gap: spacing.sm },
  input: { minHeight: 48, paddingHorizontal: spacing.md, borderWidth: 1, borderRadius: radius.md, fontSize: 15 },
  row: { flexDirection: 'row', gap: spacing.sm },
  grow: { flex: 1 },
  actions: { gap: spacing.sm },
})
