// 안전 영역 훅은 SafeAreaProvider 없이 부르면 오류를 내므로, 테스트에서는 라이브러리가 제공하는 목(mock)으로 바꾼다 (여백은 모두 0)
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default)

// AsyncStorage 는 네이티브 모듈이 없으면 쓸 수 없으므로, 라이브러리가 제공하는 공식 jest 목(2.x: jest/async-storage-mock)으로 바꾼다
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'))

// expo-notifications 는 네이티브 모듈이라 jest 에서는 쓸 수 없으므로 목으로 바꾼다 (권한은 '허용', 알림 응답은 없음). 각 테스트가 필요한 동작을 mockResolvedValue 등으로 덮어쓴다
jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 5, HIGH: 6, MAX: 7 },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted', granted: true, canAskAgain: true })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted', granted: true, canAskAgain: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({ type: 'expo', data: 'ExponentPushToken[jest-mock-token]' })),
  setNotificationChannelAsync: jest.fn(async () => null),
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
}))

// expo-secure-store 는 네이티브 모듈이라 jest 에서는 메모리 Map 으로 바꾼다 (설치한 58.0.3 의 getItemAsync·setItemAsync·deleteItemAsync 이름 그대로). __reset 으로 비우고 __items 로 들여다본다
jest.mock('expo-secure-store', () => {
  const items = new Map()
  return {
    getItemAsync: jest.fn(async (key) => (items.has(key) ? items.get(key) : null)),
    setItemAsync: jest.fn(async (key, value) => { items.set(key, String(value)) }),
    deleteItemAsync: jest.fn(async (key) => { items.delete(key) }),
    isAvailableAsync: jest.fn(async () => true),
    __reset: () => items.clear(),
    __items: () => items,
  }
})

// Google 로그인 라이브러리(17.0.0)는 네이티브 모듈이 없으면 가져오는 순간 던지므로, jest 에서는 목으로 바꾼다 (이름·모양은 설치한 버전의 GoogleSignin·statusCodes 그대로). 각 테스트가 signIn 등을 mockResolvedValue 로 덮어쓴다
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(async () => true),
    signIn: jest.fn(async () => ({ type: 'success', data: { idToken: 'jest-mock-id-token' } })),
    signOut: jest.fn(async () => null),
  },
  statusCodes: {
    SIGN_IN_CANCELLED: '12501',
    IN_PROGRESS: 'ASYNC_OP_IN_PROGRESS',
    PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
    SIGN_IN_REQUIRED: '4',
    NULL_PRESENTER: 'NULL_PRESENTER',
  },
}))
