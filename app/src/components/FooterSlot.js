import { StyleSheet, View } from 'react-native'
import { Text } from './Text'
import { useColors } from '../theme'
import { Notice } from './ui'

// 맨 아래 안내 자리 - 평소엔 기본 글(note), 안내(message)가 있으면 그 자리를 안내가 대신한다 (한 줄 안내일 때 높이가 거의 변하지 않고, 두 줄 이상의 오류는 키가 커진다)
export default function FooterSlot({ message, note }) {
  const colors = useColors()
  return (
    <View style={styles.slot}>
      {message
        ? <Notice tone={message.tone}>{message.text}</Notice>
        : <Text style={[styles.note, { color: colors.muted }]}>{note}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  slot: { minHeight: 52, justifyContent: 'center' },
  note: { fontSize: 13, lineHeight: 19 },
})
