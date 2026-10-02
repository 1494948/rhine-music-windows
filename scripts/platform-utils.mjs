/**
 * 跨平台「打开浏览器 / 打开文件管理器」实现。
 *
 * 替换上游 `scripts/launch-music.mjs` 中写死的 `/usr/bin/open`。
 * 见 docs/CROSS-PLATFORM-AUDIT.md 第 4 节。
 */
import { spawn } from 'node:child_process'
import { probePort, isWindows, isDarwin, openUrl } from './platform.js'

export { probePort, isWindows, isDarwin, openUrl }

/**
 * 用系统默认程序打开本地文件。
 * @param {string} target 绝对路径
 * @returns {Promise<boolean>}
 */
export function openWithDefaultApp(target) {
  return new Promise((resolve) => {
    try {
      if (isWindows) {
        // start 的首个引号参数是窗口标题，缺失会导致带空格路径被截断
        const child = spawn('cmd', ['/c', 'start', '', target], {
          detached: true, stdio: 'ignore', windowsHide: true,
        })
        child.unref()
        resolve(true)
        return
      }
      const command = isDarwin ? 'open' : 'xdg-open'
      const child = spawn(command, [target], { detached: true, stdio: 'ignore' })
      child.unref()
      resolve(true)
    } catch {
      resolve(false)
    }
  })
}
