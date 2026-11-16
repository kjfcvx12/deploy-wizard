// 옵션을 바꾼 뒤 추정을 다시 부르기까지 기다리는 시간 (밀리초)
export const ESTIMATE_DEBOUNCE_MS = 300

// 배포하면 만들어지는 AWS 리소스 - docs/superpowers/specs/2026-11-16-cost-confirm-design.md §5.5
export const CREATED_RESOURCES = [
  'ECR 이미지 저장소 (빌드한 이미지를 보관)',
  'ECS 서비스 (Fargate 컨테이너로 앱 실행)',
  '로드밸런서 (ALB, 외부 HTTPS 주소를 받는 입구)',
]

// 가격 표시와 상관없이 항상 보이는 요금 안내
export const BILLING_NOTICE = '떠 있는 동안 요금이 계속 나옵니다. 잠시 안 쓸 거면 [멈춤], 지우려면 [삭제]를 누르세요.'

// 가격을 못 가져왔을 때 (가격 파일을 읽지 못함·서버 오류)
export const PRICE_FAIL_TEXT = '가격을 가져오지 못했습니다. 배포는 할 수 있지만 금액은 표시되지 않습니다.'

// 증설 기능을 처음 켤 때 채워 주는 값 - 사용자가 바꿀 수 있다
export const SCALING_DEFAULTS = { min: '1', max: '2', target: '70' }
