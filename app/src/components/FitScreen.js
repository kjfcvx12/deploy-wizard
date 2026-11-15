import { ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { spacing, useColors } from '../theme'

// 한 화면 틀 - 화면 높이를 채우는 ScrollView. 내용이 작으면 스크롤되지 않고, 넘칠 때만 스크롤되어 어떤 경우에도 잘리지 않는다
export default function FitScreen({ children, testID, scrollRef, refreshControl }) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      ref={scrollRef}
      testID={testID}
      refreshControl={refreshControl}
      alwaysBounceVertical={!!refreshControl}
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ flexGrow: 1, padding: spacing.lg, paddingBottom: spacing.lg + insets.bottom, gap: spacing.md }}
    >
      {children}
    </ScrollView>
  )
}
