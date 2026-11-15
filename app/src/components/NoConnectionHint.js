import { StyleSheet } from 'react-native'
import { Text } from './Text'
import { useRouter } from 'expo-router'
import { spacing, useColors } from '../theme'
import { Button, Card } from './ui'

// 쓸 수 있는 연결 블록이 없을 때의 안내 (앱 전용 문구 - 웹은 이때 연결 선택을 아무것도 그리지 않는다). 계정 연결 화면으로 가는 버튼이 있다
export default function NoConnectionHint() {
  const colors = useColors()
  const router = useRouter()
  return (
    <Card style={styles.card}>
      <Text style={[styles.text, { color: colors.muted }]}>연결된 계정이 없습니다. 계정 연결을 하면 비공개 레포와 내 AWS 계정으로 배포할 수 있습니다.</Text>
      <Button label="계정 연결 열기" onPress={() => router.push('/accounts')} style={styles.self} />
    </Card>
  )
}

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  text: { fontSize: 14, lineHeight: 20 },
  self: { alignSelf: 'flex-start' },
})
