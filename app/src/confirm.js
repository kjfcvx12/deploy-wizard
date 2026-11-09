import { Alert, Platform } from 'react-native'

// 확인 창 - 안전한 선택(취소)이 먼저, 위험한 선택이 뒤다. 확인을 눌렀을 때만 onConfirm 을 부른다
// 웹의 Alert 는 창을 띄우지 않으므로 브라우저 confirm 으로 대신한다 (버튼 글자는 고를 수 없어 본문에 선택지를 적는다)
export function confirmAction({ title, message, cancelText, confirmText, onConfirm }) {
  if (Platform.OS === 'web') {
    const ok = globalThis.confirm?.(`${title}\n\n${message}\n\n[확인] ${confirmText}  /  [취소] ${cancelText}`)
    if (ok) onConfirm()
    return
  }
  Alert.alert(
    title,
    message,
    [
      { text: cancelText, style: 'cancel' },
      { text: confirmText, style: 'destructive', onPress: onConfirm },
    ],
    { cancelable: true },
  )
}
