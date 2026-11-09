import { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { radius, spacing, useColors } from '../../theme'
import { Button, Notice } from '../ui'
import {
  GuideError, GuideModal, Para, Shot, ShotField, ShotItem, ShotLabel, ShotLine, Step, TEMPLATE_FILE, useGuideActions,
} from './GuideParts'

const STACK_NAME = 'deploy-wizard'

// AWS 연결 안내 (웹 AwsStackGuide + 대화상자) - 템플릿 받기부터 RoleArn 등록까지. setup(ExternalId 포함)은 부모 상태에서만 받고 이 창이 닫히면 사라진다
// resume 이면 ExternalId 없이 RoleArn 입력만 보인다
export default function AwsGuide({ setup, resume, busy, error, onSubmit, onClose }) {
  const colors = useColors()
  const [roleArn, setRoleArn] = useState('')
  const actions = useGuideActions()
  const label = setup.label
  const arn = roleArn.trim()

  // 확인 - 작업 중이거나 비었으면 보내지 않고, 앞뒤 공백을 지워 한 번 보낸다
  const submit = () => {
    if (busy || !arn) return
    onSubmit(arn)
  }

  return (
    <GuideModal title={`역할 만들고 붙여넣기 — ${label}`} closeLabel={`${label} 안내 닫기`} onClose={onClose}>
      {resume ? (
        <Para muted>ExternalId는 처음 한 번만 보여주기 때문에 다시 볼 수 없습니다. 스택을 이미 만들었다면 [출력] 탭의 RoleArn을 아래에 붙여넣으세요. 아직 안 만들었다면 이 블록의 AWS 연결을 해제하고 새로 시작하세요.</Para>
      ) : (
        <>
          <Para muted>그림은 콘솔 화면을 단순하게 그린 것입니다. 실제 화면과 문구가 조금 다를 수 있습니다. 주황색 테두리가 직접 건드릴 곳입니다.</Para>
          <GuideError>{actions.error}</GuideError>

          <Step num={1} title="템플릿 내려받기">
            <Para>{TEMPLATE_FILE} 내려받기 — 다운로드 폴더에 저장됩니다.</Para>
            <Button label="템플릿 받기" accessibilityLabel={`${label} 템플릿 받기`} onPress={() => actions.open(setup.template_download_url, { api: true })} />
          </Step>

          <Step num={2} title="스택 생성 화면에서 파일 올리기">
            <Para>AWS 콘솔의 스택 생성 화면 열기</Para>
            <Button label="콘솔 열기" accessibilityLabel={`${label} 콘솔 열기`} onPress={() => actions.open(setup.stack_create_url)} />
            <Shot title="CloudFormation › 스택 생성">
              <ShotLabel>사전 조건 - 템플릿 준비</ShotLabel>
              <ShotLine><ShotItem on>● 기존 템플릿 선택</ShotItem></ShotLine>
              <ShotLabel>템플릿 지정</ShotLabel>
              <ShotLine>
                <ShotItem>○ Amazon S3 URL</ShotItem>
                <ShotItem on mark>● 템플릿 파일 업로드</ShotItem>
              </ShotLine>
              <ShotLine>
                <ShotItem mark>파일 선택</ShotItem>
                <ShotItem mono>{TEMPLATE_FILE}</ShotItem>
                <ShotItem>다음</ShotItem>
              </ShotLine>
            </Shot>
          </Step>

          <Step num={3} title="스택 이름과 파라미터 넣기">
            <Para>값마다 [복사]를 눌러 같은 이름의 칸에 붙여넣습니다.</Para>
            <Shot title="스택 세부 정보 지정">
              <ShotField owner={label} name="스택 이름" label="스택 이름" value={STACK_NAME} onCopy={actions.copy} />
              <ShotLabel>파라미터</ShotLabel>
              <ShotField owner={label} name="TrustedAwsAccountId" label="TrustedAwsAccountId" value={setup.our_account_id} onCopy={actions.copy} />
              <ShotField owner={label} name="ExternalId" label="ExternalId" value={setup.external_id} onCopy={actions.copy} />
              <ShotLine><ShotItem>다음</ShotItem></ShotLine>
            </Shot>
            <GuideError>{actions.copyError}</GuideError>
            <Para muted>ExternalId는 지금 한 번만 보여줍니다. 이 창을 닫으면 다시 볼 수 없습니다.</Para>
          </Step>

          <Step num={4} title="스택 옵션은 그대로 두고 [다음]">
            <Para>태그·권한·실패 옵션은 아무것도 바꾸지 않고 맨 아래 [다음]을 누릅니다.</Para>
          </Step>

          <Step num={5} title="IAM 승인을 체크하고 [전송]">
            <Shot title="검토 및 생성 — 맨 아래">
              <ShotLabel>기능</ShotLabel>
              <ShotLine><ShotItem on mark>☑ AWS CloudFormation에서 사용자 지정 이름으로 IAM 리소스를 생성할 수 있음을 승인합니다.</ShotItem></ShotLine>
              <ShotLine><ShotItem>전송</ShotItem></ShotLine>
            </Shot>
            <Para muted>체크하지 않으면 생성이 거부됩니다. 만들어지는 것은 IAM 역할 3개뿐이고 비용은 없습니다.</Para>
          </Step>

          <Step num={6} title="완료되면 [출력] 탭에서 RoleArn 복사">
            <Para>상태가 CREATE_COMPLETE 가 될 때까지 1~2분 기다립니다. 새로고침 버튼으로 확인합니다.</Para>
            <Shot title={`스택 › ${STACK_NAME}`}>
              <ShotLine><ShotItem>CREATE_COMPLETE</ShotItem></ShotLine>
              <ShotLine>
                <ShotItem>스택 정보</ShotItem>
                <ShotItem>이벤트</ShotItem>
                <ShotItem>리소스</ShotItem>
                <ShotItem on mark>출력</ShotItem>
              </ShotLine>
              <ShotLabel>키 · 값</ShotLabel>
              <ShotLine>
                <ShotItem>RoleArn</ShotItem>
                <ShotItem mark mono>arn:aws:iam::…:role/DeployWizardCrossAccountRole</ShotItem>
              </ShotLine>
            </Shot>
            <Para muted>CREATE_FAILED 나 ROLLBACK 이 나오면 [이벤트] 탭의 빨간 줄 "상태 이유"를 확인하세요.</Para>
          </Step>
        </>
      )}

      <Step num={resume ? 1 : 7} title="RoleArn 붙여넣고 [확인]">
        <TextInput
          style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
          placeholder="arn:aws:iam::...:role/DeployWizardCrossAccountRole"
          placeholderTextColor={colors.muted}
          value={roleArn}
          onChangeText={setRoleArn}
          onSubmitEditing={submit}
          returnKeyType="done"
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={`${label} 역할 ARN`}
        />
      </Step>

      {!!error && <Notice>{error}</Notice>}
      <View style={styles.actions}>
        <Button label="나중에" accessibilityLabel={`${label} 안내 나중에`} onPress={onClose} style={styles.action} />
        <Button label="확인" accessibilityLabel={`${label} 역할 ARN 확인`} variant="primary" disabled={busy || !arn} onPress={submit} style={styles.action} />
      </View>
      {!resume && <Para muted>[나중에]를 눌러도 연결은 대기 상태로 남습니다. 다만 ExternalId는 다시 볼 수 없으니, 스택을 만든 뒤에 닫으세요.</Para>}
    </GuideModal>
  )
}

const styles = StyleSheet.create({
  input: { minHeight: 48, paddingHorizontal: spacing.md, borderWidth: 1, borderRadius: radius.md, fontSize: 14 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: { flex: 1 },
})
