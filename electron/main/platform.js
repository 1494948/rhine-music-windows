/**
 * 跨平台路径与默认音乐目录。
 *
 * 替换上游写死的 macOS 路径（`/Users/你的用户名/Music`、
 * `scripts/launch-music.mjs` 里的 `/usr/bin/open` 等）。
 *
 * 依据：docs/CROSS-PLATFORM-AUDIT.md 第3、4 节。
 */
const { execFile } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const fsp = require('node:fs/promises')

const execFileAsync = promisify(execFile)

const isWindows = process.platform === 'win32'
const isDarwin = process.platform === 'darwin'
const isLinux = process.platform === 'linux'

/** 音乐文件扩展名白名单（沿用上游 music-library.mjs 的口径）。 */
const AUDIO_EXTENSIONS = new Set([
  '.flac', '.wav', '.m4a', '.mp4', '.alac', '.dsf', '.dff',
  '.mp3', '.aac', '.aiff', '.aif', '.ogg', '.opus',
])

/** 排除的目录名（扫描时跳过，避免权限噪音与无意义开销）。 */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.cache', 'AppData', '$RECYCLE.BIN',
  'System Volume Information', '.Trash', '.Trashes',
  '.Spotlight-V100', '.fseventsd', '.DocumentRevisions-V100',
])

/**
 * 当前平台的默认音乐目录。
 * @returns {Promise<string[]>} 存在的候选目录（可能为空数组）
 */
async function defaultMusicRoots() {
  const home = os.homedir()
  /** @type {string[]} */
  const candidates = isWindows
    ? [
        path.join(home, 'Music'),
        path.join(home, '音乐'),
        path.join(home, 'Downloads', 'Music'),
        path.join(home, 'OneDrive', 'Music'),
      ]
    : isDarwin
      ? [path.join(home, 'Music'), path.join(home, 'Downloads', 'Music')]
      : [path.join(home, 'Music'), path.join(home, '音乐')]

  const found = []
  for (const dir of candidates) {
    if (await pathExists(dir)) found.push(dir)
  }
  return found
}

/** @param {string} p */
async function pathExists(p) {
  try {
    await fsp.stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * 跨平台打开URL。
 * 替换上游 `spawnSync('/usr/bin/open', [url])` —— 该实现在 Windows 上必然失败。
 * @param {string} url
 * @returns {Promise<boolean>} 是否成功
 */
async function openUrl(url) {
  try {
    if (isWindows) {
      // `start` 的第一个引号参数是窗口标题，不可省略，否则带空格的路径会被截断
      await execFileAsync('cmd', ['/c', 'start', '', url], { windowsHide: true })
    } else if (isDarwin) {
      await execFileAsync('open', [url])
    } else {
      await execFileAsync('xdg-open', [url])
    }
    return true
  } catch {
    return false
  }
}

/**
 * 跨平台探测端口占用情况。
 * 替换上游 `launch-music.mjs` 中 `process.platform !== 'darwin'` 直接 return false 的写法，
 * 该实现在 Windows 上导致端口占用检测完全失效。
 *
 * @param {number} port
 * @param {string} projectDir 用于二次确认占用者是否为本项目
 * @returns {Promise<{ occupied: boolean, pid: number|null, ours: boolean }>}
 */
async function probePort(port, projectDir) {
  const listeners = isWindows ? await probeWindows(port) : await probeUnix(port)
  if (!listeners.length) return { occupied: false, pid: null, ours: false }

  // 多个进程同时监听时（SO_REUSEPORT），只要有一个是本项目就算 ours
  for (const entry of listeners) {
    const cmdline = await readCmdline(entry.pid)
    if (!cmdline) continue
    if (/music-server\.m?js/i.test(cmdline) && cmdline.includes(normalizeForCompare(projectDir))) {
      return { occupied: true, pid: entry.pid, ours: true }
    }
  }
  return { occupied: true, pid: listeners[0].pid, ours: false }
}

/** @returns {Promise<Array<{pid:number}>>} */
async function probeWindows(port) {
  const { stdout } = await execFileAsync(
    'netstat',
    ['-ano', '-p', 'tcp'],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  )
  const pids = new Set()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    const cols = line.trim().split(/\s+/)
    // 格式：TCP  0.0.0.0:5173  0.0.0.0:0  LISTENING  1234
    if (cols.length < 5) continue
    const local = cols[1] ?? ''
    if (!local.endsWith(`:${port}`)) continue
    const pid = Number(cols[4])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids].map((pid) => ({ pid }))
}

/** @returns {Promise<Array<{pid:number}>>} */
async function probeUnix(port) {
  try {
    const { stdout } = isDarwin
      ? await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'])
      : await execFileAsync('ss', ['-lptnH', `sport = :${port}`])
    const pids = new Set()
    for (const m of stdout.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]))
    return [...pids].map((pid) => ({ pid }))
  } catch {
    return []
  }
}

/** 读取进程命令行（跨平台）。 @returns {Promise<string|null>} */
async function readCmdline(pid) {
  try {
    if (isWindows) {
      // wmic 在新版本 Windows 已废弃，回退到 PowerShell CIM
      try {
        const { stdout } = await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
          { windowsHide: true, maxBuffer: 1024 * 1024 },
        )
        return stdout.trim() || null
      } catch {
        const { stdout } = await execFileAsync(
          'wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'],
          { windowsHide: true },
        )
        return stdout.split(/\r?\n/).slice(1).join(' ').trim() || null
      }
    }
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='])
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** 路径比较归一化：统一分隔符、去掉末尾斜杠、区分大小写（Windows 不敏感）。 */
function normalizeForCompare(p) {
  const unified = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return isWindows ? unified.toLowerCase() : unified
}

/** @param {string} dir @returns {boolean} */
function shouldSkipDir(dir) {
  return SKIP_DIRS.has(path.basename(dir))
}

/**
 * 跨平台在文件管理器中显示文件。
 * 替换 macOS 的 `open -R`（Windows 无此命令）。
 * @param {string} target
 * @returns {Promise<boolean>}
 */
async function revealInFileManager(target) {
  try {
    if (isWindows) {
      await execFileAsync('explorer.exe', [`/select,${target}`], { windowsHide: true })
      return true
    }
    if (isDarwin) {
      await execFileAsync('open', ['-R', target])
      return true
    }
    await execFileAsync('xdg-open', [path.dirname(target)])
    return true
  } catch {
    return false
  }
}

module.exports = {
  isWindows, isDarwin, isLinux,
  AUDIO_EXTENSIONS,
  defaultMusicRoots, pathExists, openUrl,
  probePort, normalizeForCompare, shouldSkipDir, revealInFileManager,
}
