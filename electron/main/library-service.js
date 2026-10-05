/**
 * 内嵌上游音乐库服务（`scripts/music-server.mjs`）的生命周期管理。
 *
 * 上游是「起Node 服务 + 开浏览器」的模式；桌面版把服务收进Electron 主进程管理：
 * 窗口关闭 → 服务保留（最小化到托盘）；真正退出 → 服务结束。
 *
 * 跨平台要点见 docs/CROSS-PLATFORM-AUDIT.md：
 *  - 端口占用检测改为三平台分派（不再是 darwin-only）
 *  - 服务 ready 后不调`/usr/bin/open`，由 Electron 直接 loadURL
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
// 注意：Electron 的 `net` 模块没有 connect（那是 Node 的 net）。
// 用 Node 的 net 做本机端口探测，不要用 require('electron').net。
const net = require('node:net')
const { probePort } = require('./platform.js')

/**
 * 打包后 asar 里的脚本要改写为 asar.unpacked 真实路径才能被 node 执行。
 *
 * 这一步是打包版能否启动服务的关键：
 * `app.getAppPath()` 在打包后返回 `.../resources/app.asar`，
 * 而 asar 里的 .mjs 只是虚拟路径，交给外部进程执行会得到 ENOENT。
 */
function unpackAware(p) {
  const rewritten = String(p).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
  if (rewritten === p) return p
  // 只有目标真实存在时才返回改写后的路径，避免误伤非 asar 路径
  try {
    return fsSync.existsSync(rewritten) ? rewritten : p
  } catch {
    return p
  }
}

class LibraryService {
  /**
   * @param {{projectDir:string, dataDir:string, port:number, logPath:string}} options
   */
  constructor({ projectDir, dataDir, port, logPath }) {
    this.projectDir = projectDir
    this.dataDir = dataDir
    this.port = port
    this.logPath = logPath
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null
    this.portReady = false
    /**
     * 最近一次启动失败的原因（spawn 错误 / 进程退出码 / 就绪超时）。
     * 供主进程在降级页展示——「服务未就绪」却不说明原因，用户无从排查。
     * @type {string|null}
     */
    this.lastError = null
    /**
     * spawn 时刻的环境快照（execPath/脚本路径/是否存在/工作目录/运行时判定）。
     * 远程机型排障时这组信息基本能定位到具体差异。
     * @type {object|null}
     */
    this.spawnDiagnostics = null
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`
  }

  /**
   * 若端口上已是自己启动的服务则直接复用。
   * @returns {Promise<{reused:boolean, port:number}>}
   */
  async ensure() {
    const state = await probePort(this.port, this.projectDir)
    console.log(`[service] 端口 ${this.port} 探测: ${JSON.stringify(state)}`)
    if (state.ours) {
      this.portReady = true
      return { reused: true, port: this.port }
    }
    if (state.occupied) {
      const err = new Error(
        `端口 ${this.port} 已被其他程序占用（PID ${state.pid}）。` +
        '请关闭占用程序，或在设置中更换端口。',
      )
      err.code = 'PORT_OCCUPIED'
      throw err
    }

    this.lastError = null
    await this.#spawnService()

    // 不能 spawn 完就宣布就绪：必须等到「端口上确实是我们的服务」。
    // 他机实测：服务进程可能在启动瞬间被拦杀（杀软/策略），
    // 此时主进程若无脑置 portReady=true，只会得到一个没有原因的降级页。
    // 判据用「本进程能否真的连上」（#probe 的 TCP connect），而不是
    // probePort().ours —— 后者需要查询外部进程的命令行来确认端口归属，
    // 而本机系统命令受限、新版 Windows 又移除了 wmic，
    // 命令行取不到时 ours 恒为 false，会把「服务其实正常」误判成启动失败。
    // 端口归属只在「启动前判断是否复用已有服务」时用，就绪判定用连通性更可靠。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.lastError) break
      if (this.child && this.child.exitCode !== null) break
      if (await this.#probe()) {
        this.portReady = true
        return { reused: false, port: this.port }
      }
      await new Promise((r) => setTimeout(r, 500))
    }

    this.portReady = false
    const tail = await this.readLogTail(20)
    const err = new Error(
      `音乐库服务启动失败：${this.lastError ?? '端口未进入监听'}\n` +
        `日志：${this.logPath}\n${tail}`,
    )
    err.code = 'SERVICE_START_FAILED'
    throw err
  }

  /**
   * 选一个磁盘上真实存在的目录作为子进程 cwd。
   *
   * 打包后 `app.getAppPath()` 返回 `.../resources/app.asar`，
   * **那是一个文件，不是目录**（尽管 `existsSync` 返回 true）。
   * 把它当cwd 传给 spawn，CreateProcess 会失败并报 ENOENT ——
   * 错误信息里只显示可执行文件路径，完全看不出是 cwd 的问题，
   * 极易误判成"node 找不到"。实测踩过。
   *
   * 首选是**脚本自身所在目录**：它经过 `unpackAware` 验证必然存在，
   * 且服务脚本本身也从这里解析相对资源，语义最自然。
   *
   * @param {string} script 已解包的脚本绝对路径
   * @returns {string}
   */
  #realCwd(script) {
    const candidates = [
      script ? path.dirname(script) : null,
      this.projectDir,
      path.dirname(this.projectDir),                        // .../resources
      path.dirname(process.execPath),                       // exe 同级
      app.getPath('userData'),
    ]
    for (const dir of candidates) {
      if (!dir) continue
      try {
        //必须用 isDirectory()：asar 那个路径 existsSync 为 true 但不是目录
        if (fsSync.statSync(dir).isDirectory()) return dir
      } catch { /* 忽略探测异常 */ }
    }
    return process.cwd()
  }

  /**
   * 解析用于跑 Node 脚本的可执行文件。
   *
   * 优先级：
   *  1. `RHINE_NODE_PATH` —— 显式指定，最高优先级
   *  2. 开发态：托管的 node.exe，或 PATH 里的 node
   *  3. 打包态：exe 同级的 node.exe，或 PATH 里的 node
   *  4. 兜底 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`
   *
   * 为什么不用 `process.execPath` 作首选：Windows GUI 子系统的 exe
   * 走 Node 参数解析路径时行为不可靠（实测会出现 bad option）。
   * 实测打包版用ELECTRON_RUN_AS_NODE 跑 .mjs 是可行的，
   * 所以兜底路径保留，但不优先。
   *
   * @returns {string}
   */
  #nodeExecPath() {
    const candidates = [process.env.RHINE_NODE_PATH].filter(Boolean)

    // 同级目录（便携版常见布局）与 PATH
    candidates.push(path.join(path.dirname(process.execPath), 'node.exe'))
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, 'node.exe'))
    }
    if (!app.isPackaged) {
      // 开发态：托管 node 目录里通常有
      candidates.push(process.execPath.replace(/[\\/]electron\.exe$/i, ''))
    }

    const seen = new Set()
    for (const candidate of candidates) {
      const key = String(candidate).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      try {
        if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isFile()) return candidate
      } catch { /* 忽略探测异常，继续下一个 */ }
    }

    console.warn('[service] 未找到独立 node.exe，退回 Electron 内置运行时。')
    return process.execPath
  }

  async #spawnService() {
    await fs.mkdir(this.dataDir, { recursive: true })
    await fs.mkdir(path.dirname(this.logPath), { recursive: true })
    const log = await fs.open(this.logPath, 'a')
    try {
      await log.write(`\n[${new Date().toISOString()}] 启动音乐库服务，端口 ${this.port}\n`)
      const script = unpackAware(path.join(this.projectDir, 'scripts', 'music-server.mjs'))
      const execPath = this.#nodeExecPath()
      const cwd = this.#realCwd(script)
      // 判定「用的是 Electron 自带运行时」，判据是**与自身可执行文件相同**。
      //
      // 不能用 `basename === 'electron.exe'`：打包后 exe 叫 `Rhine Music.exe`，
      // 那个判断永远为false，于是 ELECTRON_RUN_AS_NODE 被置空，
      // 行为取决于 Electron 对「空值环境变量」的处理——非常脆弱。
      const usingElectronRuntime =
        path.resolve(execPath).toLowerCase() === path.resolve(process.execPath).toLowerCase()
      // 诊断快照：spawn 失败时唯一能定位问题的信息。
      // 存进实例供降级页展示——打包版用户看不到主进程 console。
      this.spawnDiagnostics = {
        execPath,
        script,
        scriptExists: fsSync.existsSync(script),
        cwd,
        cwdExists: fsSync.existsSync(cwd),
        projectDir: this.projectDir,
        projectDirExists: fsSync.existsSync(this.projectDir),
        usingElectronRuntime,
        electron: process.versions.electron,
        node: process.versions.node,
        platform: process.platform,
      }
      console.log('[service] spawn 诊断', JSON.stringify(this.spawnDiagnostics))
      this.child = spawn(execPath, [script, '--port', String(this.port)], {
        // cwd 必须是磁盘上真实存在的目录。
        // 打包后 this.projectDir 是 `.../resources/app.asar` —— 那是虚拟路径，
        // 用它当 cwd 会让 CreateProcess 直接报 ENOENT（连 node 路径是对的也一样）。
        cwd,
        env: {
          ...process.env,
          MUSIC_DATA_DIR: this.dataDir,
          // 打包版会带上外层 shell 的 NODE_OPTIONS，Electron 会拒绝并报警
          NODE_OPTIONS: '',
          // 用 Electron 自带运行时时必须设这个变量，否则它会当图形应用启动；
          // 用真实 node.exe 时必须清掉，否则 node 会拒绝启动。
          ELECTRON_RUN_AS_NODE: usingElectronRuntime ? '1' : '',
        },
        stdio: ['ignore', log.fd, log.fd],
        windowsHide: true,
      })
      this.child.once('error', (error) => {
        this.portReady = false
        this.lastError = `spawn 失败: ${error.message}（code=${error.code ?? '-'}，execPath=${execPath}）`
        console.error('[service] 启动失败:', this.lastError)
        // 必须落盘：用户能拿到的只有日志文件
        void fs
          .appendFile(this.logPath, `[${new Date().toISOString()}] ${this.lastError}\n`)
          .catch(() => {})
      })
      this.child.once('exit', (code, signal) => {
        this.portReady = false
        const note = `服务进程退出 code=${code ?? '-'} signal=${signal ?? '-'}`
        if (!this.lastError) this.lastError = note
        console.error(`[service] ${note}，日志：${this.logPath}`)
        void fs
          .appendFile(this.logPath, `[${new Date().toISOString()}] ${note}\n`)
          .catch(() => {})
      })
    } finally {
      await log.close()
    }

    // 轮询就绪。用「本进程真的能连上」判定，而不是「进程还活着」——
    // 上游 launch-music.mjs 的做法，这里保留同样的稳健性。
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (this.child.exitCode !== null) break
      if (await this.#probe()) return
      await new Promise((r) => setTimeout(r, 250))
    }
    // 就绪失败不在此处抛出：统一由 ensure() 汇总 lastError 后抛出，
    // 保证「服务起不来」永远只有一个带完整上下文的错误出口。
    if (!this.lastError) this.lastError = '服务进程存活但端口始终未进入监听'
  }

  async #probe() {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: this.port })
      const finish = (ok) => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(ok)
      }
      socket.setTimeout(1000)
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
      socket.once('timeout', () => finish(false))
    })
  }

  async readLogTail(lines = 16) {
    try {
      const text = await fs.readFile(this.logPath, 'utf8')
      return text.split('\n').slice(-lines).join('\n')
    } catch {
      return '（无日志）'
    }
  }

  stop() {
    if (!this.child || this.child.exitCode !== null) return
    this.child.kill()
    this.child = null
    this.portReady = false
  }
}

module.exports = { LibraryService }
