import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, View } from 'react-native'
import { Text } from '../Text'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { copyText, openLink } from '../../accounts/external'
import { monoFont, radius, spacing, useColors, wrapAnywhere } from '../../theme'
import { Button, Notice } from '../ui'

export const TEMPLATE_FILE = 'deploy_wizard_role.yaml'
const OPEN_ERROR = '주소를 열 수 없습니다'
const COPY_ERROR = '복사하지 못했습니다'

// 안내 창 틀 - 전체 화면 Modal 안에 제목과 오른쪽 위 닫기(= 나중에)와 스크롤. 키보드가 입력칸을 가리지 않게 감싼다. 뒤로 가기는 onClose
// 위 여백: 안드로이드(edge-to-edge)와 iOS 는 Modal 이 상태 표시줄 아래까지 그려져 안전 영역 위쪽만큼 띄운다. 웹은 0
export function GuideModal({ title, closeLabel, onClose, children }) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} testID="guide-modal">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'android' ? 'height' : undefined}
        style={[styles.flex, { backgroundColor: colors.bg, paddingTop: Platform.OS === 'web' ? 0 : insets.top }]}
      >
        <ScrollView
          testID="guide-scroll"
          contentContainerStyle={[styles.content, { paddingBottom: spacing.xl * 2 + insets.bottom }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
        >
          <View style={styles.head}>
            <Text accessibilityRole="header" style={[styles.title, wrapAnywhere, { color: colors.text }]}>{title}</Text>
            <Button label="닫기" accessibilityLabel={closeLabel} onPress={onClose} style={styles.close} />
          </View>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  )
}

// 바깥 주소 열기(error, 맨 위)·복사(copyError, 복사 단계 안) 실패를 안내 안에 보이는 작은 훅 - 실패 글에는 값을 싣지 않는다
export function useGuideActions() {
  const [error, setError] = useState('')
  const [copyError, setCopyError] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  // 주소 열기 - api 가 true 면 API 주소 아래의 파일(템플릿)이다
  const open = async (url, opts) => {
    setError('')
    const ok = await openLink(url, opts)
    if (!ok && alive.current) setError(OPEN_ERROR)
  }
  // 값 복사 - 성공 여부를 돌려준다
  const copy = async (value) => {
    const ok = await copyText(value)
    if (alive.current) setCopyError(ok ? '' : COPY_ERROR)
    return ok
  }
  return { error, copyError, open, copy }
}

// 단계 - 번호와 제목, 설명
export function Step({ num, title, children }) {
  const colors = useColors()
  return (
    <View testID="guide-step" style={styles.step}>
      <View style={[styles.num, { backgroundColor: colors.accent }]}>
        <Text style={[styles.numText, { color: colors.accentText }]}>{num}</Text>
      </View>
      <View style={styles.stepBody}>
        <Text accessibilityRole="header" style={[styles.stepTitle, wrapAnywhere, { color: colors.text }]}>{title}</Text>
        {children}
      </View>
    </View>
  )
}

// 단계 안의 설명 글 - muted 이면 작고 흐린 보조 글
export function Para({ muted, children }) {
  const colors = useColors()
  return <Text style={[muted ? styles.muted : styles.para, wrapAnywhere, { color: muted ? colors.muted : colors.text }]}>{children}</Text>
}

// 콘솔 화면을 단순하게 그린 그림 한 장
export function Shot({ title, children }) {
  const colors = useColors()
  return (
    <View style={[styles.shot, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <Text style={[styles.shotBar, wrapAnywhere, { color: colors.muted, backgroundColor: colors.surface2 }]}>{title}</Text>
      <View style={styles.shotBody}>{children}</View>
    </View>
  )
}

export function ShotLabel({ children }) {
  const colors = useColors()
  return <Text style={[styles.shotLabel, { color: colors.muted }]}>{children}</Text>
}

export function ShotLine({ children }) {
  return <View style={styles.shotLine}>{children}</View>
}

// 그림 속 조각 - mark 는 직접 건드릴 곳(주황 테두리), on 은 선택됨(파란 테두리)
export function ShotItem({ mark, on, mono, children }) {
  const colors = useColors()
  const border = mark ? colors.warn : on ? colors.accent : colors.border
  return (
    <View style={[styles.item, { borderColor: border, borderWidth: mark ? 2 : 1 }]}>
      <Text style={[styles.itemText, mono && { fontFamily: monoFont }, wrapAnywhere, { color: colors.text }]}>{children}</Text>
    </View>
  )
}

// 값 하나를 복사 버튼과 함께 - 콘솔 입력 칸에 그대로 붙여넣게 한다. 접근성 이름에는 값을 넣지 않는다
export function ShotField({ label, name, value, onCopy, owner }) {
  const colors = useColors()
  const [done, setDone] = useState(false)
  const timer = useRef(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; clearTimeout(timer.current) }
  }, [])

  // 복사하고 잠깐 복사됨으로 바꾼다
  const press = async () => {
    const ok = await onCopy(value)
    if (!ok || !alive.current) return
    setDone(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setDone(false), 1500)
  }

  return (
    <View style={styles.field}>
      <ShotLabel>{label}</ShotLabel>
      <View style={styles.shotLine}>
        <View style={[styles.value, { borderColor: colors.warn, backgroundColor: colors.bg }]}>
          <Text selectable style={[styles.valueText, wrapAnywhere, { color: colors.text, fontFamily: monoFont }]}>{value}</Text>
        </View>
        <Button
          label={done ? '복사됨' : '복사'}
          accessibilityLabel={`${owner} ${name} ${done ? '복사됨' : '복사'}`}
          onPress={press}
          style={styles.copy}
        />
      </View>
    </View>
  )
}

// 안내 위쪽의 실패 알림 (열기·복사)
export function GuideError({ children }) {
  return children ? <Notice>{children}</Notice> : null
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  title: { flex: 1, fontSize: 20, fontWeight: '700' },
  close: { minWidth: 64 },
  step: { flexDirection: 'row', gap: spacing.md },
  num: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  numText: { fontSize: 14, fontWeight: '700' },
  stepBody: { flex: 1, gap: spacing.sm, minWidth: 0 },
  stepTitle: { fontSize: 16, fontWeight: '700', lineHeight: 24 },
  para: { fontSize: 14, lineHeight: 20 },
  muted: { fontSize: 13, lineHeight: 18 },
  shot: { borderWidth: 1, borderRadius: radius.md, overflow: 'hidden' },
  shotBar: { fontSize: 12, fontWeight: '700', padding: spacing.sm },
  shotBody: { padding: spacing.sm, gap: spacing.sm },
  shotLabel: { fontSize: 12 },
  shotLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  item: { borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 4, flexShrink: 1 },
  itemText: { fontSize: 12, lineHeight: 17 },
  field: { gap: 4 },
  value: { flex: 1, minWidth: 140, borderWidth: 2, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm },
  valueText: { fontSize: 13, lineHeight: 18 },
  copy: { minWidth: 72 },
})
