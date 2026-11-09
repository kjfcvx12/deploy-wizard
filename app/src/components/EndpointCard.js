import { useEffect, useRef, useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { radius, spacing, useColors } from '../theme'
import { Button, Card } from './ui'

// 응답 확인 결과 라벨 (웹 DeployDetailPage 와 같다)
const HEALTH_LABEL = { healthy: '응답 정상', unhealthy: '응답 없음', unknown: '확인 전' }

// 복사됨 표시를 거두는 시간(ms)
const COPIED_MS = 2000

// 주소 카드 - 누르면 브라우저로 열고, 길게 누르거나 [복사]를 누르면 복사한다. 요금 안내 문장 포함
export default function EndpointCard({ endpoint, health, onError }) {
  const colors = useColors()
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)

  // 언마운트 때 복사됨 표시 타이머를 거둔다
  useEffect(() => () => clearTimeout(timer.current), [])

  // 브라우저로 연다 - http(s) 주소만 연다
  const open = async () => {
    try {
      if (!/^https?:\/\//i.test(endpoint)) throw new Error('unsupported scheme')
      await Linking.openURL(endpoint)
    } catch (e) {
      onError('주소를 열 수 없습니다')
    }
  }

  // 클립보드에 복사하고 잠깐 '복사됨'으로 바꾼다
  const copy = async () => {
    try {
      // false 로 끝나면 복사되지 않은 것이다
      if ((await Clipboard.setStringAsync(endpoint)) === false) throw new Error('copy failed')
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    } catch (e) {
      onError('주소를 복사하지 못했습니다')
    }
  }

  return (
    <Card testID="endpoint-card" style={styles.card}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`배포 주소 ${endpoint}`}
        accessibilityHint="누르면 브라우저에서 열고, 길게 누르면 복사합니다"
        onPress={open}
        onLongPress={copy}
        style={styles.link}
      >
        <Text style={[styles.endpoint, { color: colors.accent }]}>{endpoint}</Text>
      </Pressable>

      <View style={styles.row}>
        <Button label={copied ? '복사됨' : '복사'} onPress={copy} />
        {!!health && (
          <View style={[styles.badge, { backgroundColor: health.health === 'healthy' ? colors.okBg : colors.errBg }]}>
            <Text style={[styles.badgeText, { color: health.health === 'healthy' ? colors.ok : colors.err }]}>
              {HEALTH_LABEL[health.health] || health.health}
            </Text>
          </View>
        )}
      </View>

      <Text style={[styles.note, { color: colors.muted }]}>
        떠 있는 동안 로드밸런서와 컨테이너 요금이 계속 나옵니다. 잠시 안 쓸 거면 아래에서 [멈춤], 완전히 지울 거면 [삭제]를 누르세요.
      </Text>
    </Card>
  )
}

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  link: { minHeight: 44, justifyContent: 'center' },
  endpoint: { fontSize: 17, fontWeight: '700', lineHeight: 24, textDecorationLine: 'underline' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  badgeText: { fontSize: 12, fontWeight: '700' },
  note: { fontSize: 13, lineHeight: 19 },
})
