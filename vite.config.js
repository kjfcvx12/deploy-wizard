import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// 백·프론트를 나누지 않는다. 화면 코드는 각 기능 폴더의 ui/ 에 있다
//   features/<기능>/ui/   기능 화면
//   shared/ui/            공용 (진입점, 레이아웃, 스타일)
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@features': fileURLToPath(new URL('./features', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 개발 중에는 /api 를 FastAPI(8081)로 넘긴다
    proxy: { '/api': 'http://localhost:8081' },
    watch: { ignored: ['**/.venv/**', '**/data/**', '**/tests/**', '**/*.py'] },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
