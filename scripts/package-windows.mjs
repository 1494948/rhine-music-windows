/**
 * Assembles the Windows portable distribution of the local modification.
 *
 * Why a script rather than a hand-copied folder: the package has to combine four
 * sources (the read-only third-party base, this repo's build output, this repo's
 * server scripts, and the user's own library index), and every one of them has a
 * rule attached. Doing it by hand once produces a package nobody can reproduce;
 * doing it here means the next version is one command.
 *
 *   node scripts/package-windows.mjs [--out <dir>] [--base <dir>] [--force]
 *
 * What is deliberately excluded, and why:
 *   - `app/src`, `app/public`, `tsconfig.json`, `app/package-lock.json`:
 *     build-time inputs. The interface ships as `app/dist`; `public/` has
 *     already been copied into it by vite.
 *   - The dev half of `node_modules` (vite, rollup, esbuild, typescript,
 *     prettier, three, ...): 103 MB the runtime never imports. The kept set is
 *     computed from the real import closure of `music-server.mjs`, not guessed.
 *   - `music-data-v3/webview2` (115 MB): the WebView2 browser profile. Pure
 *     runtime state, recreated on first launch.
 *   - Every `check-*.mjs` and one-off diagnostic: not reachable at runtime.
 */

import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = path.join(REPO, 'app')

/** The third-party build this modification sits on top of. Treated as read-only. */
const DEFAULT_BASE = 'C:/Users/徐梓烽/Downloads/Rhine-Music-Windows-0.3.0-二次修改'
const DEFAULT_OUT = 'C:/AI Document/releases/rhine-music-local-mod/v0.3.0-local.1'
/** Files the launcher loads from its own directory. */
const SHELL_FILES = ['RhineMusic.exe', 'libmpv-2.dll', 'app.ico', 'no-log.flag', 'LICENSE', 'NOTICE.md', 'README-Windows.md']
/** Reference docs copied from the repo into the package root. */
const DOCS = {
  '使用说明-本地修改版.md': path.join(REPO, 'docs/使用说明-本地修改版.md'),
  '发布说明.md': path.join(REPO, 'docs/发布说明-v0.3.0-local.1.md'),
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const base = path.resolve(arg('base', DEFAULT_BASE))
const out = path.resolve(arg('out', DEFAULT_OUT))
const force = process.argv.includes('--force')

// ----------------------------------------------------------------- primitives

async function exists(target) {
  return fs.stat(target).then(() => true, () => false)
}

async function sizeOf(target) {
  const stat = await fs.stat(target).catch(() => null)
  if (!stat) return 0
  if (stat.isFile()) return stat.size
  let total = 0
  const queue = [target]
  while (queue.length) {
    const dir = queue.pop()
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else total += (await fs.stat(full).catch(() => ({ size: 0 }))).size
    }
  }
  return total
}

async function countOf(target) {
  let total = 0
  const queue = [target]
  while (queue.length) {
    const dir = queue.pop()
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) queue.push(path.join(dir, entry.name))
      else total++
    }
  }
  return total
}

async function hashOf(target) {
  const { createHash } = await import('node:crypto')
  const hash = createHash('md5')
  const handle = await fs.open(target, 'r')
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk)
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/**
 * Mirrors a directory with robocopy. `/MIR` so a re-run converges instead of
 * accumulating; `/XF` drops the excluded names. Robocopy reports success as bits
 * 0-7, so anything >= 8 is a real failure.
 */
function robocopy(source, destination, { excludeFiles = [], excludeDirs = [] } = {}) {
  const args = [source, destination, '/MIR', '/NFL', '/NDL', '/NP', '/R:2', '/W:2', '/NJH', '/NJS']
  if (excludeFiles.length) args.push('/XF', ...excludeFiles)
  if (excludeDirs.length) args.push('/XD', ...excludeDirs)
  return new Promise((resolve, reject) => {
    const child = spawn('robocopy', args, { windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code >= 8) reject(new Error(`robocopy 失败（退出码 ${code}）：${output.trim().split('\n').slice(-4).join(' ')}`))
      else resolve(output)
    })
  })
}

async function copyFile(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.copyFile(source, destination)
}

// ------------------------------------------------------- runtime import closure

/** Follows relative imports from an entry script. */
async function scriptClosure(entry) {
  const seen = new Set()
  const queue = [path.resolve(entry)]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g))
      queue.push(path.resolve(path.dirname(file), match[1]))
  }
  return seen
}

/** Bare specifiers a set of scripts imports at runtime. */
async function bareImports(files) {
  const found = new Set()
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    for (const match of text.matchAll(/from\s+['"]([^.'"][^'"]*)['"]/g)) {
      const spec = match[1]
      if (spec.startsWith('node:')) continue
      const parts = spec.split('/')
      found.add(spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0])
    }
  }
  return found
}

/**
 * The transitive `dependencies` of the entry packages. npm guarantees a
 * package's declared dependencies resolve, so this is the exact set the runtime
 * needs — no more, and nothing missing.
 */
async function packageClosure(entries) {
  const modules = path.join(APP, 'node_modules')
  const kept = new Map()
  const queue = [...entries]
  while (queue.length) {
    const name = queue.pop()
    if (kept.has(name)) continue
    const dir = path.join(modules, name)
    const meta = await fs.readFile(path.join(dir, 'package.json'), 'utf8').then(JSON.parse, () => null)
    if (!meta) throw new Error(`运行时依赖缺失：${name}`)
    kept.set(name, dir)
    for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) queue.push(dep)
  }
  return kept
}

// --------------------------------------------------------------------- assemble

const report = []
const started = Date.now()

if (!(await exists(base))) throw new Error(`基准物不存在：${base}`)
if (!(await exists(path.join(APP, 'dist', 'index.html'))))
  throw new Error(`缺少构建产物：${path.join(APP, 'dist')}。请先构建并回灌 app/dist。`)
if ((await exists(out)) && (await countOf(out)) > 0 && !force)
  throw new Error(`输出目录非空：${out}\n确认要覆盖请加 --force。`)

await fs.mkdir(out, { recursive: true })

// 1. The native shell, copied verbatim from the base.
for (const name of SHELL_FILES) {
  const source = path.join(base, name)
  if (!(await exists(source))) throw new Error(`基准物缺少 ${name}`)
  await copyFile(source, path.join(out, name))
}
report.push(`外壳文件 ${SHELL_FILES.length} 个`)

// 2. The bundled Node runtime plus libmpv, as the launcher expects them.
{
  const destination = path.join(out, 'runtime')
  await robocopy(path.join(base, 'runtime'), destination)
  report.push(`runtime/ ${(await sizeOf(destination) / 1048576).toFixed(1)} MB`)
}

// 3. The interface. `app/dist` is the server's static root, so it must sit there.
{
  const destination = path.join(out, 'app', 'dist')
  await robocopy(path.join(APP, 'dist'), destination)
  report.push(`app/dist/ ${await countOf(destination)} 个文件，${(await sizeOf(destination) / 1048576).toFixed(1)} MB`)
}

// 4. The server scripts, limited to what `music-server.mjs` actually reaches.
{
  const scripts = await scriptClosure(path.join(APP, 'scripts', 'music-server.mjs'))
  const destination = path.join(out, 'app', 'scripts')
  await fs.mkdir(destination, { recursive: true })
  for (const file of scripts) await copyFile(file, path.join(destination, path.basename(file)))
  report.push(`app/scripts/ ${scripts.size} 个脚本：${[...scripts].map((f) => path.basename(f)).sort().join(', ')}`)

  // 5. The packages those scripts import, and their transitive dependencies.
  const closure = await packageClosure([...await bareImports(scripts)].filter((name) => name !== 'typescript'))
  const modules = path.join(out, 'app', 'node_modules')
  for (const [name, dir] of closure) await robocopy(dir, path.join(modules, name))
  const size = await sizeOf(modules)
  report.push(`app/node_modules/ ${closure.size} 个包，${(size / 1048576).toFixed(2)} MB（完整副本为 ${(await sizeOf(path.join(APP, 'node_modules')) / 1048576).toFixed(1)} MB）`)
}

// 6. App metadata, plus content/ so the package can still be rebuilt in place.
for (const name of ['package.json', 'index.html', 'LICENSE', 'NOTICE.md']) {
  const source = path.join(APP, name)
  if (await exists(source)) await copyFile(source, path.join(out, 'app', name))
}
// `content` is a directory; robocopy is the tool for trees, and a plain
// copyFile for a single file (robocopy reads a file source as a directory and
// fails with error 123).
if (await exists(path.join(APP, 'content')))
  await robocopy(path.join(APP, 'content'), path.join(out, 'app', 'content'))

// 7. The library data: config, index, artwork and mpv config — but not the
//    115 MB WebView2 profile, which is browser state rather than library data.
{
  const destination = path.join(out, 'music-data-v3')
  await robocopy(path.join(base, 'music-data-v3'), destination, { excludeDirs: ['webview2'] })
  report.push(`music-data-v3/ ${(await sizeOf(destination) / 1048576).toFixed(1)} MB（已排除 webview2）`)
}

// 8. The reference docs, and a launcher fallback for machines without WebView2.
for (const [name, source] of Object.entries(DOCS)) {
  if (!(await exists(source))) throw new Error(`缺少文档：${source}`)
  await copyFile(source, path.join(out, name))
}
await fs.writeFile(path.join(out, '启动音乐播放器.bat'), [
  '@echo off',
  'rem 备用启动方式：不使用 WebView2 外壳，直接起本地服务并用系统浏览器打开。',
  'rem 仅在 RhineMusic.exe 双击无窗口（缺少 WebView2 运行时）时使用。',
  'chcp 65001 >nul',
  'setlocal',
  'cd /d "%~dp0"',
  'if not defined RHINE_NODE set "RHINE_NODE=%~dp0runtime\\node.exe"',
  'if not defined MUSIC_DATA_DIR set "MUSIC_DATA_DIR=%~dp0music-data-v3"',
  'set "PORT=5175"',
  'if not exist "%RHINE_NODE%" ( echo 找不到 %RHINE_NODE%，请设置 RHINE_NODE 指向 node.exe & pause & exit /b 1 )',
  'echo 正在启动本地音乐服务：http://127.0.0.1/%PORT%/',
  'echo 关闭本窗口即停止服务。',
  'start "" "%RHINE_NODE%" "%~dp0app\\scripts\\music-server.mjs" --port %PORT%',
  'timeout /t 3 /nobreak >nul',
  'start "" "http://127.0.0.1:%PORT%/"',
  'endlocal',
  '',
].join('\r\n'), 'utf8')
report.push('启动音乐播放器.bat（备用启动方式）')

// --------------------------------------------------------------------- verify

const checks = []
for (const name of ['RhineMusic.exe', 'libmpv-2.dll']) {
  const a = await hashOf(path.join(base, name))
  const b = await hashOf(path.join(out, name))
  checks.push([name, a === b, a])
}
{
  const a = await hashOf(path.join(APP, 'dist', 'index.html'))
  const b = await hashOf(path.join(out, 'app', 'dist', 'index.html'))
  checks.push(['app/dist/index.html', a === b, a])
}
{
  const a = await hashOf(path.join(APP, 'scripts', 'music-server.mjs'))
  const b = await hashOf(path.join(out, 'app', 'scripts', 'music-server.mjs'))
  checks.push(['app/scripts/music-server.mjs', a === b, a])
}
for (const name of ['album-online.mjs', 'album-introductions.mjs', 'lyrics.mjs', 'music-library.mjs']) {
  const a = await hashOf(path.join(APP, 'scripts', name))
  const b = await hashOf(path.join(out, 'app', 'scripts', name))
  checks.push([`app/scripts/${name}`, a === b, a])
}

const total = await sizeOf(out)
const failed = checks.filter(([, ok]) => !ok)

console.log(`\n打包完成：${out}`)
console.log(`总大小 ${(total / 1048576).toFixed(1)} MB，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
for (const line of report) console.log(`  · ${line}`)
console.log('\n校验（源 vs 包内 MD5）：')
for (const [name, ok, digest] of checks) console.log(`  ${ok ? '✔' : '✘'} ${name.padEnd(34)} ${digest}`)
if (failed.length) {
  console.error(`\n有 ${failed.length} 项校验不一致，打包结果不可用。`)
  process.exitCode = 1
} else {
  console.log('\n全部一致。')
}
