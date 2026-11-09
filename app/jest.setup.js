// 안전 영역 훅은 SafeAreaProvider 없이 부르면 오류를 내므로, 테스트에서는 라이브러리가 제공하는 목(mock)으로 바꾼다 (여백은 모두 0)
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default)
