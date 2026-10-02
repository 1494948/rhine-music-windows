/**
 * Rhine Music Windows —— Electron 主进程。
 *
 * 职责：
 *  1. 窗口生命周期（隐藏标题栏 + 拖拽区、单实例、托盘常驻可选）
 *  2. 内嵌音乐库服务，启动即用（不依赖外部浏览器）
 *  3. 文件夹选择器 / 拖拽导入的 IPC 落点
 *  4. GPU 检测与开关下发
 *  5. 动效设置的持久化与广播
 *
 * 跨平台改造依据：docs/CROSS-PLATFORM-AUDIT.md
 */
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, webUtils } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')

const { JsonStore } = require('./store.js')
const { LibraryService } = require('./library-service.js')
const { scanRoots, sanitizeDroppedPaths } = require('./library-scanner.js')
const { detectGpu, buildGpuSwitches, summarizeGpu } = require('./gpu.js')
const { defaultMusicRoots, openUrl, isWindows, revealInFileManager } = require('./platform.js')

/**
 * 应用根目录。
 * 打包后源码位于 `resources/app.asar/electron/main/`，此时
 * `path.resolve(__dirname,'../..')` 会指向 asar 内部而不是应用根，
 * 所以优先用 app.getAppPath()，开发态再回退到 __dirname 推导。
 */
const PROJECT_DIR = app.getAppPath?.() || path.resolve(__dirname, '..', '..')
const DEV_SERVER_URL = process.env.RHINE_DEV_SERVER || 'http://127.0.0.1:5173/'

/** 默认设置 */
const DEFAULT_SETTINGS = {
  port: 5178,
  minimizeToTray: true,
  windowBounds: { width: 1280, height: 860 },
  motion: {
    enabled: true,
    /** 动效时长档位 → 毫秒 */
    duration: 'normal',
    /** 缓动曲线 */
    easing: 'apple',
    /** 性能模式：full=全效果, balanced=平衡, performance=优先帧率 */
    performanceMode: 'balanced',
  },
  gpu: {
    enabled: true,
    /** 用户可强制回退 CPU（软件渲染） */
    forceCpu: false,
  },
  library: {
    roots: [],
  },
  theme: 'system',
}

// ─────────────────────────── 测试模式隔离 ───────────────────────────
// 必须在 requestSingleInstanceLock 之前：锁文件落在 userData 上
const REAL_USER_DATA = app.getPath('userData')
const TEST_MODE = Boolean(
  process.env.RHINE_SELFTEST || process.env.RHINE_SMOKE || process.env.RHINE_SHOT,
)
if (TEST_MODE) {
  const tmp = path.join(app.getPath('temp'), `rhine-test-${process.pid}`)
  fs.mkdirSync(tmp, { recursive: true })
  app.setPath('userData', tmp)
}

app.setAppUserModelId('com.rhinemusic.windows')

// ─────────────────────────── 设置与 GPU 启动开关 ───────────────────────────
let store = null
let settings = { ...DEFAULT_SETTINGS }
/** @type {BrowserWindow|null} */
let mainWindow = null
/** @type {LibraryService|null} */
let service = null
/** @type {object|null} */
let gpuReport = null
let isQuitting = false

/**
 * 设置必须在 app.whenReady 之前就绪——GPU 启动开关只能在进程启动时生效，
 * 改了设置需要重启应用才生效（UI 上会明确提示）。
 */
function readSettingsSync() {
  const file = path.join(REAL_USER_DATA, 'settings.json')
  const defaults = { ...DEFAULT_SETTINGS }
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return {
        ...defaults,
        ...parsed,
        motion: { ...defaults.motion, ...(parsed.motion ?? {}) },
        gpu: { ...defaults.gpu, ...(parsed.gpu ?? {}) },
        library: { ...defaults.library, ...(parsed.library ?? {}) },
        windowBounds: { ...defaults.windowBounds, ...(parsed.windowBounds ?? {}) },
      }
    }
  } catch { /* 用默认值 */ }
  return defaults
}

settings = readSettingsSync()
const gpuPrefs = settings.gpu ?? DEFAULT_SETTINGS.gpu
app.commandLine.appendSwitch(...[]) // no-op 占位，保持 commandLine 可用
const gpuSwitches = buildGpuSwitches({
  enabled: gpuPrefs.enabled !== false,
  vendor: 'unknown', // 启动阶段还不知道真实厂商，用通用高 performant档
  forceCpu: gpuPrefs.forceCpu === true,
})
for (const sw of gpuSwitches) {
  const eq = sw.indexOf('=')
  if (eq > 0) app.commandLine.appendSwitch(sw.slice(0, eq), sw.slice(eq + 1))
  else app.commandLine.appendSwitch(sw)
}

// ─────────────────────────── 单实例 ───────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

// ─────────────────────────── 窗口 ───────────────────────────
function themeColors(mode) {
  return {
    light: { bg: '#f2f2f7', bar: '#ffffff', symbol: '#4b5563' },
    dark: { bg: '#0b0b0f', bar: '#16161a', symbol: '#a7b4c4' },
  }[mode] ?? { bg: '#0b0b0f', bar: '#16161a', symbol: '#a7b4c4' }
}

function resolvedTheme() {
  const pref = settings.theme ?? 'system'
  if (pref === 'light' || pref === 'dark') return pref
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function createWindow() {
  const colors = themeColors(resolvedTheme())
  const bounds = settings.windowBounds ?? DEFAULT_SETTINGS.windowBounds
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 900,
    minHeight: 620,
    x: bounds.x,
    y: bounds.y,
    show: false,
    backgroundColor: colors.bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: colors.bar, symbolColor: colors.symbol, height: 46 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 窗口被遮挡时 Chromium 会把渲染定时器降频到 ~1s，
      // 导致动效与音频进度卡顿 —— 音乐类应用必须关掉
      backgroundThrottling: false,
    },
  })

  win.once('ready-to-show', () => {
    if (!TEST_MODE) win.show()
  })

  // 记录窗口尺寸，供下次启动恢复
  const saveBounds = () => {
    if (!win.isDestroyed() && !win.isMinimized() && !win.isFullScreen()) {
      const b = win.getBounds()
      settings.windowBounds = { width: b.width, height: b.height, x: b.x, y: b.y }
      store?.set('windowBounds', settings.windowBounds)
    }
  }
  win.on('resized', saveBounds)
  win.on('moved', saveBounds)

  win.on('close', (event) => {
    if (!isQuitting && settings.minimizeToTray) {
      event.preventDefault()
      win.hide()
      if (process.platform === 'darwin') app.dock?.hide()
    }
  })

  // 外部链接走系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openUrl(url)
    return { action: 'deny' }
  })
  // 禁止导航离开应用（防止拖拽文件导致窗口直接跳走）
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    if (new URL(url).origin !== new URL(current).origin) {
      event.preventDefault()
      void openUrl(url)
    }
  })

  // 注意：这里**不要**立刻加载内容。
  // 音乐库服务在 createWindow 之后才启动，此时 loadURL 会撞上 ERR_ABORTED。
  // 实际加载由 startServiceAndLoad() 在服务就绪后触发。
  return win
}

async function loadApp(win) {
  const serviceUrl = service?.baseUrl
  const useDev = !serviceUrl && process.env.RHINE_DEV === '1'
  const target = serviceUrl || (useDev ? DEV_SERVER_URL : null)
  if (!target) {
    await loadFallback(win)
    return
  }
  try {
    await win.loadURL(target)
  } catch (error) {
    console.error('[window] 加载失败:', error.message)
    await loadFallback(win)
  }
}

/**
 * 带重试的加载。
 * 服务刚 spawn 出来时，HTTP 端口可能还没进入监听状态，
 * 首次 loadURL 会得到 ERR_ABORTED / ECONNREFUSED。这里最多重试 10 次。
 */
async function loadWithRetry(win, url, attempts = 10) {
  let lastError
  for (let i = 0; i < attempts; i += 1) {
    if (win.isDestroyed()) return false
    try {
      await win.loadURL(url)
      return true
    } catch (error) {
      lastError = error
      await new Promise((r) => setTimeout(r, 300 + i * 200))
    }
  }
  console.error('[window] 重试加载失败:', lastError?.message)
  await loadFallback(win)
  return false
}

/**
 * 加载降级页。
 * 注意：项目路径可能含空格（`C:\AI Document\...`），
 * 必须走 pathToFileURL 而不是字符串拼接，否则 loadFile 会 ERR_ABORTED。
 */
async function loadFallback(win) {
  const { pathToFileURL } = require('node:url')
  const file = path.join(PROJECT_DIR, 'electron', 'renderer', 'fallback.html')
  try {
    await win.loadURL(pathToFileURL(file).href)
  } catch (error) {
    console.error('[window] 降级页也加载失败:', error.message)
  }
}

// ─────────────────────────── 托盘 ───────────────────────────
function createTray() {
  let Tray
  try {
    ;({ Tray } = require('electron'))
  } catch {
    return null
  }
  const iconPath = path.join(PROJECT_DIR, 'assets', 'icon.png')
  if (!fs.existsSync(iconPath)) return null
  try {
    const tray = new Tray(iconPath)
    const { Menu } = require('electron')
    tray.setToolTip('Rhine Music')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => { mainWindow?.show(); mainWindow?.focus() } },
      { type: 'separator' },
      {
        label: '退出',
        click: () => { isQuitting = true; app.quit() },
      },
    ]))
    tray.on('click', () => { mainWindow?.show(); mainWindow?.focus() })
    return tray
  } catch (error) {
    console.error('[tray] 创建失败:', error.message)
    return null
  }
}

// ─────────────────────────── 启动流程 ───────────────────────────
app.whenReady().then(async () => {
  store = new JsonStore(path.join(app.getPath('userData'), 'settings.json'), DEFAULT_SETTINGS)
  // store 里的值优先（含测试模式下的临时目录）
  settings = {
    ...settings,
    ...store.data,
    motion: { ...DEFAULT_SETTINGS.motion, ...(store.get('motion') ?? {}) },
    gpu: { ...DEFAULT_SETTINGS.gpu, ...(store.get('gpu') ?? {}) },
    library: { ...DEFAULT_SETTINGS.library, ...(store.get('library') ?? {}) },
  }

  // 首次启动：探测默认音乐目录作为候选，但不自动扫描（避免未经用户同意就读盘）
  if (!settings.library.roots?.length) {
    const defaults = await defaultMusicRoots()
    if (defaults.length) {
      settings.library.suggestedRoots = defaults
      store.set('library.suggestedRoots', defaults)
    }
  }

  gpuReport = summarizeGpu(await detectGpu(app))
  // 检测到真实厂商后补一次决策，供 UI 展示与二次校准
  if (gpuReport.vendor !== 'unknown') {
    const refined = buildGpuSwitches({
      enabled: settings.gpu.enabled !== false,
      vendor: gpuReport.vendor,
      forceCpu: settings.gpu.forceCpu === true,
    })
    store.set('gpu.detected', {
      vendor: gpuReport.vendor,
      vendorLabel: gpuReport.vendorLabel,
      rendererName: gpuReport.rendererName,
      driverVersion: gpuReport.driverVersion,
      hardwareAccelerated: gpuReport.hardwareAccelerated,
      recommended: gpuReport.recommended,
      switches: refined,
    })
  }

  const port = Number(settings.port) || DEFAULT_SETTINGS.port
  service = new LibraryService({
    projectDir: PROJECT_DIR,
    dataDir: path.join(app.getPath('userData'), 'music-data'),
    port,
    logPath: path.join(app.getPath('userData'), 'logs', 'player-service.log'),
  })

  mainWindow = createWindow()
  createTray()

  // 渲染层就绪后注入启动信息
  mainWindow.webContents.on('did-finish-load', () => {
    sendStartupInfo()
  })

  try {
    const state = await service.ensure()
    if (state.reused) console.log('[service] 复用已在运行的服务')
    if (!mainWindow.isDestroyed()) {
      // 服务刚起来时端口可能还在 backlog 队列里，重试几次再放弃
      await loadWithRetry(mainWindow, service.baseUrl)
      mainWindow.show()
    }
  } catch (error) {
    console.error('[service]', error.message)
    if (!mainWindow.isDestroyed()) {
      await loadFallback(mainWindow)
      mainWindow.show()
    }
    if (error.code === 'PORT_OCCUPIED') {
      dialog.showErrorBox('端口被占用', error.message)
    }
  }

  nativeTheme.on('updated', () => {
    const colors = themeColors(resolvedTheme())
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(colors.bg)
      mainWindow.setTitleBarOverlay({ color: colors.bar, symbolColor: colors.symbol, height: 46 })
    }
    mainWindow?.webContents.send('theme:changed', resolvedTheme())
  })

  if (process.env.RHINE_SELFTEST) runSelfTest()
  if (process.env.RHINE_SHOT) runShotMode()
}).catch((error) => {
  console.error('[startup] 致命错误:', error.stack || error.message)
  app.quit()
})

/** 组装要送到渲染层的启动信息（同步/异步两条路径共用）。 */
function buildStartupPayload() {
  return {
    platform: process.platform,
    isWindows,
    version: app.getVersion(),
    settings: {
      motion: settings.motion,
      gpu: settings.gpu,
      library: settings.library,
      theme: resolvedTheme(),
      minimizeToTray: settings.minimizeToTray,
      port: settings.port,
    },
    gpu: gpuReport,
    paths: {
      userData: app.getPath('userData'),
      musicData: service?.dataDir ?? '',
      log: service?.logPath ?? '',
    },
  }
}

function sendStartupInfo() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('app:startup', buildStartupPayload())
}

// ─────────────────────────── IPC ───────────────────────────
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(event, ...args) }
    } catch (error) {
      // 错误必须回传给渲染层，不能只打日志——否则 UI 会一直转圈
      return { ok: false, error: error.message, code: error.code ?? null }
    }
  })
}

handle('library:pickFolders', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  const result = await dialog.showOpenDialog(win, {
    title: '选择音乐文件夹',
    buttonLabel: '导入',
    properties: ['openDirectory', 'multiSelections', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths.length) return { canceled: true, roots: [] }
  return { canceled: false, roots: result.filePaths }
})

handle('library:scan', async (_event, roots) => {
  const clean = sanitizeDroppedPaths(Array.isArray(roots) ? roots : [])
  if (!clean.length) return { roots: [], files: [], stats: {}, errors: [], rejectedRoots: [] }
  const result = await scanRoots(clean)
  settings.library.roots = result.roots
  store.set('library.roots', result.roots)
  return result
})

handle('library:getRoots', async () => ({
  roots: settings.library.roots ?? [],
  suggested: settings.library.suggestedRoots ?? [],
}))

handle('library:removeRoot', async (_event, root) => {
  const key = String(root ?? '')
  settings.library.roots = (settings.library.roots ?? []).filter((r) => r !== key)
  store.set('library.roots', settings.library.roots)
  return { roots: settings.library.roots }
})

handle('library:reveal', async (_event, target) => ({ ok: await revealInFileManager(String(target ?? '')) }))

handle('gpu:getReport', async () => gpuReport ?? (gpuReport = summarizeGpu(await detectGpu(app))))

handle('settings:get', async () => ({
  motion: settings.motion,
  gpu: settings.gpu,
  library: settings.library,
  theme: resolvedTheme(),
  minimizeToTray: settings.minimizeToTray,
  port: settings.port,
}))

handle('settings:set', async (_event, patch) => {
  const { motion, gpu, theme, minimizeToTray, port } = patch ?? {}
  if (motion) {
    settings.motion = { ...settings.motion, ...motion }
    store.set('motion', settings.motion)
    broadcastMotion()
  }
  if (gpu) {
    settings.gpu = { ...settings.gpu, ...gpu }
    store.set('gpu', settings.gpu)
  }
  if (theme !== undefined) {
    settings.theme = theme
    store.set('theme', theme)
    const colors = themeColors(resolvedTheme())
    mainWindow?.setBackgroundColor(colors.bg)
    mainWindow?.setTitleBarOverlay({ color: colors.bar, symbolColor: colors.symbol, height: 46 })
  }
  if (minimizeToTray !== undefined) {
    settings.minimizeToTray = Boolean(minimizeToTray)
    store.set('minimizeToTray', settings.minimizeToTray)
  }
  if (port !== undefined) {
    const p = Number(port)
    if (Number.isInteger(p) && p > 1024 && p < 65535) {
      settings.port = p
      store.set('port', p)
    }
  }
  // GPU / 端口改动需要重启才生效，明确告知渲染层
  return {
    settings: await handleGet(),
    restartRequired: true,
  }
})

async function handleGet() {
  return {
    motion: settings.motion,
    gpu: settings.gpu,
    library: settings.library,
    theme: resolvedTheme(),
    minimizeToTray: settings.minimizeToTray,
    port: settings.port,
  }
}

function broadcastMotion() {
  mainWindow?.webContents.send('motion:changed', settings.motion)
}

// 渲染层拖拽文件夹进来时取真实路径
handle('library:resolveDropped', async (_event, files) => {
  const paths = []
  for (const file of Array.isArray(files) ? files : []) {
    try {
      const p = webUtils.getPathForFile(file)
      if (p) paths.push(p)
    } catch { /* 非文件对象 */ }
  }
  return sanitizeDroppedPaths(paths)
})

handle('shell:openPath', async (_event, target) => {
  const err = await shell.openPath(String(target ?? ''))
  if (err) throw new Error(err)
  return true
})

handle('app:info', async () => ({
  version: app.getVersion(),
  platform: process.platform,
  userData: app.getPath('userData'),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
}))

/**
 * 同步返回启动信息。
 *
 * 为什么需要同步版本：preload 在页面任何脚本之前执行，
 * 而上游的 Web 界面代码不认识 Electron、没有机会 await 异步 IPC。
 * 用 sendSync 让启动信息在 preload 阶段就拿到，
 * 再由 preload 注入到 window 供界面代码同步读取。
 */
ipcMain.on('app:startupSync', (event) => {
  event.returnValue = buildStartupPayload()
})

// ─────────────────────────── 退出 ───────────────────────────
app.on('before-quit', () => {
  isQuitting = true
  // 少了这两行，「操作完立刻关程序」会丢掉最后一次改动
  try { store?.flush() } catch { /* ignore */ }
  try { service?.stop() } catch { /* ignore */ }
})

app.on('window-all-closed', () => {
  if (process.platform === 'darwin' || isQuitting) app.quit()
})

// ─────────────────────────── 自检 / 截图 ───────────────────────────
async function runSelfTest() {
  await new Promise((r) => setTimeout(r, 2500))
  const probe = `
    (async () => {
      const out = { pass: [], fail: [], info: {} }
      try {
        const api = window.rhine
        out.info.hasApi = typeof api === 'object' && api !== null
        const st = api?.startup ?? null
        out.info.startup = !!st
        out.info.platform = st?.platform ?? null
        out.info.gpuVendor = st?.gpu?.vendor ?? null
        out.info.gpuRenderer = st?.gpu?.rendererName ?? null
        out.info.motion = st?.settings?.motion ?? null
        out.info.libraryRoots = st?.settings?.library?.roots?.length ?? null
        out.info.errors = window.__RHINE_ERRORS__ || []

        if (!out.info.hasApi) out.fail.push('window.rhine 未注入（preload 未执行）')
        else out.pass.push('preload API 注入成功')
        if (!st) out.fail.push('startup 同步载荷缺失')
        else out.pass.push('启动信息就绪 platform=' + st.platform)
        return JSON.stringify(out)
      } catch (e) {
        out.fail.push('probe: ' + e.message)
        return JSON.stringify(out)
      }
    })()
  `
  try {
    const raw = await mainWindow.webContents.executeJavaScript(probe, true)
    console.log('SELFTEST_RESULT ' + raw)
  } catch (error) {
    console.log('SELFTEST_RESULT ' + JSON.stringify({ fail: [error.message] }))
  }
  isQuitting = true
  app.quit()
}

async function runShotMode() {
  await new Promise((r) => setTimeout(r, 3000))
  const outDir = path.join(PROJECT_DIR, 'preview', 'desktop')
  await fsp.mkdir(outDir, { recursive: true })
  try {
    const img = await mainWindow.webContents.capturePage()
    await fsp.writeFile(path.join(outDir, 'main.png'), img.toPNG())
    console.log('SHOT_SAVED ' + outDir)
  } catch (error) {
    console.error('[shot]', error.message)
  }
  isQuitting = true
  app.quit()
}
