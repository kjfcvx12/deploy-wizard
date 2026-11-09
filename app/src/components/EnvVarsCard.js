import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { envApi } from '../api'
import { ENV_KINDS, isProgress } from '../constants'
import { canContinue, groupEnvVars } from '../envGroups'
import { radius, spacing, useColors } from '../theme'
import EnvRow from './EnvRow'
import { Button, Card, Notice } from './ui'

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/
const NAME_MESSAGE = '이름은 영문자나 _로 시작하고, 영문자·숫자·_만 100자까지 쓸 수 있습니다.'

// 같은 성격의 변수 묶음 - fold 이면 접어 둔다 (빈 묶음은 그리지 않는다)
function EnvGroup({ title, rows, fold, ...rowProps }) {
  const colors = useColors()
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return null

  const count = <Text style={[styles.count, { color: colors.muted }]}>{`(${rows.length})`}</Text>
  const list = rows.map((row) => <EnvRow key={row.name} row={row} {...rowProps} />)

  if (fold) {
    return (
      <View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${title}, ${rows.length}개`}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((v) => !v)}
          style={styles.groupHead}
        >
          <View testID="fold-glyph" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Text style={[styles.groupTitle, { color: colors.text }]}>{open ? '▾' : '▸'}</Text>
          </View>
          <Text style={[styles.groupTitle, styles.groupText, { color: colors.text }]}>{title}</Text>
          {count}
        </Pressable>
        {open && list}
      </View>
    )
  }

  return (
    <View>
      <View style={styles.groupHead}>
        <Text accessibilityRole="header" style={[styles.groupTitle, styles.groupText, { color: colors.text }]}>{title}</Text>
        {count}
      </View>
      {list}
    </View>
  )
}

// 읽기 초점을 카드 제목으로 옮긴다 (앱 전용)
function focusNode(ref) {
  if (Platform.OS === 'web' || !ref.current || typeof AccessibilityInfo.sendAccessibilityEvent !== 'function') return
  AccessibilityInfo.sendAccessibilityEvent(ref.current, 'focus')
}

// 환경변수 입력 카드 (S-19) - 값은 쓰기 전용이라 저장 뒤에는 화면에도 상태에도 남기지 않는다
export default function EnvVarsCard({ deploy, onContinued, onRedeploy }) {
  const { d_id, status } = deploy
  const colors = useColors()
  const headingRef = useRef(null)
  const alive = useRef(true)
  const loadId = useRef(0)
  const busyRef = useRef(false)
  const redeployRef = useRef(false)

  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [redeployHint, setRedeployHint] = useState(false)
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState('config')
  const [nameError, setNameError] = useState('')

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // 목록을 받는다 - 요청 번호가 최신일 때만 반영해서 늦게 온 옛 응답이 새 목록을 덮지 못하게 한다. 받지 못했으면 false
  const loadRows = useCallback(async () => {
    const id = ++loadId.current
    try {
      const data = await envApi.getAll(d_id)
      if (id !== loadId.current || !alive.current) return true
      setRows(data)
      setLoadError('')
      return true
    } catch (e) {
      if (id !== loadId.current || !alive.current) return true
      setLoadError(e.message)
      return false
    }
  }, [d_id])

  // 상태가 바뀔 때마다 목록을 다시 받는다 (needs_input 이후에는 페이지 폴링이 멈추기 때문)
  useEffect(() => { loadRows() }, [loadRows, status])

  // 변경 요청을 보내고 목록을 새로 받는다 - 요청이 성공했는지를 돌려준다. announce 이거나 목록을 못 받았으면 읽기 초점을 제목으로 옮긴다
  const mutate = useCallback(async (call, announce = false) => {
    if (busyRef.current) return false
    busyRef.current = true
    loadId.current += 1
    setBusy(true)
    setError('')
    let done = false
    try {
      const changed = await call()
      done = true
      if (changed?.needs_redeploy && alive.current) setRedeployHint(true)
      const loaded = await loadRows()
      if (alive.current && (announce || !loaded)) focusNode(headingRef)
    } catch (e) {
      if (alive.current) setError(e.message)
      // 실패해서 밀려난 상태 갱신이 있었을 수 있으니 목록을 다시 받는다
      loadRows()
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
    return done
  }, [loadRows])

  // 줄에 내려 주는 콜백은 바뀌지 않게 둔다 (이름 입력창에 글자를 쳐도 줄이 다시 그려지지 않도록)
  const put = useCallback((name, body) => mutate(() => envApi.put(d_id, name, body)), [d_id, mutate])
  const clear = useCallback((name) => mutate(() => envApi.clearValue(d_id, name)), [d_id, mutate])

  // 변수 직접 추가 - 이름 규칙은 서버와 같게 먼저 확인하고, 이미 있는 이름은 요청 없이 거절한다
  const add = async () => {
    if (!NAME_PATTERN.test(newName)) { setNameError(NAME_MESSAGE); return }
    if (rows?.some((r) => r.name === newName)) { setNameError('이미 목록에 있는 변수입니다'); return }
    setNameError('')
    if (await mutate(() => envApi.put(d_id, newName, { kind: newKind }), true)) setNewName('')
  }

  // 이어서 배포 - 서버가 거절(409)하면 이유를 보여 주고 입력은 그대로 둔다
  const goOn = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await envApi.continueDeploy(d_id)
      onContinued()
    } catch (e) {
      if (alive.current) setError(e.message)
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }

  // 다시 배포 - 부모가 성공했을 때(false 가 아닌 값으로 끝났을 때)만 안내를 지운다. 실패하면 안내를 남긴다
  const redeploy = async () => {
    if (redeployRef.current) return
    redeployRef.current = true
    try {
      if ((await onRedeploy()) !== false && alive.current) setRedeployHint(false)
    } catch (e) {
      // 실패하면 안내와 버튼을 그대로 둔다
    } finally {
      redeployRef.current = false
    }
  }

  if (rows === null && !loadError) return null
  if (rows?.length === 0 && status !== 'needs_input' && !loadError && !error) return null

  // 목록을 받지 못했으면 제목과 오류만 보여 준다
  if (rows === null) {
    return (
      <Card style={styles.card}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>환경변수</Text>
        <Notice>{loadError}</Notice>
      </Card>
    )
  }

  const groups = groupEnvVars(rows)
  const waiting = status === 'needs_input'
  const ready = canContinue(rows)
  const rowProps = { busy, onPut: put, onClear: clear }

  return (
    <Card style={styles.card}>
      <Text ref={headingRef} accessibilityRole="header" style={[styles.title, { color: colors.text }]}>환경변수</Text>

      <Text style={[styles.body, { color: colors.muted }]}>
        {rows.length === 0 && waiting
          ? '입력할 환경변수를 찾지 못했습니다. [이어서 배포]를 눌러 계속하세요.'
          : '코드에서 필요한 값을 찾았습니다. 값은 이 화면에서만 입력하고, 한 번 저장하면 다시 보여 드리지 않습니다.'}
      </Text>

      <EnvGroup title="꼭 필요해 보이는 것" rows={groups.need} {...rowProps} />
      <EnvGroup title="종류를 모르는 것" rows={groups.unknown} {...rowProps} />
      <EnvGroup title="기본값이 있어 비워도 되는 것" rows={groups.optional} fold {...rowProps} />
      <EnvGroup title="입력 완료" rows={groups.done} fold {...rowProps} />

      <View style={[styles.add, { borderColor: colors.border }]}>
        <TextInput
          style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: nameError ? colors.err : colors.border }]}
          value={newName}
          onChangeText={(text) => { setNewName(text); setNameError('') }}
          onSubmitEditing={() => { add() }}
          placeholder="변수 이름 (예: API_BASE_URL)"
          placeholderTextColor={colors.muted}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          importantForAutofill="no"
          returnKeyType="done"
          editable={!busy}
          accessibilityLabel="추가할 변수 이름"
        />
        <View accessibilityRole="radiogroup" accessibilityLabel="추가할 변수 종류" style={styles.kinds}>
          {ENV_KINDS.map((kind) => {
            const selected = newKind === kind.key
            return (
              <Pressable
                key={kind.key}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: busy }}
                disabled={busy}
                onPress={() => setNewKind(kind.key)}
                style={[styles.kind, { borderColor: selected ? colors.accent : colors.border, backgroundColor: selected ? colors.infoBg : colors.surface }]}
              >
                <Text style={[styles.kindText, { color: colors.text }]}>{kind.label}</Text>
              </Pressable>
            )
          })}
        </View>
        {!!nameError && <Text accessibilityRole="alert" style={[styles.fieldErr, { color: colors.err }]}>{nameError}</Text>}
        <Button label="변수 직접 추가" onPress={() => { add() }} disabled={busy || newName === ''} style={styles.self} />
      </View>

      <Text style={[styles.small, { color: colors.muted }]}>자동으로 찾지 못한 변수가 있을 수 있습니다. 배포 후 앱이 시작하지 못하면 알려 드립니다.</Text>

      {redeployHint && (
        <View style={[styles.warn, { backgroundColor: colors.warnBg }]}>
          <Text style={[styles.warnText, { color: colors.warn }]}>다시 배포해야 적용됩니다</Text>
          {!isProgress(status) && <Button label="다시 배포" onPress={() => { redeploy() }} disabled={busy} style={styles.self} />}
        </View>
      )}

      {!!loadError && <Notice>{loadError}</Notice>}
      {!!error && <Notice>{error}</Notice>}

      {waiting && (
        <View style={styles.foot}>
          <Button variant="primary" label="이어서 배포" onPress={() => { goOn() }} disabled={busy || !ready} />
          {!ready && <Text style={[styles.small, { color: colors.muted }]}>필수 환경변수에 값이 없습니다</Text>}
        </View>
      )}
    </Card>
  )
}

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  title: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 14, lineHeight: 20 },
  small: { fontSize: 13, lineHeight: 19 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  groupTitle: { fontSize: 15, fontWeight: '700' },
  groupText: { flexShrink: 1 },
  count: { fontSize: 13 },
  add: { gap: spacing.sm, paddingTop: spacing.md, borderTopWidth: 1 },
  input: { minHeight: 48, paddingHorizontal: spacing.md, borderWidth: 1, borderRadius: radius.md, fontSize: 15 },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  kind: { minHeight: 44, paddingHorizontal: spacing.md, borderWidth: 1, borderRadius: radius.md, justifyContent: 'center' },
  kindText: { fontSize: 14 },
  fieldErr: { fontSize: 13, lineHeight: 19 },
  self: { alignSelf: 'flex-start' },
  warn: { padding: spacing.lg, borderRadius: radius.md, gap: spacing.sm },
  warnText: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
  foot: { gap: spacing.sm },
})
