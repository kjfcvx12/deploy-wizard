import { useCallback } from 'react'
import { ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { spacing, useColors } from '../theme'

// 한 화면 틀 - 화면 높이를 채우는 ScrollView. 내용이 작으면 스크롤되지 않고, 넘칠 때만 스크롤되어 어떤 경우에도 잘리지 않는다
// onAvailableHeight(h) 를 주면 안쪽 여백을 뺀 내용 영역의 높이를 알려 준다 (안쪽 상자의 maxHeight 계산용)
export default function FitScreen({ children, testID, scrollRef, refreshControl, onAvailableHeight }) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const paddingBottom = spacing.lg + insets.bottom
  // 스크롤 틀의 높이에서 위·아래 안쪽 여백을 뺀 값을 알린다
  const onLayout = useCallback((event) => {
    onAvailableHeight?.(event.nativeEvent.layout.height - spacing.lg - paddingBottom)
  }, [onAvailableHeight, paddingBottom])
  return (
    <ScrollView
      ref={scrollRef}
      testID={testID}
      refreshControl={refreshControl}
      alwaysBounceVertical={!!refreshControl}
      onLayout={onAvailableHeight ? onLayout : undefined}
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ flexGrow: 1, padding: spacing.lg, paddingBottom, gap: spacing.md }}
    >
      {children}
    </ScrollView>
  )
}
