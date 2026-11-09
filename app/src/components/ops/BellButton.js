import { Pressable, StyleSheet, Text, View } from 'react-native'
import { radius, useColors } from '../../theme'

// 배지에 보일 글 - 99 를 넘으면 99+ (0 이하는 배지를 그리지 않는다)
export const badgeText = (count) => (count > 99 ? '99+' : String(count))

// 목록 헤더의 알림 종 버튼 - 읽지 않은 수가 있으면 오른쪽 위에 배지. 눌림 크기는 44pt 이상
export default function BellButton({ count = 0, onPress }) {
  const colors = useColors()
  const label = count > 0 ? `알림 ${count}개 읽지 않음` : '알림'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={[styles.icon, { color: colors.text }]}>{'🔔'}</Text>
      {count > 0 && (
        <View testID="unread-badge" style={[styles.badge, { backgroundColor: colors.err }]}>
          <Text style={[styles.badgeText, { color: colors.accentText }]}>{badgeText(count)}</Text>
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  icon: { fontSize: 22 },
  badge: {
    position: 'absolute',
    top: 0,
    right: -6,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
})
