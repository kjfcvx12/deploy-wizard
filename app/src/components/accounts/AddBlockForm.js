import { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { Text } from '../Text'
import { Button, Card } from '../ui'
import { radius, spacing, useColors } from '../../theme'

// 연결 블록 추가 폼 - 이름을 받아 onSubmit(이름) 으로 넘긴다. 공백뿐인 이름은 보내지 않는다
export default function AddBlockForm({ busy, onSubmit, onCancel }) {
  const colors = useColors()
  const [label, setLabel] = useState('')
  const blank = !label.trim()

  // 추가 - 작업 중이거나 이름이 비었으면 아무것도 하지 않는다
  const submit = () => {
    if (busy || blank) return
    onSubmit(label.trim())
  }

  return (
    <Card style={styles.card}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>연결 블록 추가</Text>
      <Text style={[styles.help, { color: colors.muted }]}>
        이 블록을 구분할 이름을 정하세요 (서비스 이름이 아닙니다). 블록이 만들어지면 그 안에서 AWS와 GitHub를 하나씩 연결합니다.
      </Text>
      <TextInput
        style={[styles.input, { color: colors.text, backgroundColor: colors.bg, borderColor: colors.border }]}
        placeholder="예: 운영 계정"
        placeholderTextColor={colors.muted}
        value={label}
        onChangeText={setLabel}
        onSubmitEditing={submit}
        returnKeyType="done"
        autoFocus
        accessibilityLabel="블록 이름"
      />
      <View style={styles.actions}>
        <Button label="취소" onPress={onCancel} disabled={busy} style={styles.action} />
        <Button label="추가" variant="primary" onPress={submit} disabled={busy || blank} style={styles.action} />
      </View>
    </Card>
  )
}

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  title: { fontSize: 18, fontWeight: '700' },
  help: { fontSize: 13, lineHeight: 18 },
  input: { minHeight: 48, paddingHorizontal: spacing.md, borderWidth: 1, borderRadius: radius.md, fontSize: 15 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: { flex: 1 },
})
