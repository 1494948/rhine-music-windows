import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

/**
 * Vite 配置。
 *
 * 上游是纯 Web 项目，没有 vite.config。上游的音乐服务
 * （scripts/music-server.mjs）直接伺服仓库根目录，所以：
 *  - 开发时服务跑在 5178，这里让 Vite 也监听 5178 并让出端口
 *  - electron/renderer/ 需要通过 /electron/ 路径暴露给页面
 *    （index.html 里用 <link href="/electron/renderer/motion.css"> 引用）
 */
export default defineConfig({
  // 与 electron/main/main.js 里的 DEFAULT_SETTINGS.port 保持一致
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  resolve: {
    alias: {
      // 页面里用 /electron/renderer/xxx 的绝对路径引用桌面模块
      '@desktop': fileURLToPath(new URL('./electron/renderer', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 三个.js 库较大，打包时给出警告阈值提示
    chunkSizeWarningLimit: 1500,
  },
})
