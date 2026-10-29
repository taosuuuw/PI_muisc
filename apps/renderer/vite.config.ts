import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 打包后由 Electron 以 file:// 加载，必须用相对路径，否则资源全部 404。
  base: './',
  /*
   * Worker 必须用 ES 格式：onnxruntime-web 的 wasm 加载器里有 top-level await
   * （`await import('worker_threads')` 那段环境探测），IIFE 格式打不出来。
   */
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 桌面端不需要为老浏览器降级，Electron 44 的 Chromium 很新。
    target: 'chrome130',
    sourcemap: true,
  },
});
