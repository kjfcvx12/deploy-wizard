import { useRef } from 'react'
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { radius, spacing, useColors } from '../theme'

export const MAX_LOG_LINES = 500

// 로그 목록 뒤에 새 줄을 붙인다 - 이미 있는 번호는 건너뛰고, 마지막 500줄만 남긴다
export function appendLogs(prev, incoming) {
  const lastId = prev.length ? prev[prev.length - 1].d_l_id : -Infinity
  const fresh = incoming.filter((log) => log.d_l_id > lastId)
  if (fresh.length === 0) return prev
  return [...prev, ...fresh].slice(-MAX_LOG_LINES)
}

// 바닥에서 이 정도(pt) 안이면 바닥을 보고 있다고 본다
const BOTTOM_GAP = 40

// 터미널형 로그 - 바닥을 보고 있을 때만 따라 내려간다 (웹 LogTerminal 과 같다)
// 페이지 스크롤 안에 놓이고 최대 500줄이라, 가상화 목록(FlatList) 대신 안쪽 ScrollView 를 쓴다 (스크롤 안의 FlatList 는 RN 이 중첩 오류를 내고 웹에서는 자체 스크롤이 생기지 않는다)
export default function LogTerminal({ logs }) {
  const colors = useColors()
  const { height } = useWindowDimensions()
  const listRef = useRef(null)
  const stick = useRef(true)
  const shown = logs.length > MAX_LOG_LINES ? logs.slice(-MAX_LOG_LINES) : logs
  const levelColor = { cmd: colors.termCmd, warn: colors.termWarn, error: colors.termErr }

  // 스크롤 위치가 바닥 근처인지 기억한다
  const onScroll = (e) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    stick.current = contentSize.height - contentOffset.y - layoutMeasurement.height < BOTTOM_GAP
  }

  // 내용이 늘어났을 때 바닥을 보고 있었으면 따라 내려간다
  const onContentSizeChange = () => {
    if (stick.current) listRef.current?.scrollToEnd({ animated: false })
  }

  return (
    <View style={[styles.box, { backgroundColor: colors.termBg, height: Math.min(360, height * 0.6) }]}>
      <ScrollView
        ref={listRef}
        testID="log-terminal"
        accessibilityLabel={`실행 로그 ${shown.length}줄`}
        onScroll={onScroll}
        scrollEventThrottle={50}
        onContentSizeChange={onContentSizeChange}
        nestedScrollEnabled
        contentContainerStyle={styles.content}
      >
        {shown.length === 0 && <Text style={[styles.line, { color: colors.termMuted }]}>로그를 기다리는 중...</Text>}
        {shown.map((item) => (
          <Text key={item.d_l_id} style={[styles.line, { color: levelColor[item.level] || colors.termText }, item.level === 'cmd' && styles.bold]}>
            <Text style={{ color: colors.termMuted, fontWeight: '400' }}>[{item.step}] </Text>
            {item.message}
          </Text>
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.md, overflow: 'hidden' },
  content: { padding: spacing.md },
  line: { fontFamily: 'monospace', fontSize: 12.5, lineHeight: 19 },
  bold: { fontWeight: '700' },
})
