import { register } from 'node:module'

// 이 파일을 먼저 불러온 뒤 화면 모듈을 동적으로 가져온다
register('./aliasHooks.mjs', import.meta.url)
