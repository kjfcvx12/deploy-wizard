import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Stack, useRouter } from 'expo-router'
import { Text } from '../src/components/Text'
import FitScreen from '../src/components/FitScreen'
import { Button, Card, Notice } from '../src/components/ui'
import { authApi } from '../src/api'
import { useAuth } from '../src/auth/AuthProvider'
import { afterLogoutPath, deleteResultView, parseLiveDeploys } from '../src/auth/logic'
import { confirmAction } from '../src/confirm'
import { monoFont, radius, spacing, useColors, wrapAnywhere } from '../src/theme'

const DELETE_DESCRIPTION = '계정과 이 마법사의 기록(배포 기록·연결·알림)을 지웁니다. AWS 의 서비스·CloudFormation 스택·ECR 이미지와 GitHub 앱 설치는 지우지 않습니다. 되돌릴 수 없습니다.'
const DELETE_FAILED_TEXT = '계정을 삭제하지 못했습니다'
const LIVE_GUIDE_TEXT = '먼저 이 서비스들을 멈추거나 삭제한 뒤 다시 시도하세요.'
const ECR_GUIDE_TEXT = 'AWS 콘솔의 ECR 에서 직접 지워 주세요. 요금이 나갈 수 있습니다.'
const COPY_FAILED_TEXT = '저장소 이름을 복사하지 못했습니다'
// 이 화면의 경로 이름 - 결과를 보이는 동안 세션이 지워져도 경로 보호가 로그인 화면으로 보내지 않게 붙들어 둔다
const SEGMENT = 'delete-account'
// 복사됨 표시를 거두는 시간(ms)
const COPIED_MS = 2000
// 결과의 저장소 목록 상자 높이 - 길면 이 상자만 스크롤된다
const LIST_MAX_HEIGHT = 180

// 계정 삭제 화면 - 확인 창(취소가 먼저) 뒤에만 지우고, 서비스를 대신 멈추거나 지우지 않는다. 성공하면 결과를 먼저 보이고 그 뒤에 이 기기의 세션·저장값을 정리한다
export default function DeleteAccountScreen() {
  const colors = useColors()
  const router = useRouter()
  const { config, forgetAfterDelete, holdRoute } = useAuth()
  const [busy, setBusy] = useState(false)
  // 실패 안내 - { message, items: [{ d_id, label }] }
  const [error, setError] = useState(null)
  // 삭제가 끝난 뒤의 결과 - { message, leftovers }
  const [ended, setEnded] = useState(null)
  const [copyState, setCopyState] = useState('idle')
  // 진행 중인 삭제 하나 - 확인 창 버튼을 여러 번 눌러도 한 번만
  const busyRef = useRef(false)
  const alive = useRef(true)
  const release = useRef(null)
  const copyTimer = useRef(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimeout(copyTimer.current)
      release.current?.()
      release.current = null
    }
  }, [])

  // 결과가 그려진 뒤에야 이 기기의 세션·기기 번호·저장값·Google 로그인을 지운다 (먼저 지우면 경로 보호가 결과를 내려 버린다)
  useEffect(() => {
    if (ended) forgetAfterDelete().catch(() => {})
  }, [ended, forgetAfterDelete])

  // 확인 창에서 [삭제]를 눌렀을 때 - 409 는 살아 있는 서비스 목록으로 나누고, 그 밖(403·503·500·연결 실패)은 서버 문구 그대로
  const remove = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const response = await authApi.deleteMe()
      // 요청 중에 화면을 떠났어도 서버는 이미 지웠다 - 이 기기의 정리는 끝까지 한다 (화면이 없으니 붙들 것도, 상태를 바꿀 것도 없고 경로 보호가 로그인 화면으로 보낸다)
      if (!alive.current) {
        forgetAfterDelete().catch(() => {})
        return
      }
      // 세션이 지워져도 이 화면에 머물도록 먼저 붙들어 둔다 (정리는 결과가 그려진 뒤)
      release.current = holdRoute(SEGMENT)
      setEnded(deleteResultView(response))
    } catch (e) {
      busyRef.current = false
      if (!alive.current) return
      const text = typeof e?.message === 'string' && e.message ? e.message : DELETE_FAILED_TEXT
      setError(e?.status === 409 ? parseLiveDeploys(text) : { message: text, items: [] })
      setBusy(false)
    }
  }, [holdRoute, forgetAfterDelete])

  // 계정 삭제 버튼 - 확인 창을 거치지 않는 삭제 경로는 없다
  const askDelete = () => {
    if (busyRef.current) return
    confirmAction({ title: '계정을 삭제할까요?', message: DELETE_DESCRIPTION, cancelText: '취소', confirmText: '삭제', onConfirm: remove })
  }

  // 남은 저장소 이름을 한 줄에 하나씩 복사한다 - false 로 끝나면 복사되지 않은 것이다
  const copyNames = async () => {
    try {
      if ((await Clipboard.setStringAsync(ended.leftovers.join('\n'))) === false) throw new Error('copy failed')
      if (!alive.current) return
      setCopyState('copied')
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopyState('idle'), COPIED_MS)
    } catch {
      if (alive.current) setCopyState('failed')
    }
  }

  if (ended) {
    return (
      <FitScreen testID="delete-account-screen">
        <Stack.Screen options={{ title: '계정 삭제' }} />
        <Card style={styles.stack}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>계정을 삭제했습니다</Text>
          <Text style={[styles.body, wrapAnywhere, { color: colors.text }]}>{ended.message}</Text>
          {ended.leftovers.length > 0 && (
            <>
              <ScrollView
                testID="leftover-list"
                nestedScrollEnabled
                style={[styles.list, { backgroundColor: colors.surface2, borderColor: colors.border }]}
                contentContainerStyle={styles.listContent}
              >
                {ended.leftovers.map((name) => (
                  <Text key={name} selectable style={[styles.mono, wrapAnywhere, { color: colors.text }]}>{name}</Text>
                ))}
              </ScrollView>
              <Button label={copyState === 'copied' ? '복사됨' : '복사'} accessibilityLabel="저장소 이름 복사" onPress={copyNames} style={styles.self} />
              {copyState === 'failed' && <Notice tone="err">{COPY_FAILED_TEXT}</Notice>}
              <Notice tone="warn">{ECR_GUIDE_TEXT}</Notice>
            </>
          )}
          <Button variant="primary" label="처음으로" onPress={() => router.replace(afterLogoutPath(config))} />
        </Card>
      </FitScreen>
    )
  }

  return (
    <FitScreen testID="delete-account-screen">
      <Stack.Screen options={{ title: '계정 삭제' }} />
      <Card style={[styles.stack, { borderColor: colors.err }]}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>계정 삭제</Text>
        <Text style={[styles.body, wrapAnywhere, { color: colors.text }]}>{DELETE_DESCRIPTION}</Text>
        <Button variant="danger" label={busy ? '삭제하는 중…' : '계정 삭제'} disabled={busy} onPress={askDelete} />
      </Card>
      {error && (
        <View accessibilityRole="alert" style={[styles.errorBox, { backgroundColor: colors.errBg }]}>
          <Text style={[styles.body, wrapAnywhere, { color: colors.err }]}>{error.message}</Text>
          {error.items.length > 0 && (
            <>
              {error.items.map((item) => (
                <Pressable
                  key={item.d_id}
                  accessibilityRole="button"
                  onPress={() => router.push(`/deploys/${item.d_id}`)}
                  style={({ pressed }) => [styles.item, { borderColor: colors.err, opacity: pressed ? 0.7 : 1 }]}
                >
                  <Text style={[styles.itemText, wrapAnywhere, { color: colors.err }]}>{`#${item.d_id} ${item.label}`}</Text>
                </Pressable>
              ))}
              <Text style={[styles.body, { color: colors.err }]}>{LIVE_GUIDE_TEXT}</Text>
            </>
          )}
        </View>
      )}
    </FitScreen>
  )
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },
  title: { fontSize: 18, lineHeight: 26, fontWeight: '700' },
  body: { fontSize: 14, lineHeight: 21 },
  errorBox: { padding: spacing.lg, borderRadius: radius.md, gap: spacing.sm },
  item: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderWidth: 1, borderRadius: radius.md },
  itemText: { fontSize: 15, fontWeight: '700' },
  list: { maxHeight: LIST_MAX_HEIGHT, borderWidth: 1, borderRadius: radius.md },
  listContent: { padding: spacing.md, gap: spacing.xs },
  mono: { fontFamily: monoFont, fontSize: 13, lineHeight: 19 },
  self: { alignSelf: 'flex-start' },
})
