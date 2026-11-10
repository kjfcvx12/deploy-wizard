import { confirmAction } from './confirm'

// 멈춤 확인 창 - 배포 상세와 인시던트 화면이 같은 글을 쓴다. 확인했을 때만 onConfirm 을 부른다
export function confirmStopDeploy(onConfirm) {
  confirmAction({
    title: '이 배포를 멈출까요?',
    message: 'ECS 서비스를 내려서 컨테이너 요금이 멈춥니다. 주소는 접속되지 않게 됩니다. 이미지와 설정은 남겨 두므로 [다시 켜기] 한 번으로 다시 띄울 수 있습니다.',
    cancelText: '그대로 두기',
    confirmText: '멈춤',
    onConfirm,
  })
}
