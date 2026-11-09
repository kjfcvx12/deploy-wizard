import { Pressable, StyleSheet, Text } from 'react-native'
import { repoName } from '../../constants'
import { radius, spacing, useColors } from '../../theme'

// 목록 위 문제 배너 - 열린 인시던트가 있는 배포 하나당 한 줄. 누르면 인시던트 화면 (자동 복구를 꺼 둔 배포는 사람이 봐야 한다)
export default function ProblemBanner({ deploy, onPress }) {
  const colors = useColors()
  const state = deploy.auto_recover === false ? '확인이 필요합니다' : '자동 복구 중'
  const text = `${repoName(deploy.repo_url)}에 문제가 있습니다 · ${state}`
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityHint="문제 상세 화면을 엽니다"
      onPress={onPress}
      style={({ pressed }) => [styles.banner, { backgroundColor: colors.warnBg, borderColor: colors.warn, opacity: pressed ? 0.7 : 1 }]}
    >
      <Text style={[styles.text, { color: colors.warn }]}>{text}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  banner: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderWidth: 1, borderRadius: radius.md },
  text: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
})
