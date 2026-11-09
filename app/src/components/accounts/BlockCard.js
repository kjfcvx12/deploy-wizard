import { StyleSheet, Text, View } from 'react-native'
import { Button, Card } from '../ui'
import { spacing, useColors, wrapAnywhere } from '../../theme'

// 연결 블록 카드 - 이름, 안쪽 상자(children), 선택·삭제 버튼. 작업 중이면 버튼을 잠근다
export default function BlockCard({ block, picked, busy, onPick, onDelete, children }) {
  const colors = useColors()
  return (
    <Card testID={`block-${block.c_id}`} style={styles.card}>
      <Text accessibilityRole="header" style={[styles.title, wrapAnywhere, { color: colors.text }]}>{block.label}</Text>
      {children}
      <View style={styles.pick}>
        <Button
          label={picked ? '선택됨' : '선택'}
          accessibilityLabel={`${block.label} ${picked ? '선택됨' : '선택'}`}
          variant={picked ? 'default' : 'primary'}
          disabled={busy || picked}
          onPress={() => onPick(block)}
        />
        <Text style={[styles.hint, wrapAnywhere, { color: colors.muted }]}>선택한 블록이 새 배포에서 미리 골라집니다.</Text>
      </View>
      <Button label="블록 삭제" accessibilityLabel={`${block.label} 블록 삭제`} variant="danger" disabled={busy} onPress={() => onDelete(block)} />
    </Card>
  )
}

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  title: { fontSize: 18, fontWeight: '700' },
  pick: { gap: spacing.sm },
  hint: { fontSize: 13, lineHeight: 18 },
})
