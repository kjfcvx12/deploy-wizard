import { Text, View } from 'react-native'
import { useColors } from '../src/theme'

// 배포 목록 화면 자리 (다음 작업에서 채운다)
export default function Index() {
  const colors = useColors()
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
      <Text style={{ color: colors.text }}>배포 마법사</Text>
    </View>
  )
}
