import { StyleSheet, View } from 'react-native'
import { usePushSetup } from '../../hooks/usePushSetup'
import { Notice } from '../ui'
import PushPermissionGuide from './PushPermissionGuide'

// 배포 상세의 한 번짜리 알림 안내 카드 - active(running)이고 아직 권한을 안 물었고 닫은 적 없을 때만 보인다
export default function PushSetupCard({ active }) {
  const { state, busy, error, enable, dismiss } = usePushSetup(active)
  if (!state) return null
  return (
    <View testID="push-setup-card" style={styles.stack}>
      {!!error && <Notice>{error}</Notice>}
      <PushPermissionGuide state={state} busy={busy} onEnable={enable} onLater={dismiss} />
    </View>
  )
}

const styles = StyleSheet.create({ stack: { gap: 8 } })
