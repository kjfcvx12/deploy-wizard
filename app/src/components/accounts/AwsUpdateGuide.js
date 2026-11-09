import { StyleSheet, View } from 'react-native'
import { spacing } from '../../theme'
import { Button, Notice } from '../ui'
import {
  GuideError, GuideModal, Para, Shot, ShotItem, ShotLabel, ShotLine, Step, TEMPLATE_FILE, useGuideActions,
} from './GuideParts'

// 스택 업데이트 안내 (웹 AwsStackUpdateGuide + 대화상자) - 템플릿에 권한이 추가됐을 때. 사용자 계정의 역할은 사용자만 바꿀 수 있다
// info 는 템플릿 상태에 label 과 checked(업데이트 확인을 눌러 봤는가)를 더한 것
export default function AwsUpdateGuide({ info, busy, error, onCheck, onClose }) {
  const actions = useGuideActions()
  const label = info.label

  return (
    <GuideModal title={`스택 업데이트가 필요합니다 — ${label}`} onClose={onClose}>
      <Para muted>
        {`배포 마법사에 기능이 추가되면서 필요한 권한이 늘었습니다. 지금 연결된 역할은 예전 권한(버전 ${info.current_version})이라 일부 기능이 AWS에서 거부됩니다. 최신 템플릿(버전 ${info.latest_version})으로 스택을 한 번 업데이트하면 됩니다. 연결과 ExternalId는 그대로이고, 비용은 없습니다.`}
      </Para>
      <GuideError>{actions.error}</GuideError>

      <Step num={1} title="최신 템플릿 내려받기">
        <Para>{TEMPLATE_FILE} 내려받기 — 다운로드 폴더에 저장됩니다.</Para>
        <Button label="템플릿 받기" accessibilityLabel={`${label} 템플릿 받기`} onPress={() => actions.open(info.template_download_url, { api: true })} />
      </Step>

      <Step num={2} title="콘솔에서 스택을 고르고 [업데이트]">
        <Para>AWS 콘솔의 스택 목록 열기 → 연결할 때 만든 스택을 선택합니다.</Para>
        <Button label="스택 목록 열기" accessibilityLabel={`${label} 스택 목록 열기`} onPress={() => actions.open(info.stack_list_url)} />
        <Shot title="CloudFormation › 스택">
          <ShotLine>
            <ShotItem on mark>● deploy-wizard</ShotItem>
            <ShotItem>CREATE_COMPLETE</ShotItem>
            <ShotItem mark>업데이트</ShotItem>
          </ShotLine>
        </Shot>
        <Para muted>"직접 업데이트"와 "변경 세트 생성" 중에 고르라고 나오면 직접 업데이트를 고릅니다.</Para>
      </Step>

      <Step num={3} title="기존 템플릿을 새 파일로 교체">
        <Shot title="스택 업데이트 › 템플릿 준비">
          <ShotLine>
            <ShotItem>○ 기존 템플릿 사용</ShotItem>
            <ShotItem on mark>● 기존 템플릿 교체</ShotItem>
          </ShotLine>
          <ShotLabel>템플릿 지정</ShotLabel>
          <ShotLine><ShotItem on mark>● 템플릿 파일 업로드</ShotItem></ShotLine>
          <ShotLine>
            <ShotItem mark>파일 선택</ShotItem>
            <ShotItem mono>{TEMPLATE_FILE}</ShotItem>
            <ShotItem>다음</ShotItem>
          </ShotLine>
        </Shot>
      </Step>

      <Step num={4} title="파라미터와 옵션은 그대로 [다음]">
        <Para>TrustedAwsAccountId와 ExternalId는 이미 채워져 있습니다. 바꾸지 않습니다.</Para>
      </Step>

      <Step num={5} title="IAM 승인을 체크하고 [전송]">
        <Shot title="검토 — 맨 아래">
          <ShotLine><ShotItem on mark>☑ AWS CloudFormation에서 사용자 지정 이름으로 IAM 리소스를 생성할 수 있음을 승인합니다.</ShotItem></ShotLine>
          <ShotLine><ShotItem>전송</ShotItem></ShotLine>
        </Shot>
        <Para muted>상태가 UPDATE_COMPLETE 가 되면 아래 [업데이트 확인]을 누르세요.</Para>
      </Step>

      {info.checked && <Notice tone="warn">{`아직 예전 버전(${info.current_version})입니다. 스택 상태가 UPDATE_COMPLETE 인지 확인한 뒤 다시 눌러 주세요.`}</Notice>}
      {!!error && <Notice>{error}</Notice>}
      <View style={styles.actions}>
        <Button label="나중에" accessibilityLabel={`${label} 업데이트 안내 나중에`} onPress={onClose} style={styles.action} />
        <Button label="업데이트 확인" accessibilityLabel={`${label} 업데이트 확인`} variant="primary" disabled={busy} onPress={onCheck} style={styles.action} />
      </View>
    </GuideModal>
  )
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: { flex: 1 },
})
