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
