import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import { notificationApi } from '../src/api'
import PushPermissionGuide from '../src/components/ops/PushPermissionGuide'
import SettingSwitch from '../src/components/SettingSwitch'
import { Button, Notice } from '../src/components/ui'
import { useOnForeground } from '../src/hooks/useOnForeground'
import { NOTIFICATION_KIND_LABEL, NOTIFICATION_KINDS } from '../src/ops/constants'
import { KIND_HINT, MAIL_HINT, PUSH_HINT, readValues } from '../src/ops/notificationSettings'
import { getPushState, requestAndRegister, unregister } from '../src/ops/push'
import { spacing, useColors } from '../src/theme'

const SAVED_TEXT = '저장했습니다'
// 저장 안내가 떠 있는 시간(ms)
const SAVED_MS = 3000

// 알림 설정 화면 (S-15 로그인 없이) - 스위치를 누르면 저장 버튼 없이 바로 반영하고, 실패하면 되돌린다
export default function NotificationSettingsScreen() {
  const colors = useColors()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const scrollRef = useRef(null)
  const alive = useRef(false)
  const loadSeq = useRef(0)
  const valuesRef = useRef(null)
  const busyRef = useRef({})
  const timerRef = useRef(null)

  const [values, setValues] = useState(null)
  const [pushState, setPushState] = useState(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [busy, setBusy] = useState({})
  const [message, setMessage] = useState(null)

  // 화면이 살아 있는 동안만 상태를 바꾼다 - 닫힌 뒤 늦게 오는 응답과 안내 타이머는 버린다
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimeout(timerRef.current)
    }
  }, [])

  // 설정과 이 기기의 푸시 상태를 한 번 받는다 (폴링 없음) - 다시 시도도 이 함수. 푸시 상태 읽기는 권한 창을 띄우지 않는다
  const load = useCallback(async () => {
    const mine = ++loadSeq.current
    setLoading(true)
    setLoadError(null)
    try {
      const [settings, push] = await Promise.all([notificationApi.getSettings(), getPushState()])
      if (!alive.current || mine !== loadSeq.current) return
      valuesRef.current = readValues(settings)
      setValues(valuesRef.current)
      setPushState(push)
    } catch (e) {
      if (alive.current && mine === loadSeq.current) setLoadError(e)
    } finally {
      if (alive.current && mine === loadSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // OS 설정에서 알림을 켜고 돌아오면 상태를 다시 읽는다
  useOnForeground(async () => {
    const next = await getPushState()
    if (!alive.current) return
    setPushState(next)
    if (next === 'granted') setGuideOpen(false)
  })

  // 실패나 안내가 생기면 맨 위로 올려 보여 준다
  useEffect(() => {
    if (message) scrollRef.current?.scrollTo?.({ y: 0, animated: true })
  }, [message])

  // 같은 스위치(묶음)가 응답을 기다리는 동안은 다시 누를 수 없다 - 종류 스위치는 목록 전체를 한 번에 보내므로 한 묶음이다
  const lock = (key, on) => {
    busyRef.current[key] = on
    if (alive.current) setBusy((b) => ({ ...b, [key]: on }))
  }
  const setLocal = (patch) => {
    valuesRef.current = { ...valuesRef.current, ...patch }
    setValues(valuesRef.current)
  }
  const showSaved = () => {
    setMessage({ tone: 'info', text: SAVED_TEXT })
    timerRef.current = setTimeout(() => { if (alive.current) setMessage(null) }, SAVED_MS)
  }

  // 값을 먼저 바꿔 보이고 서버에 보낸다 - 실패하면 이전 값으로 되돌리고 서버 메시지를 보인다. 성공하면 true
  const save = async (key, patch, body) => {
    if (busyRef.current[key] || !valuesRef.current) return false
    const previous = Object.fromEntries(Object.keys(patch).map((field) => [field, valuesRef.current[field]]))
    lock(key, true)
    clearTimeout(timerRef.current)
    setLocal(patch)
    setMessage(null)
    try {
      await notificationApi.patchSettings(body)
      if (alive.current) showSaved()
      return true
    } catch (e) {
      if (alive.current) {
        setLocal(previous)
        setMessage({ tone: 'err', text: e.message })
      }
      return false
    } finally {
      lock(key, false)
    }
  }

  const toggleMail = () => { save('notify_email', { notify_email: !valuesRef.current?.notify_email }, { notify_email: !valuesRef.current?.notify_email }) }

  const toggleKind = (kind) => {
    if (!valuesRef.current) return
    const has = valuesRef.current.kinds.includes(kind)
    const kinds = NOTIFICATION_KINDS.filter((k) => (k === kind ? !has : valuesRef.current.kinds.includes(k)))
    save('kinds', { kinds }, { kinds })
  }

  // 푸시 끄기 - 서버 설정을 먼저 끄고(실패하면 되돌림), 된 뒤에 이 기기의 등록을 지운다
  const disablePush = async () => {
    if (await save('notify_push', { notify_push: false }, { notify_push: false })) await unregister()
  }

  // 푸시 켜기 - 버튼을 누른 뒤에만 부른다: 권한(필요하면 OS 창) → 기기 등록 → 서버 설정 켬. 서버 설정이 실패하면 방금 한 등록을 지운다
  const enablePush = async () => {
    if (busyRef.current.notify_push || !valuesRef.current) return
    lock('notify_push', true)
    clearTimeout(timerRef.current)
    setMessage(null)
    try {
      const next = await requestAndRegister()
      if (!alive.current) return
      setPushState(next)
      if (next !== 'granted') {
        setGuideOpen(true)
        return
      }
      try {
        await notificationApi.patchSettings({ notify_push: true })
      } catch (e) {
        await unregister()
        if (alive.current) setMessage({ tone: 'err', text: e.message })
        return
      }
      if (!alive.current) return
      setLocal({ notify_push: true })
      setGuideOpen(false)
      showSaved()
    } catch (e) {
      if (alive.current) setMessage({ tone: 'err', text: e.message })
    } finally {
      lock('notify_push', false)
    }
  }

  // 푸시 스위치 - 켜져 있으면 끄고, 꺼져 있으면 이미 허용된 기기만 바로 켜고 나머지는 안내를 먼저 보인다 (권한 창은 안내의 [알림 켜기]에서)
  const togglePush = () => {
    if (busyRef.current.notify_push || !valuesRef.current) return
    if (valuesRef.current.notify_push) disablePush()
    else if (pushState === 'granted') enablePush()
    else setGuideOpen(true)
  }

  // 돌아간다 - 아래 화면이 없으면(주소로 바로 들어온 경우) 목록으로
  const leave = () => { if (router.canGoBack()) router.back(); else router.replace('/') }

  let body
  if (!values) {
    body = loading
      ? <ActivityIndicator accessibilityLabel="불러오는 중" size="large" color={colors.accent} style={styles.spinner} />
      : (
        <View style={styles.stack}>
          <Notice>{loadError?.message}</Notice>
          <View style={styles.actions}>
            <Button label="다시 시도" onPress={load} />
            <Button label="돌아가기" onPress={leave} />
          </View>
        </View>
      )
  } else {
    const fixedInfo = pushState === 'unsupported' || pushState === 'no_project'
    body = (
      <View style={styles.stack}>
        {!!message && <Notice tone={message.tone}>{message.text}</Notice>}
        <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>받는 방법</Text>
        <SettingSwitch
          title="메일 받기" description={MAIL_HINT} value={values.notify_email} busy={!!busy.notify_email}
          accessibilityLabel="메일 받기" onToggle={toggleMail}
        />
        <SettingSwitch
          title="푸시 받기" description={PUSH_HINT} value={values.notify_push} busy={!!busy.notify_push}
          accessibilityLabel="푸시 받기" onToggle={togglePush}
        />
        {(fixedInfo || guideOpen) && (
          <PushPermissionGuide
            state={pushState} busy={!!busy.notify_push} onEnable={enablePush}
            onLater={fixedInfo ? undefined : () => setGuideOpen(false)}
          />
        )}
        <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>받을 알림</Text>
        {NOTIFICATION_KINDS.map((kind) => (
          <SettingSwitch
            key={kind}
            title={NOTIFICATION_KIND_LABEL[kind]}
            description={KIND_HINT[kind]}
            value={values.kinds.includes(kind)}
            busy={!!busy.kinds}
            accessibilityLabel={`${NOTIFICATION_KIND_LABEL[kind]} 알림`}
            onToggle={() => toggleKind(kind)}
          />
        ))}
        <Text style={[styles.note, { color: colors.muted }]}>변경은 누르는 즉시 저장됩니다.</Text>
      </View>
    )
  }

  return (
    <>
      <Stack.Screen options={{ title: '알림 설정' }} />
      <ScrollView
        ref={scrollRef}
        testID="settings-scroll"
        contentContainerStyle={[styles.content, { paddingBottom: spacing.xl * 2 + insets.bottom }]}
        style={{ backgroundColor: colors.bg }}
      >
        {body}
      </ScrollView>
    </>
  )
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg },
  stack: { gap: spacing.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  spinner: { marginTop: spacing.xl * 2 },
  heading: { fontSize: 17, fontWeight: '700', lineHeight: 24, marginTop: spacing.sm },
  note: { fontSize: 13, lineHeight: 19 },
})
