import { memo, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { Text } from './Text'
import { ENV_KINDS, ENV_SECRET_KINDS, kindLabel } from '../constants'
import { monoFont, radius, spacing, useColors, wrapAnywhere } from '../theme'
import { Button } from './ui'

// 작은 알약 배지 - tone: plain(흐림) | ok(초록)
function Pill({ text, tone = 'plain' }) {
  const colors = useColors()
  const bg = tone === 'ok' ? colors.okBg : colors.surface2
  const fg = tone === 'ok' ? colors.ok : colors.muted
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color: fg }]}>{text}</Text>
    </View>
  )
}

// 변수 한 줄 - 종류에 따라 값 입력 / 종류 고르기 / 시크릿 안내를 다르게 보여 준다. 값은 이 줄의 입력칸 상태에만 있다
function EnvRow({ row, busy, onPut, onClear }) {
  const colors = useColors()
  const [value, setValue] = useState('')
  // 다섯 종류가 아닌 값은 모르는 종류로 다룬다 - 값 입력창을 절대 주지 않기 위해서다
  const kind = ENV_KINDS.some((k) => k.key === row.kind) ? row.kind : 'unknown'
  const isSecret = ENV_SECRET_KINDS.has(kind)
  const isDone = row.status === 'set' || row.status === 'skipped'
  const name = row.name

  // 값은 저장에 성공했을 때만 비운다 - 실패하면 다시 시도할 수 있게 남겨 둔다
  const save = async () => {
    if (value === '') return
    if (await onPut(name, { value })) setValue('')
  }

  return (
    <View style={[styles.row, { borderColor: colors.border }]}>
      <View style={styles.head}>
        <Text style={[styles.name, wrapAnywhere, { color: colors.text, fontFamily: monoFont }]}>{name}</Text>
        <Pill text={kindLabel(row.kind)} />
        {isDone && <Pill text={row.status === 'set' ? '입력됨' : '건너뜀'} tone={row.status === 'set' ? 'ok' : 'plain'} />}
      </View>
      {!!row.source_hint && <Text style={[styles.hint, wrapAnywhere, { color: colors.muted, fontFamily: monoFont }]}>{row.source_hint}</Text>}

      {isDone ? (
        <View style={styles.actions}>
          {row.status === 'set' && <Button label="값 지우기" accessibilityLabel={`${name} 값 지우기`} onPress={() => { onClear(name) }} disabled={busy} />}
          {row.status === 'skipped' && <Button label="건너뛰기 취소" accessibilityLabel={`${name} 건너뛰기 취소`} onPress={() => { onPut(name, { skip: false }) }} disabled={busy} />}
        </View>
      ) : kind === 'unknown' ? (
        <View style={styles.stack}>
          <Text style={[styles.note, { color: colors.muted }]}>이 변수는 어떤 종류인가요?</Text>
          <View style={styles.actions}>
            {ENV_KINDS.map((k) => (
              <Button key={k.key} label={k.label} accessibilityLabel={`${name} 종류: ${k.label}`} onPress={() => { onPut(name, { kind: k.key }) }} disabled={busy} />
            ))}
            <Button label="건너뛰기" accessibilityLabel={`${name} 건너뛰기`} onPress={() => { onPut(name, { skip: true }) }} disabled={busy} />
          </View>
        </View>
      ) : isSecret ? (
        <View style={styles.stack}>
          <Text style={[styles.note, { color: colors.muted }]}>이 종류의 값은 아직 저장할 수 없습니다. 지금은 건너뛰기만 됩니다.</Text>
          <View style={styles.actions}>
            <Button label="건너뛰기" accessibilityLabel={`${name} 건너뛰기`} onPress={() => { onPut(name, { skip: true }) }} disabled={busy} />
          </View>
        </View>
      ) : (
        <View style={styles.stack}>
          <TextInput
            style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
            value={value}
            onChangeText={setValue}
            onSubmitEditing={() => { save() }}
            maxLength={2000}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            importantForAutofill="no"
            returnKeyType="done"
            editable={!busy}
            placeholder="값"
            placeholderTextColor={colors.muted}
            accessibilityLabel={`${name} 값`}
          />
          <View style={styles.actions}>
            <Button variant="primary" label="저장" accessibilityLabel={`${name} 저장`} onPress={() => { save() }} disabled={busy || value === ''} />
            <Button label="건너뛰기" accessibilityLabel={`${name} 건너뛰기`} onPress={() => { onPut(name, { skip: true }) }} disabled={busy} />
          </View>
        </View>
      )}
    </View>
  )
}

// 같은 줄 데이터와 같은 콜백이면 다시 그리지 않는다
export default memo(EnvRow)

const styles = StyleSheet.create({
  row: { paddingVertical: spacing.md, borderTopWidth: 1, gap: spacing.sm },
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  name: { flexShrink: 1, fontSize: 14, fontWeight: '700' },
  hint: { fontSize: 12, lineHeight: 17 },
  note: { fontSize: 13, lineHeight: 19 },
  stack: { gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  input: { minHeight: 48, paddingHorizontal: spacing.md, borderWidth: 1, borderRadius: radius.md, fontSize: 15 },
  pill: { paddingHorizontal: 10, paddingVertical: 2, borderRadius: radius.pill },
  pillText: { fontSize: 12, fontWeight: '700' },
})
