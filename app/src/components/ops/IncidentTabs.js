import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from '../Text'
import { useColors } from '../../theme'

// 가로로 균등하게 나뉜 탭 줄 - 선택한 탭은 accent 아래줄과 굵은 글, 나머지는 muted (누르면 onChange(key))
export default function IncidentTabs({ tabs, value, onChange }) {
  const colors = useColors()
  return (
    <View accessibilityRole="tablist" style={[styles.bar, { borderBottomColor: colors.border }]}>
      {tabs.map((tab) => {
        const selected = tab.key === value
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(tab.key)}
            style={[styles.tab, { borderBottomColor: selected ? colors.accent : 'transparent' }]}
          >
            <Text style={[styles.label, { color: selected ? colors.text : colors.muted, fontWeight: selected ? '700' : '400' }]}>{tab.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderBottomWidth: 1 },
  tab: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 2, marginBottom: -1 },
  label: { fontSize: 15, lineHeight: 21 },
})
