import { Pressable, StyleSheet } from 'react-native'
import { Text } from '../Text'
import { repoName } from '../../constants'
import { radius, spacing, useColors } from '../../theme'

// 문제 한 줄 상태 글 - 확인 필요(needs_action) 인시던트와 자동 복구를 꺼 둔 배포는 사람이 봐야 하고, 그 밖에는 자동 복구 중 (상태를 모르는 옛 서버도 같은 규칙)
export function problemLabel(deploy) {
  if (deploy.open_incident_status === 'needs_action') return '확인이 필요합니다'
  return deploy.auto_recover === false ? '확인이 필요합니다' : '자동 복구 중'
}

// 목록 위 문제 배너 - 끝나지 않은 인시던트가 있는 배포 하나당 한 줄. 누르면 인시던트 화면 (같은 레포의 배포를 구분하도록 접근성 라벨에 배포 번호를 넣는다)
export default function ProblemBanner({ deploy, onPress }) {
  const colors = useColors()
  const text = `${repoName(deploy.repo_url)}에 문제가 있습니다 · ${problemLabel(deploy)}`
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${text} (배포 #${deploy.d_id})`}
      accessibilityHint={`배포 #${deploy.d_id}의 문제 상세 화면을 엽니다`}
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
