import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Text } from '../Text'
import { accountApi } from '../../api'
import { GITHUB_STATUS_LABEL } from '../../accounts/constants'
import { openLink } from '../../accounts/external'
import { githubCheckNotice } from '../../accounts/notices'
import { radius, spacing, useColors, wrapAnywhere } from '../../theme'
import { Button } from '../ui'
import ExistingPicker from './ExistingPicker'

const OPEN_ERROR = '주소를 열 수 없습니다'

// GitHub 설치 화면을 연 뒤 보이는 안내 - 앱 전용 문구 (웹은 같은 창이 GitHub 로 갔다가 돌아와 이 안내가 없다)
const INSTALL_NOTICE = 'GitHub 설치 화면에서 설치를 마치고 이 앱으로 돌아오세요.'
// 돌아왔는데도 블록에 설치가 없을 때 보이는 안내 - 앱 전용 (웹은 같은 창이 돌아와 콜백이 곧바로 처리된다). 서버의 콜백 주소를 폰이 열 수 없으면 설치가 저장되지 않는다
const NOT_YET_NOTICE = '아직 설치가 확인되지 않았습니다. GitHub 설치를 마쳤는지 확인하고 다시 시도하세요. 서버의 GitHub 앱 콜백 주소를 이 폰에서 열 수 없으면 PC에서 연결해야 합니다.'
// 이미 GitHub 가 이어진 블록에서 새 계정을 설치했을 때 덧붙이는 앱 전용 안내 (새 설치는 블록에 자동으로 이어지지 않는다)
const PICK_HINT = ' 새 계정을 이 블록에 쓰려면 [이미 연결한 계정에서 고르기]로 고르세요.'

// 연결 블록 안의 GitHub 상자 (웹 AccountsPage 의 GitHub AccountBox) - 설치 열기·돌아온 뒤 확인·연결 확인·해제·기존 설치 고르기
// run/reload/setNotice/busy 는 화면(AccountsScreen)이 주고, installations 는 고르기 목록(전체 GitHub 설치)이다
// returnTick 은 앱이 백그라운드에서 돌아와 목록을 다시 받아 마칠 때마다 화면이 하나씩 올리는 번호다
export default function GithubBox({ block, installations, busy, run, reload, setNotice, returnTick = 0 }) {
  const colors = useColors()
  const github = block.github
  const gid = github?.g_id
  const [picking, setPicking] = useState(false)
  // 설치 화면을 열고 돌아오기를 기다리는 중인가 (연결 전 블록에서 [계정 추가]를 눌렀을 때만)
  const awaiting = useRef(false)
  // 안내를 이미 보인 복귀 번호
  const handledTick = useRef(returnTick)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // 이 블록이 쓰지 않는 설치들 - 고르기 목록
  const others = (installations || []).filter((item) => item.g_id !== gid)

  // 연결 확인 - 실제로 접근이 되는지 서버가 다시 물어본 결과를 알린다 (실패하면 run 이 서버 메시지를 보인다)
  const check = (g_id) => {
    run(async () => {
      const result = await accountApi.checkGithub(g_id)
      if (alive.current) setNotice(githubCheckNotice(result))
    })
  }

  // 계정 추가 - 설치 주소를 받아 https 일 때만 브라우저로 연다. 연결 전 블록이면 돌아와 설치가 생기기를 기다린다 (연 뒤가 아니라 열기 전에 기다림을 켠다 - openURL 이 끝나기 전에 돌아와도 알아보게)
  const add = () => {
    run(async () => {
      const linked = !!github
      const { url } = await accountApi.getGithubInstallUrl(linked ? null : block.c_id)
      if (!alive.current) return
      if (!linked) awaiting.current = true
      if (!(await openLink(url))) {
        awaiting.current = false
        throw new Error(OPEN_ERROR)
      }
      if (!alive.current) return
      setNotice(INSTALL_NOTICE + (linked ? PICK_HINT : ''))
    })
  }

  // 기다리던 설치가 이 블록에 생기면(목록을 다시 받은 뒤) 연결 확인을 한 번 한다 - 작업 중이면 끝난 뒤에
  useEffect(() => {
    if (!awaiting.current || !gid || busy) return
    awaiting.current = false
    check(gid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gid, busy])

  // 앱 전용: 기다리다 돌아와 목록을 받았는데도 설치가 없으면 안내를 한 번 보인다 - 기다림은 그대로 두어 다음 복귀에서 마칠 수 있다. 작업 중이면 끝난 뒤에
  useEffect(() => {
    if (returnTick === handledTick.current || busy) return
    handledTick.current = returnTick
    if (awaiting.current && !gid) setNotice(NOT_YET_NOTICE)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnTick, busy])

  // 연결 해제 - 블록에서만 뗀다. 확인은 받지 않고 GitHub 앱 설치는 그대로 둔다 (웹과 같다)
  const release = () => {
    run(async () => {
      await accountApi.setConnectionGithub(block.c_id, null)
      await reload()
    })
  }

  // 이미 연결한 설치를 이 블록에 잇는다 - 작업이 받아들여진 뒤에만 고르기 창을 닫고 기다림을 끝낸다 (다른 작업 중이면 run 이 버리므로 창을 둔다)
  const pickExisting = (item) => {
    run(async () => {
      setPicking(false)
      awaiting.current = false
      await accountApi.setConnectionGithub(block.c_id, item.key)
      await reload()
    })
  }

  const ok = github?.status === 'active'
  const badgeColors = !github ? [colors.surface2, colors.muted] : ok ? [colors.okBg, colors.ok] : [colors.errBg, colors.err]
  const L = block.label

  return (
    <View testID={`github-box-${block.c_id}`} style={[styles.box, { borderColor: colors.border, backgroundColor: colors.bg }]}>
      <View style={styles.head}>
        <Text style={[styles.name, { color: colors.text }]}>GitHub 계정</Text>
        <View style={[styles.badge, { backgroundColor: badgeColors[0] }]}>
          <Text style={[styles.badgeText, { color: badgeColors[1] }]}>{github ? (GITHUB_STATUS_LABEL[github.status] || github.status) : '연결 안 됨'}</Text>
        </View>
      </View>

      {github ? (
        <View style={styles.info}>
          <Text style={[styles.label, wrapAnywhere, { color: colors.text }]}>{github.account_login}</Text>
          <Text style={[styles.meta, { color: colors.muted }]}>
            {`${github.account_type === 'Organization' ? '조직' : '개인'} · ${github.repository_selection === 'all' ? '전체 레포' : '선택한 레포'}`}
          </Text>
        </View>
      ) : (
        <Text style={[styles.meta, { color: colors.muted }]}>이 블록은 아직 GitHub 연결 전입니다. 연결하지 않으면 public 레포만 배포할 수 있습니다.</Text>
      )}

      <View style={styles.actions}>
        <Button label="계정 추가" accessibilityLabel={`${L} GitHub 계정 추가`} variant={github ? 'default' : 'primary'} onPress={add} disabled={busy} />
        {!!github && <Button label="연결 확인" accessibilityLabel={`${L} GitHub 연결 확인`} onPress={() => check(gid)} disabled={busy} />}
        {others.length > 0 && <Button label="이미 연결한 계정에서 고르기" accessibilityLabel={`${L} GitHub 이미 연결한 계정에서 고르기`} onPress={() => setPicking(true)} disabled={busy} />}
        {!!github && <Button label="연결 해제" accessibilityLabel={`${L} GitHub 연결 해제`} variant="danger" onPress={release} disabled={busy} />}
      </View>

      {picking && (
        <ExistingPicker
          title={`${L}에 이을 GitHub 계정`}
          busy={busy}
          items={others.map((item) => ({
            key: item.g_id,
            title: item.account_login,
            subtitle: `${GITHUB_STATUS_LABEL[item.status] || item.status} · ${item.account_type === 'Organization' ? '조직' : '개인'}`,
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
  actions: { gap: spacing.sm },
})
