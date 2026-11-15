import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { deployApi } from '../../src/api'
import FitScreen from '../../src/components/FitScreen'
import FooterSlot from '../../src/components/FooterSlot'
import SettingSwitch from '../../src/components/SettingSwitch'
import { Button, Notice } from '../../src/components/ui'
import { repoName } from '../../src/constants'
import { spacing, useColors } from '../../src/theme'

const NOT_FOUND_TEXT = '배포를 찾을 수 없습니다. 이미 삭제된 배포일 수 있습니다.'
const SAVED_TEXT = '저장했습니다'
// 저장 안내가 떠 있는 시간(ms)
const SAVED_MS = 3000
// 맨 아래 자리의 기본 글
const NOTE_TEXT = '변경은 누르는 즉시 저장됩니다. 이미 진행 중인 배포에는 영향이 없습니다.'

// 스위치 둘의 이름·설명 - 자동 복구는 재시작과 이전 버전으로 되돌리기만 한다는 점을 분명히 적는다 (업무 규칙 3)
const SETTINGS = [
  {
    field: 'auto_redeploy',
    title: '새 커밋이 오면 자동 재배포',
    description: '이 레포의 배포 브랜치에 새 커밋이 올라오면 마법사가 다시 배포합니다. 끄면 "새 커밋 있음" 표시만 남고, 직접 [다시 배포]를 눌러야 합니다.',
  },
  {
    field: 'auto_recover',
    title: '문제가 생기면 자동 복구',
    description: '실행 중인 서비스가 응답하지 않으면 마법사가 복구를 시도하고 무엇을 했는지 알려 드립니다. 자동 복구는 재시작과 이전 버전으로 되돌리기만 합니다. 삭제나 사양 변경은 직접 확인한 뒤에만 합니다.',
  },
]

// 서버 값에서 스위치 값을 읽는다 - 값이 없는 옛 응답은 서버 기본값(자동 복구 켜짐, 자동 재배포 꺼짐)으로 본다
const readValues = (deploy) => ({
  auto_redeploy: Boolean(deploy.auto_redeploy),
  auto_recover: deploy.auto_recover !== false,
})

// 배포 설정 화면 (S-14) - 주소의 d_id 가 바뀌면 화면을 새로 만들어 다른 배포의 상태가 남지 않게 한다
export default function DeploySettingsScreen() {
  const { d_id } = useLocalSearchParams()
  return <DeploySettings key={d_id} d_id={d_id} />
}

// 스위치 둘 - 누르면 저장 버튼 없이 바로 반영하고, 실패하면 되돌린다
function DeploySettings({ d_id }) {
  const colors = useColors()
  const router = useRouter()
  const scrollRef = useRef(null)
  const alive = useRef(false)
  const loadSeq = useRef(0)
  const valuesRef = useRef(null)
  const busyRef = useRef({})
  const timerRef = useRef(null)

  const [deploy, setDeploy] = useState(null)
  const [values, setValues] = useState(null)
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

  // 처음 값을 한 번 받는다 (폴링 없음) - 다시 시도도 이 함수
  const load = useCallback(async () => {
    const mine = ++loadSeq.current
    setLoading(true)
    setLoadError(null)
    try {
      const result = await deployApi.getOne(d_id)
      if (!alive.current || mine !== loadSeq.current) return
      valuesRef.current = readValues(result)
      setDeploy(result)
      setValues(valuesRef.current)
    } catch (e) {
      if (alive.current && mine === loadSeq.current) setLoadError(e)
    } finally {
      if (alive.current && mine === loadSeq.current) setLoading(false)
    }
  }, [d_id])

  useEffect(() => { load() }, [load])

  // 실패나 안내가 생기면 맨 아래 안내 자리가 보이게 내린다 (넘칠 때만 의미가 있다)
  useEffect(() => {
    if (message) scrollRef.current?.scrollToEnd?.({ animated: true })
  }, [message])

  // 스위치 하나를 바꾼다 - 먼저 새 값으로 보이고, 같은 스위치는 응답이 올 때까지 잠근다. 실패하면 그 스위치만 되돌린다
  const toggle = async (field) => {
    if (busyRef.current[field] || !valuesRef.current) return
    const previous = valuesRef.current[field]
    const next = !previous
    busyRef.current[field] = true
    clearTimeout(timerRef.current)
    valuesRef.current = { ...valuesRef.current, [field]: next }
    setValues(valuesRef.current)
    setBusy((b) => ({ ...b, [field]: true }))
    setMessage(null)
    try {
      await deployApi.patchSettings(d_id, { [field]: next })
      if (!alive.current) return
      clearTimeout(timerRef.current)
      setMessage({ tone: 'info', text: SAVED_TEXT })
      timerRef.current = setTimeout(() => { if (alive.current) setMessage(null) }, SAVED_MS)
    } catch (e) {
      if (!alive.current) return
      valuesRef.current = { ...valuesRef.current, [field]: previous }
      setValues(valuesRef.current)
      // 다른 스위치의 저장 안내 타이머가 이 오류를 지우지 않게 한다
      clearTimeout(timerRef.current)
      setMessage({ tone: 'err', text: e.message })
      // 그 사이 배포가 지워졌으면 없는 배포 안내로 바꾼다
      if (e.status === 404) setLoadError(e)
    } finally {
      busyRef.current[field] = false
      if (alive.current) setBusy((b) => ({ ...b, [field]: false }))
    }
  }

  // 돌아간다 - 아래 화면이 없으면(주소로 바로 들어온 경우) 목록으로
  const leave = () => { if (router.canGoBack()) router.back(); else router.replace('/') }

  let body
  if (loadError?.status === 404) {
    body = (
      <View style={[styles.stack, styles.center]}>
        <Notice>{NOT_FOUND_TEXT}</Notice>
        <Button label="돌아가기" onPress={leave} style={styles.self} />
      </View>
    )
  } else if (!values) {
    body = loading
      ? <ActivityIndicator accessibilityLabel="불러오는 중" size="large" color={colors.accent} style={styles.center} />
      : (
        <View style={[styles.stack, styles.center]}>
          <Notice>{loadError?.message}</Notice>
          <View style={styles.actions}>
            <Button label="다시 시도" onPress={load} />
            <Button label="돌아가기" onPress={leave} />
          </View>
        </View>
      )
  } else {
    body = (
      <View style={[styles.stack, styles.fill]}>
        <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
          {`${repoName(deploy.repo_url)} · 배포 #${d_id}`}
        </Text>
        {SETTINGS.map((setting) => (
          <SettingSwitch
            key={setting.field}
            title={setting.title}
            description={setting.description}
            value={values[setting.field]}
            busy={!!busy[setting.field]}
            accessibilityLabel={`${setting.title}, 배포 #${d_id}`}
            onToggle={() => { toggle(setting.field) }}
          />
        ))}
      </View>
    )
  }

  return (
    <>
      <Stack.Screen options={{ title: '배포 설정' }} />
      <FitScreen testID="settings-scroll" scrollRef={scrollRef}>
        {body}
        {!!values && loadError?.status !== 404 && <FooterSlot message={message} note={NOTE_TEXT} />}
      </FitScreen>
    </>
  )
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  self: { alignSelf: 'flex-start' },
  fill: { flex: 1 },
  center: { flex: 1, justifyContent: 'center' },
  heading: { fontSize: 17, fontWeight: '700', lineHeight: 24 },
})
