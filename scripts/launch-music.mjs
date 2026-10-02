import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SERVICE_ID = 'rhine-local-music'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const exists = async (file) => fs.access(file).then(() => true, () => false)

export function supportedNode(version) {
  const [major, minor] = version.split('.').map(Number)
  return major === 20 ? minor >= 19 : major === 22 ? minor >= 12 : major > 22
}

function requestJson(port, route) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: route, timeout: 1500 }, (response) => {
      const chunks = []
      let length = 0
      response.on('data', (chunk) => {
        length += chunk.length
        if (length > 16 * 1024 * 1024) return response.destroy(new Error('服务响应过大'))
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
        resolve({ status: response.statusCode, body })
      })
    })
    request.on('timeout', () => request.destroy(new Error('服务响应超时')))
    request.on('error', reject)
  })
}

// Older running versions have no health endpoint. Verify both their executable
// script and working directory before using their legacy API as identification.
//
// 跨平台改造（2026-10-02）：原实现用 `process.platform !== 'darwin'` 直接返回 false，
// 导致 Windows 上端口占用检测完全失效（既不复用已有服务，也不提示端口被占）。
// 现改为三平台分派，见 docs/CROSS-PLATFORM-AUDIT.md 第 1.1 节。
const IS_WINDOWS = process.platform === 'win32'
const IS_DARWIN = process.platform === 'darwin'

/** 归一化路径用于比较：统一分隔符、去尾斜杠；Windows 下不区分大小写。 */
const comparable = (p) => {
  const unified = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return IS_WINDOWS ? unified.toLowerCase() : unified
}

/** @returns {number[]} 监听该端口的 PID 列表 */
function listeningPids(port, run) {
  if (IS_WINDOWS) {
    const { stdout = '' } = run('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
    const pids = new Set()
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue
      const cols = line.trim().split(/\s+/)
      if (cols.length < 5) continue
      if (!(cols[1] ?? '').endsWith(`:${port}`)) continue
      const pid = Number(cols[4])
      if (Number.isInteger(pid) && pid > 0) pids.add(pid)
    }
    return [...pids]
  }
  if (IS_DARWIN) {
    const { stdout = '' } = run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
    return [...new Set(stdout.trim().split(/\s+/))].filter((pid) => /^\d+$/.test(pid)).map(Number)
  }
  try {
    const { stdout = '' } = run('ss', ['-lptnH', `sport = :${port}`], { encoding: 'utf8' })
    return [...new Set([...stdout.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))]
  } catch {
    return []
  }
}

/** @returns {string} 进程命令行 */
function processCommand(pid, run) {
  if (IS_WINDOWS) {
    const { stdout = '' } = run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', windowsHide: true },
    )
    return stdout.trim()
  }
  const command = IS_DARWIN ? '/bin/ps' : 'ps'
  const { stdout = '' } = run(command, ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return stdout.trim()
}

export function sameLegacyProcess(port, projectDir, run = spawnSync) {
  const pids = listeningPids(port, run)
  if (!pids.length) return false
  const wantDir = comparable(projectDir)
  return pids.some((pid) => {
    let command
    try {
      command = processCommand(pid, run)
    } catch {
      return false
    }
    if (!command || !/music-server\.m?js/i.test(command)) return false
    // 命令行里必须同时出现本项目目录，避免把别的项目的同名服务认成自己的
    if (!command.replace(/\\/g, '/').toLowerCase().includes(wantDir)) return false
    return true
  })
}

export async function probeMusicService(port, projectDir, { request = requestJson, legacy = sameLegacyProcess } = {}) {
  let response
  try { response = await request(port, '/api/health') } catch (error) {
    if (error.code === 'ECONNREFUSED') return { kind: 'free', port }
    return { kind: legacy(port, projectDir) ? 'starting' : 'occupied', port }
  }
  const health = response.body
  if (response.status === 200 && health?.service === SERVICE_ID && health.projectDir === projectDir && Number.isSafeInteger(health.pid)) return { kind: 'ours', port }
  if (!legacy(port, projectDir)) return { kind: 'occupied', port }
  try {
    const [config, library] = await Promise.all([request(port, '/api/config'), request(port, '/api/library')])
    if (config.status === 200 && Array.isArray(config.body?.roots) && library.status === 200 && library.body?.version === 1 && Array.isArray(library.body.albums) && Array.isArray(library.body.genres)) return { kind: 'ours', port }
  } catch {}
  return { kind: 'starting', port }
}

export async function choosePort(projectDir, probe = probeMusicService, preferred = 5175) {
  const ports = [...new Set([...Array.from({ length: 10 }, (_, index) => preferred + index), 5173])]
  const states = await Promise.all(ports.map((port) => probe(port, projectDir)))
  const ours = states.find((state) => state.kind === 'ours')
  if (ours) return ours
  if (states.some((state) => state.kind === 'starting')) throw new Error('本工程的音乐服务正在启动或暂时没有响应。请稍后再双击；启动器没有重启它。')
  const available = states.find((state) => state.kind === 'free' && state.port !== 5173)
  if (!available) throw new Error(`端口 ${preferred}–${preferred + 9} 均被其他程序占用。请关闭不需要的程序后重试；启动器不会结束这些进程。`)
  return available
}

async function runNpm(args, projectDir) {
  await new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd: projectDir, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} 未完成（退出码 ${code}）。请查看上方信息后重试。`)))
  })
}

export async function dependenciesReady(projectDir) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(projectDir, 'package.json'), 'utf8'))
    const lock = JSON.parse(await fs.readFile(path.join(projectDir, 'package-lock.json'), 'utf8'))
    const installed = JSON.parse(await fs.readFile(path.join(projectDir, 'node_modules/.package-lock.json'), 'utf8'))
    for (const section of ['dependencies', 'devDependencies']) {
      const declared = manifest[section] ?? {}, locked = lock.packages?.['']?.[section] ?? {}
      if (Object.keys(declared).length !== Object.keys(locked).length || Object.entries(declared).some(([name, version]) => locked[name] !== version)) return false
    }
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      const location = `node_modules/${name}`
      // Some dependencies are ESM-only or type declarations with no executable
      // entry point, so require.resolve(name) is not a valid install check.
      const actual = JSON.parse(await fs.readFile(path.join(projectDir, location, 'package.json'), 'utf8'))
      const expected = lock.packages?.[location]?.version
      if (!expected || actual.version !== expected || installed.packages?.[location]?.version !== expected) return false
    }
    for (const [location, expected] of Object.entries(lock.packages ?? {})) {
      if (!location || (!installed.packages?.[location] && expected.optional)) continue
      if (installed.packages?.[location]?.version !== expected.version || !await exists(path.join(projectDir, location, 'package.json'))) return false
    }
    if (!await exists(path.join(projectDir, 'node_modules/.bin/vite')) || !await exists(path.join(projectDir, 'node_modules/.bin/tsc'))) return false
    return true
  } catch { return false }
}

export async function buildFingerprint(projectDir) {
  const hash = createHash('sha256')
  const roots = ['src', 'public', 'content', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'scripts/export-records.mjs', 'scripts/archive-content.mjs', 'scripts/build-pwa.mjs', 'scripts/pwa-worker.js']
  for (const entry of await fs.readdir(projectDir)) if (/^(?:vite\.config\.|tsconfig\.).+/.test(entry) && !roots.includes(entry)) roots.push(entry)
  async function append(relative) {
    const file = path.join(projectDir, relative)
    const stat = await fs.stat(file)
    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(file)).sort()) await append(path.join(relative, entry))
    } else if (stat.isFile()) {
      hash.update(relative).update('\0')
      for await (const chunk of createReadStream(file)) hash.update(chunk)
      hash.update('\0')
    }
  }
  for (const root of roots.sort()) if (await exists(path.join(projectDir, root))) await append(root)
  return hash.digest('hex')
}

async function prepareBuild(projectDir) {
  if (!supportedNode(process.versions.node)) throw new Error(`当前 Node.js ${process.versions.node} 不满足要求。请安装 Node.js 22.12 或更新的 LTS 版本。`)
  if (spawnSync('npm', ['--version'], { stdio: 'ignore' }).status !== 0) throw new Error('没有找到 npm。请重新安装包含 npm 的 Node.js LTS 版本。')
  if (!await dependenciesReady(projectDir)) {
    console.log('首次准备或依赖已更新：正在安装锁定版本的依赖（需要联网）…')
    await runNpm(['ci'], projectDir)
  }
  const marker = path.join(projectDir, 'dist/.music-build.json')
  let previous
  try { previous = JSON.parse(await fs.readFile(marker, 'utf8')) } catch {}
  const fingerprint = await buildFingerprint(projectDir)
  const index = path.join(projectDir, 'dist/index.html')
  let complete = previous?.fingerprint === fingerprint && await exists(index)
  if (complete) {
    const html = await fs.readFile(index, 'utf8')
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map((match) => match[1])
    complete = assets.length > 0 && (await Promise.all(assets.map((asset) => exists(path.join(projectDir, 'dist', asset))))).every(Boolean)
  }
  if (!complete) {
    console.log('正在构建播放器界面（完成后下次可直接启动）…')
    await runNpm(['run', 'build'], projectDir)
    await fs.writeFile(marker, JSON.stringify({ fingerprint: await buildFingerprint(projectDir), builtAt: new Date().toISOString() }, null, 2))
  }
}

async function startupLock(dataDir) {
  const file = path.join(dataDir, 'launcher.lock')
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }))
      await handle.close()
      return async () => {
        try {
          if (JSON.parse(await fs.readFile(file, 'utf8')).token === token) await fs.unlink(file)
        } catch {}
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let pid
      try { pid = JSON.parse(await fs.readFile(file, 'utf8')).pid } catch {}
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`启动锁尚未就绪。请稍后再次双击；如果持续出现，可删除 ${file} 后重试。`)
      try { process.kill(pid, 0) } catch (error) {
        // Do not race two simultaneous launches to replace a crashed owner's
        // lock: a second unlink could otherwise remove the first new lock.
        if (error.code === 'ESRCH') throw new Error(`上次启动器未正常退出。确认没有其他启动器后，删除 ${file}，再双击重试。`)
      }
      throw new Error('另一个启动器正在准备播放器，请等待它完成。')
    }
  }
  throw new Error('无法取得启动锁，请稍后重试。')
}

async function startServer(projectDir, dataDir, port) {
  const logPath = path.join(dataDir, 'player-service.log')
  const log = await fs.open(logPath, 'a')
  await log.write(`\n[${new Date().toISOString()}] 启动播放器，端口 ${port}\n`)
  let child
  let startupError
  try {
    child = spawn(process.execPath, [path.join(projectDir, 'scripts/music-server.mjs'), '--port', String(port)], {
      cwd: projectDir, detached: true,
      env: { ...process.env, MUSIC_DATA_DIR: dataDir },
      stdio: ['ignore', log.fd, log.fd],
    })
    child.once('error', (error) => { startupError = error })
  } finally { await log.close() }
  child.unref()
  for (let attempt = 0; attempt < 120; attempt++) {
    if (startupError || child.exitCode !== null || child.signalCode) break
    const state = await probeMusicService(port, projectDir)
    if (state.kind === 'ours') {
      console.log(`服务日志：${logPath}`)
      return
    }
    await wait(250)
  }
  const tail = (await fs.readFile(logPath, 'utf8')).split('\n').slice(-16).join('\n')
  throw new Error(`播放器尚未就绪。${startupError?.message ?? ''}\n日志：${logPath}\n${tail}`)
}

// 跨平台打开浏览器（2026-10-02 改造）。
// 原实现写死 `spawnSync('/usr/bin/open', [url])`，在 Windows 上必然失败，
// 且 spawnSync 抛错时 result.status 为 null，错误信息不会打印。
// 见 docs/CROSS-PLATFORM-AUDIT.md 第 4.1 节。
function openBrowser(url) {
  const command = IS_DARWIN ? 'open' : IS_WINDOWS ? 'cmd' : 'xdg-open'
  const args = IS_WINDOWS ? ['/c', 'start', '', url] : [url]
  try {
    const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true })
    if (result.status !== 0) {
      console.log(`浏览器未自动打开，请手动访问：${url}`)
      return false
    }
    return true
  } catch (error) {
    console.log(`浏览器未自动打开（${error.message}），请手动访问：${url}`)
    return false
  }
}

export async function launchMusic({ projectDir = PROJECT_DIR, dataDir, probe = probeMusicService, prepare = prepareBuild, start = startServer, open = openBrowser } = {}) {
  projectDir = await fs.realpath(projectDir)
  dataDir = path.resolve(projectDir, dataDir ?? process.env.MUSIC_DATA_DIR ?? '../music-data-v3')
  let state = await choosePort(projectDir, probe)
  if (state.kind !== 'ours') {
    await fs.mkdir(dataDir, { recursive: true })
    const release = await startupLock(dataDir)
    try {
      state = await choosePort(projectDir, probe)
      if (state.kind !== 'ours') {
        await prepare(projectDir)
        state = await choosePort(projectDir, probe)
        if (state.kind !== 'ours') await start(projectDir, dataDir, state.port)
      }
    } finally { await release() }
  }
  const url = `http://127.0.0.1:${state.port}/`
  console.log(`${state.kind === 'ours' ? '播放器已在运行，直接打开' : '播放器已启动'}：${url}`)
  await open(url)
  console.log('现在可以关闭此终端窗口；播放器服务会在后台继续运行。')
  return { url, port: state.port, reused: state.kind === 'ours' }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launchMusic().catch((error) => { console.error(`\n${error.message}`); process.exitCode = 1 })
}
