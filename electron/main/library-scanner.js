/**
 * 音乐库文件夹导入：递归扫描、并发控制、去重、权限与失败处理。
 *
 * 供两条入口复用：
 *   1. 设置页「添加」按钮 → Electron 文件夹选择器
 *   2. 拖拽文件夹到窗口
 *
 * 无外部依赖，纯 Node，可在主进程直接运行。
 */
const { constants } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { AUDIO_EXTENSIONS, normalizeForCompare, shouldSkipDir } = require('./platform.js')

/** 单个目录的扫描上限，防止误扫整块盘导致长时间卡死。 */
const MAX_FILES_PER_ROOT = 20000
const MAX_DEPTH = 12
/** 并发读取目录项的并发数（Windows 上过高会撞IONode 句柄上限）。 */
const CONCURRENCY = 32

/**
 * @typedef {object} ScanResult
 * @property {string[]} roots            成功读取的根目录
 * @property {string[]} rejectedRoots    被拒绝的根目录（不存在 / 非目录 / 不可读）
 * @property {object[]} files            音频文件条目
 * @property {object} stats              统计
 */

/**
 * 递归扫描一个根目录。
 * @param {string} root
 * @param {object} [options]
 * @param {string[]} [options.existingPaths] 已存在的路径集合（用于跨根去重）
 * @param {boolean} [options.followSymlinks] 是否跟随符号链接（默认 false，防环）
 * @returns {Promise<{ files: object[], errors: object[], truncated: boolean }>}
 */
async function scanRoot(root, options = {}) {
  const { existingPaths = new Set(), followSymlinks = false } = options
  const errors = []
  const files = []
  const truncated = { value: false }

  // 先验证根目录可读 —— 权限异常要在这一层就报给用户，而不是静默返回空列表
  try {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) {
      return { files, errors: [{ path: root, code: 'NOT_A_DIRECTORY', message: '不是文件夹' }], truncated: false }
    }
    await fs.access(root, constants.R_OK)
  } catch (error) {
    const code = error.code === 'ENOENT' ? 'NOT_FOUND'
      : error.code === 'EACCES' || error.code === 'EPERM' ? 'PERMISSION_DENIED'
        : 'UNKNOWN'
    return {
      files,
      errors: [{ path: root, code, message: describeFsError(error, root) }],
      truncated: false,
    }
  }

  /** 队列式广度优先，避免深目录爆栈 */
  const queue = [{ dir: root, depth: 0 }]
  const visitedDirs = new Set()

  while (queue.length) {
    const batch = queue.splice(0, CONCURRENCY)
    await Promise.all(batch.map(async ({ dir, depth }) => {
      if (truncated.value) return
      if (depth > MAX_DEPTH) {
        errors.push({ path: dir, code: 'MAX_DEPTH', message: `层级超过 ${MAX_DEPTH}，已跳过` })
        return
      }
      // 归一化后去重，防符号链接造成的环
      const key = normalizeForCompare(dir)
      if (visitedDirs.has(key)) return
      visitedDirs.add(key)

      /** @type {import('node:fs').Dirent[]} */
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (error) {
        // 权限 / 文件占用 / 已被删除的目录，记为可诊断错误但不中断整体扫描
        errors.push({
          path: dir,
          code: error.code === 'EACCES' || error.code === 'EPERM' ? 'PERMISSION_DENIED' : (error.code ?? 'READ_FAILED'),
          message: describeFsError(error, dir),
        })
        return
      }

      for (const entry of entries) {
        if (files.length >= MAX_FILES_PER_ROOT) {
          truncated.value = true
          errors.push({
            path: root,
            code: 'TOO_MANY_FILES',
            message: `超过 ${MAX_FILES_PER_ROOT} 个文件，已截断`,
          })
          return
        }

        const full = path.join(dir, entry.name)

        if (entry.isDirectory()) {
          if (shouldSkipDir(full)) continue
          if (entry.isSymbolicLink() && !followSymlinks) continue
          queue.push({ dir: full, depth: depth + 1 })
          continue
        }

        if (!entry.isFile() && !(entry.isSymbolicLink() && followSymlinks)) continue
        if (entry.isSymbolicLink() && !followSymlinks) continue

        const ext = path.extname(entry.name).toLowerCase()
        if (!AUDIO_EXTENSIONS.has(ext)) continue

        // 去重：同一路径只保留一次（大小写按平台语义归一）
        const dedupeKey = normalizeForCompare(full)
        if (existingPaths.has(dedupeKey)) continue
        existingPaths.add(dedupeKey)

        let size = 0
        let mtimeMs = 0
        try {
          const st = await fs.stat(full)
          size = st.size
          mtimeMs = st.mtimeMs
        } catch (error) {
          errors.push({ path: full, code: error.code ?? 'STAT_FAILED', message: describeFsError(error, full) })
          continue
        }

        files.push({
          path: full,
          relPath: path.relative(root, full),
          root,
          name: entry.name,
          ext,
          size,
          mtimeMs,
        })
      }
    }))
  }

  return { files, errors, truncated: truncated.value }
}

/**
 * 批量扫描多个根目录，跨根去重。
 * @param {string[]} roots
 * @param {object} [options]
 * @returns {Promise<ScanResult>}
 */
async function scanRoots(roots, options = {}) {
  /** @type {string[]} */
  const accepted = []
  /** @type {string[]} */
  const rejected = []
  /** @type {object[]} */
  const allFiles = []
  /** @type {object[]} */
  const allErrors = []
  const existingPaths = new Set()
  let truncated = false

  for (const raw of roots) {
    const root = normalizePath(raw)
    if (!root) {
      rejected.push(raw)
      continue
    }
    // 根目录之间也要去重：父子目录同时被选中时，父目录已覆盖子目录
    if (accepted.some((a) => isSameOrUnder(root, a))) continue

    const result = await scanRoot(root, { ...options, existingPaths })
    if (result.errors.some((e) => e.code === 'NOT_FOUND' || e.code === 'NOT_A_DIRECTORY')) {
      rejected.push(root)
    } else {
      accepted.push(root)
    }
    // 去掉被更上层根目录覆盖的
    accepted.forEach((a, i) => {
      if (i !== accepted.length - 1 && isSameOrUnder(a, root)) accepted.splice(i, 1)
    })
    if (result.truncated) truncated = true
    allFiles.push(...result.files)
    allErrors.push(...result.errors)
  }

  return {
    roots: accepted,
    rejectedRoots: rejected,
    files: allFiles,
    stats: {
      totalFiles: allFiles.length,
      totalBytes: allFiles.reduce((n, f) => n + f.size, 0),
      totalRoots: accepted.length,
      rejectedCount: rejected.length,
      errorCount: allErrors.length,
      truncated,
    },
    errors: allErrors,
  }
}

/**
 * 解析拖拽进来的路径。
 * Electron 的 `File` 对象在渲染进程里拿不到真实路径（安全设计），
 * 必须由 preload 通过 `webUtils.getPathForFile` 取，这里只做清洗与去重。
 * @param {string[]} rawPaths
 * @returns {string[]}
 */
function sanitizeDroppedPaths(rawPaths) {
  /** @type {string[]} */
  const out = []
  const seen = new Set()
  for (const raw of rawPaths) {
    if (typeof raw !== 'string') continue
    const cleaned = raw.replace(/^["']|["']$/g, '').trim()
    if (!cleaned) continue
    const normalized = normalizePath(cleaned)
    if (!normalized) continue
    const key = normalizeForCompare(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

function normalizePath(p) {
  if (typeof p !== 'string') return ''
  let out = p.trim()
  if (!out) return ''
  // 去掉 file:// 前缀（某些拖拽源会带）
  if (out.startsWith('file://')) {
    try { out = decodeURIComponent(new URL(out).pathname) } catch { out = out.slice(7) }
  }
  // Windows 盘符转绝对路径；相对路径按当前工作目录解析
  return path.normalize(path.isAbsolute(out) ? out : path.resolve(out))
}

function isSameOrUnder(child, parent) {
  const c = normalizeForCompare(child)
  const p = normalizeForCompare(parent)
  return c === p || c.startsWith(`${p}/`)
}

/** 把 Node fs 错误翻译成用户看得懂的中文。 */
function describeFsError(error, target) {
  const name = path.basename(target)
  switch (error.code) {
    case 'EACCES':
    case 'EPERM':
      return `没有权限读取「${name}」，请在文件夹属性中授予访问权限，或以管理员身份运行`
    case 'ENOENT':
      return `「${name}」已不存在，可能已被移动或删除`
    case 'EBUSY':
      return `「${name}」正被其他程序占用，已跳过`
    case 'EMFILE':
    case 'ENFILE':
      return '打开的文件过多，已跳过该目录'
    case 'ELOOP':
      return `「${name}」包含循环链接，已跳过`
    default:
      return `无法读取「${name}」：${error.message ?? error}`
  }
}

module.exports = { scanRoot, scanRoots, sanitizeDroppedPaths }
