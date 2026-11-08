# 플로우차트

GitHub와 대부분의 마크다운 뷰어에서 Mermaid가 그림으로 보인다.

## 1. 사용자 여정 (전체)

```mermaid
flowchart TD
    A["앱 또는 웹 열기"] --> B{"로그인 되어 있나"}
    B -- "아니오 (3단계 이후)" --> C["Google로 로그인"]
    C --> D
    B -- "예 / 1~2단계" --> D["연결 블록 확인"]
    D --> E{"AWS와 GitHub 모두 연결됨"}
    E -- "아니오" --> F["계정 연결 (흐름 3)"]
    F --> D
    E -- "예" --> G["GitHub 주소 입력, 블록 선택"]
    G --> H["배포 진행 화면"]
    H --> I{"성공했나"}
    I -- "아니오" --> J["실패 해설 + 버튼 3개"]
    J --> K{"사용자 선택"}
    K -- "다시 배포" --> H
    K -- "리소스 정리" --> L["확인 후 삭제"]
    K -- "그대로 두기" --> M["목록으로"]
    I -- "예" --> N["HTTPS 주소 표시"]
    N --> O["운영 감시 시작"]
    O --> P{"문제 발생"}
    P -- "아니오" --> O
    P -- "예" --> Q["자동 복구와 알림 (흐름 4)"]
    Q --> R["알림 확인, 고칠 곳 수정, 다시 배포"]
    R --> H
```

## 2. 배포 파이프라인 (현재 구현)

```mermaid
flowchart TD
    S(["배포 만들기"]) --> V{"주소·브랜치 검증"}
    V -- "형식 오류" --> X1["400 한국어 메시지"]
    V -- "통과" --> Q["queued"]
    Q --> C["cloning: git clone --depth 1"]
    C --> A["analyzing: 언어 판별 (규칙)"]
    A --> G["generating: Dockerfile"]
    G --> G1{"레포에 Dockerfile 있나"}
    G1 -- "예" --> B
    G1 -- "아니오" --> G2["템플릿 + 빈칸 (AI, 안 되면 규칙)"]
    G2 --> B["building: docker build --platform linux/amd64"]
    B --> B1{"빌드 성공"}
    B1 -- "아니오" --> B2{"우리가 만든 Dockerfile이고 횟수 남음"}
    B2 -- "예" --> B3["AI 자가수정"] --> B
    B2 -- "아니오" --> F
    B1 -- "예" --> P["pushing: ECR 로그인, 푸시"]
    P --> D["deploying: Express Mode 서비스, 완료까지 대기"]
    D --> R["running: 주소 저장, 릴리스 기록"]
    C -. "실패" .-> F
    A -. "실패" .-> F
    G -. "실패" .-> F
    P -. "실패" .-> F
    D -. "실패" .-> F
    F["failed: 멈춤, 해설 저장, 리소스는 그대로"]
```

## 3. 계정 연결 (앱)

```mermaid
flowchart TD
    A["계정 연결 화면"] --> B{"어느 쪽"}
    B -- "GitHub" --> G1["[GitHub 연결] 누름"]
    G1 --> G2["앱 안 브라우저로 설치 화면 열기"]
    G2 --> G3["사용자가 GitHub에서 설치"]
    G3 --> G4["서버 콜백이 설치 저장, 딥링크로 앱 복귀"]
    G4 --> G5["연결 확인 결과 표시"]
    B -- "AWS" --> A1["[새 AWS 계정 연결], 이름 입력"]
    A1 --> A2["서버가 ExternalId 발급"]
    A2 --> A3["안내 7단계 (값마다 복사 버튼)"]
    A3 --> A4["콘솔 열기 (시스템 브라우저)"]
    A4 --> A5["사용자가 CloudFormation 스택 생성"]
    A5 --> A6["출력의 역할 ARN을 앱에 붙여넣기"]
    A6 --> A7{"AssumeRole 검증"}
    A7 -- "성공" --> A8["verified"]
    A7 -- "실패" --> A9["invalid + 이유, 다시 확인"]
    A9 --> A6
    A3 -. "폰에서 어렵다면" .-> A10["PC에서 이어서 하기 링크 보내기 (후보)"]
```

## 4. 장애 감지 → 자동 복구 → 알림

```mermaid
flowchart TD
    T(["60초마다"]) --> H["running 배포의 주소에 GET"]
    H --> HR["health_checks에 저장"]
    HR --> OK{"정상인가"}
    OK -- "예" --> T
    OK -- "아니오" --> CNT{"연속 실패가 기준 이상인가 (기본 3)"}
    CNT -- "아니오" --> T
    CNT -- "예" --> DUP{"이미 열린 인시던트가 있나"}
    DUP -- "예" --> T
    DUP -- "아니오" --> I["incident 생성 (open)"]
    I --> EV["원인 수집: 서비스 이벤트, 로그 끝부분 (마스킹)"]
    EV --> EX["원인 설명: 규칙 표 → 캐시 → AI(스키마 고정) → 기본 안내"]
    EX --> N1["알림 1: 문제 감지 (메일 + 푸시 + 앱 안)"]
    N1 --> AUTO{"자동 복구가 켜져 있나"}
    AUTO -- "아니오" --> NA["status = needs_action"]
    AUTO -- "예" --> REC["status = recovering"]
    REC --> BAD{"새 버전 배포 직후인가"}
    BAD -- "예" --> RB
    BAD -- "아니오" --> RS["1. 재시작 (같은 이미지로 서비스 갱신)"]
    RS --> W1["대기 후 헬스 확인"]
    W1 --> R1{"정상인가"}
    R1 -- "예" --> OKR
    R1 -- "아니오" --> PREV{"되돌릴 정상 버전이 있나"}
    PREV -- "아니오" --> NA
    PREV -- "예" --> RB["2. 이전 정상 버전으로 되돌리기"]
    RB --> W2["대기 후 헬스 확인"]
    W2 --> R2{"정상인가"}
    R2 -- "예" --> OKR["status = resolved"]
    R2 -- "아니오" --> NA
    OKR --> N2["알림 2: 자동 복구됨 + 원인 + 고칠 곳"]
    NA --> N3["알림 3: 자동으로 못 고침 + 원인 + 고칠 곳 + 버튼"]
    N2 --> T
    N3 --> T
```

복구 행동(재시작, 되돌리기)은 위 표대로 **코드가 정한다.** AI는 원인 설명 문장을 채울 뿐 행동을 고르지 않는다.

## 5. Google 로그인 (3단계)

```mermaid
sequenceDiagram
    autonumber
    participant U as 사용자
    participant C as 앱 또는 웹
    participant G as Google
    participant S as 서버
    participant D as DB
    U->>C: [Google로 로그인]
    C->>G: 로그인 요청 (앱: 시스템 브라우저 + PKCE)
    G-->>C: id_token
    C->>S: POST /api/auth/google {id_token, platform}
    S->>G: 서명 키로 id_token 검증 (aud, iss, exp)
    G-->>S: 검증 결과
    S->>D: google_sub로 사용자 조회 또는 생성
    S->>D: 리프레시 토큰의 해시 저장
    S-->>C: access_token (짧음) + refresh_token
    C->>C: 앱: 보안 저장소 / 웹: httpOnly 쿠키
    Note over C,S: 이후 모든 요청에 Authorization: Bearer
    C->>S: API 호출
    S-->>C: 401 (토큰 만료)
    C->>S: POST /api/auth/refresh
    S->>D: 쓴 토큰 폐기, 새 토큰 저장 (회전)
    S-->>C: 새 토큰 (재시도)
```

## 6. 환경변수 감지와 입력

```mermaid
flowchart TD
    A["analyzing: 소스 훑기"] --> B["코드 패턴으로 환경변수 이름 추출 (값은 읽지 않음)"]
    B --> C["compose, .env.example, README에서 이름 보태기"]
    C --> D["필수 여부 판정: 코드에 기본값이 있나"]
    D --> E{"종류를 규칙으로 알 수 있나"}
    E -- "예 (라이브러리 단서)" --> F["kind 확정"]
    E -- "아니오" --> G["변수가 쓰인 줄 앞뒤 몇 줄만 AI에 보내 목록에서 고르기"]
    G --> H{"unknown인가"}
    H -- "아니오" --> F
    H -- "예" --> F2["kind = unknown, 사용자가 버튼으로 고름"]
    F --> I["deploy_env_vars에 저장 (status = detected)"]
    F2 --> I
    I --> J["building, pushing (환경변수 없이 진행)"]
    J --> K{"값 없는 필수 변수가 있나"}
    K -- "아니오" --> L["deploying"]
    K -- "예" --> M["멈춤: 입력 화면 안내 (needs_input, D9)"]
    M --> N["사용자가 값 입력 또는 건너뛰기"]
    N --> O["시크릿: 사용자 계정 보안 저장소에 저장, 설정값: 서비스 설정에"]
    O --> P["[이어서 배포] → deploying부터 재개 (이미지 재사용)"]
    P --> L
    L --> Q{"앱이 시작 후 죽었나"}
    Q -- "아니오" --> R["running"]
    Q -- "예" --> S["에러 해설 규칙: KeyError, is not defined 등에서 빠진 이름 추출"]
    S --> T["이름을 목록에 추가 (source = runtime_error)"]
    T --> M
```

찾지 못하는 경우: 이름을 코드가 조립할 때, 설정 파일을 통째로 읽을 때. 이 경우는 위쪽 `K`에서 걸리지 않고, 실행 중 죽은 뒤 `Q`에서 잡힌다.

## 7. 배포 전 분석과 사양 추천

```mermaid
flowchart TD
    A["주소 입력, [분석]"] --> B{"주소·브랜치 검증"}
    B -- "형식 오류" --> X["400 한국어 메시지"]
    B -- "통과" --> C{"같은 레포+커밋 캐시가 있나"}
    C -- "예" --> G
    C -- "아니오" --> D["임시 폴더에 얕게 클론 (읽기만)"]
    D --> E["언어·앱 폴더 판별 (규칙)"]
    E --> F["신호 수집: 의존성, compose, 프레임워크 설정, 스크립트, 진입 파일, 환경변수 이름"]
    F --> G["점수 표(규칙)로 수준 판정"]
    G --> H["필요한 것 목록: DB, 캐시, 워커, 디스크, 환경변수"]
    H --> I["비용 범위 계산 (기준일 있는 단가표)"]
    I --> J["확신도 계산"]
    J --> K["추천 화면 표시"]
    K --> L{"사용자 선택"}
    L -- "추천대로 배포" --> M["POST /api/deploys (size_tier 포함)"]
    L -- "다른 수준 고르기" --> M
    L -- "그만두기" --> N["아무것도 만들지 않음"]
    M --> O["배포 파이프라인 (흐름 2)"]
```

분석 단계는 AWS를 부르지 않고 배포 기록도 만들지 않는다. 임시 폴더는 분석이 끝나면 지운다.

## 8. 알림 발송과 탭 이동

```mermaid
sequenceDiagram
    autonumber
    participant M as 감시·복구 (서버)
    participant N as 알림 서비스
    participant E as 메일 서비스
    participant X as Expo Push
    participant A as 사용자의 앱
    M->>N: incident 이벤트 (kind, i_id)
    N->>N: 사용자 설정 확인 (notify_email, notify_push)
    N->>N: 본문 작성, mask_text
    N->>N: notifications 저장 (inapp)
    N->>E: 메일 발송
    N->>X: 푸시 발송 (등록된 기기마다)
    X-->>A: 푸시 도착
    A->>A: 알림 탭
    A->>A: deploywizard://incidents/{i_id} 로 이동
    A->>N: GET /api/incidents/{i_id}
    N-->>A: 원인, 고칠 곳, 복구 이력
```
