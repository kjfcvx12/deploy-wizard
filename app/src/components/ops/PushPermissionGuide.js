import { Linking, StyleSheet, View } from 'react-native'
import { Text } from '../Text'
import { radius, spacing, useColors } from '../../theme'
import { Button } from '../ui'

// 알림 권한 안내 문구 (S-17) - 앱 전용 문구다 (웹에는 푸시가 없다). 권한 창은 이 글을 읽고 [알림 켜기]를 누른 뒤에만 뜬다
const EXPLAIN_TEXT = '문제가 생겼을 때 바로 알려드리려고 알림 권한이 필요합니다. 알림에는 어느 배포에 무슨 일이 있었는지만 담기고, 누르면 해당 화면으로 바로 이동합니다. 알림 설정에서 언제든 끌 수 있습니다.'
const DENIED_TEXT = '알림이 꺼져 있어 푸시를 받을 수 없습니다. 기기 설정의 이 앱 항목에서 알림을 켠 뒤 돌아오세요.'
const NO_PROJECT_TEXT = '푸시 알림은 스토어용 빌드를 준비한 뒤(EAS 프로젝트 연결)에 쓸 수 있습니다. 지금은 푸시 없이도 나머지 기능은 그대로 동작합니다.'
const UNSUPPORTED_TEXT = '이 환경(웹, 알림을 지원하지 않는 기기)에서는 푸시 알림을 쓸 수 없습니다. 앱 안 알림 목록은 그대로 쓸 수 있습니다.'

// 기기 설정 열기 - 열지 못해도 던지지 않는다
const openOsSettings = async () => {
  try {
    await Linking.openSettings()
  } catch {
    // 설정을 열 수 없는 환경 - 안내 글이 방법을 이미 적고 있다
  }
}

// 푸시 권한 안내 (S-17) - state 에 따라 설명+버튼 / 기기 설정 안내 / 준비 안내 / 지원 안 함 한 줄. onLater 가 없으면 [나중에] 도 없다 (고정 안내)
export default function PushPermissionGuide({ state, busy = false, onEnable, onLater }) {
  const colors = useColors()
  if (state !== 'undetermined' && state !== 'denied' && state !== 'no_project' && state !== 'unsupported') return null

  const text = { undetermined: EXPLAIN_TEXT, denied: DENIED_TEXT, no_project: NO_PROJECT_TEXT, unsupported: UNSUPPORTED_TEXT }[state]
  return (
    <View testID="push-guide" style={[styles.box, { backgroundColor: colors.infoBg, borderColor: colors.border }]}>
      <Text style={[styles.text, { color: colors.text }]}>{text}</Text>
      {(state === 'undetermined' || state === 'denied') && (
        <View style={styles.actions}>
          {state === 'undetermined' && <Button variant="primary" label="알림 켜기" onPress={onEnable} disabled={busy} />}
          {state === 'denied' && <Button variant="primary" label="설정 열기" onPress={openOsSettings} />}
          {!!onLater && <Button label="나중에" onPress={onLater} />}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: radius.md, padding: spacing.lg, gap: spacing.md },
  text: { fontSize: 14, lineHeight: 21 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
})
