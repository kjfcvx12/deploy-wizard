import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { radius, spacing, useColors, wrapAnywhere } from '../../theme'
import { Button } from '../ui'

// 이미 연결한 계정 고르기 - 작은 목록 창. items 는 { key, title, subtitle }, 누르면 onPick(item), 뒤로 가기·닫기·바깥은 onClose
export default function ExistingPicker({ title, items, onPick, onClose }) {
  const colors = useColors()
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} testID="picker-modal">
      <View style={[styles.overlay, { backgroundColor: colors.scrim }]}>
        <Pressable accessible={false} importantForAccessibility="no" style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text accessibilityRole="header" style={[styles.title, wrapAnywhere, { color: colors.text }]}>{title}</Text>
          <ScrollView testID="picker-list" style={styles.list} keyboardShouldPersistTaps="handled">
            {items.map((item) => (
              <Pressable
                key={item.key}
                accessibilityRole="button"
                accessibilityLabel={`${title}: ${item.title}, ${item.subtitle}`}
                onPress={() => onPick(item)}
                style={({ pressed }) => [styles.item, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
              >
                <Text style={[styles.itemTitle, wrapAnywhere, { color: colors.text }]}>{item.title}</Text>
                <Text style={[styles.itemSub, wrapAnywhere, { color: colors.muted }]}>{item.subtitle}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <Button label="닫기" accessibilityLabel={`${title} 닫기`} onPress={onClose} />
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', padding: spacing.lg },
  sheet: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md },
  title: { fontSize: 17, fontWeight: '700' },
  list: { maxHeight: 360 },
  item: { minHeight: 56, paddingVertical: spacing.sm, justifyContent: 'center', borderBottomWidth: 1 },
  itemTitle: { fontSize: 15, fontWeight: '600' },
  itemSub: { fontSize: 13, lineHeight: 18 },
})
