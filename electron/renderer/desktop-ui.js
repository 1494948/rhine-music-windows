/**
 * 桌面端（Electron）界面集成。
 *
 * 职责：
 *  1. 用「添加」按钮 + 文件夹选择器**替换**上游的 textarea 路径输入框
 *     （原实现见 upstream src/music-app.ts:1073，placeholder 写死 macOS 路径）
 *  2. 拖拽文件夹到窗口即导入
 *  3. 动效设置项（开关 / 时长 / 缓动 / 性能）
 *  4. GPU 设置项（开关 / 强制 CPU / 检测结果摘要）
 *
 * 该模块以「增强」方式工作：不改上游渲染逻辑，只替换音乐库面板的导入区块，
 * 并追加两个设置区块。这样上游更新时冲突面最小。
 */

import { motion } from './motion.js'

/** 是否运行在 Electron 桌面壳内。 */
export const isDesktop = typeof window !== 'undefined' && typeof window.rhine === 'object' && window.rhine !== null

/** @type {object} */
let startup = isDesktop ? window.rhine.startup : null

/**
 * 渲染音乐库导入区块（替换 textarea）。
 * @param {HTMLElement} host
 * @param {{roots: Array<{path:string}>, scan: {running:boolean}, onRescan: () => void}} library
 */
export function renderImportBlock(host, library) {
  if (!isDesktop) return false

  const roots = library.roots ?? []
  host.innerHTML = `
    <section class="panel-section" id="desktop-import">
      <h3>音乐文件夹</h3>
      <p class="panel-intro">点「添加」选择文件夹，或直接把文件夹拖到窗口里。根目录中的单曲各成一张卡片，子文件夹按专辑展示。</p>
      <div class="import-actions">
        <button class="primary-button" data-action="pick-folder">添加文件夹 ↗</button>
        <button data-action="rescan">重新扫描</button>
      </div>
      <div id="drop-hint" class="drop-hint" hidden>松开即可导入这个文件夹</div>
      <div id="import-status" class="scan-status" role="status" aria-live="polite"></div>
      <ul class="root-list" id="root-list">
        ${roots.map((r) => `
          <li class="root-item" data-root="${escAttr(r.path)}">
            <code class="root-path" title="${escAttr(r.path)}">${esc(r.path)}</code>
            <span class="root-ops">
              <button class="icon-button" data-action="reveal-root" data-root="${escAttr(r.path)}" aria-label="在资源管理器中显示">↗</button>
              <button class="icon-button" data-action="remove-root" data-root="${escAttr(r.path)}" aria-label="移除">✕</button>
            </span>
          </li>`).join('')}
      </ul>
      ${roots.length ? '' : '<p class="empty-hint">还没有导入任何文件夹。</p>'}
    </section>
  `

  bindImportEvents(host, library)
  return true
}

/** 绑定导入区块的事件。 */
function bindImportEvents(host, library) {
  const status = host.querySelector('#import-status')
  const setStatus = (text, kind = '') => {
    if (!status) return
    status.textContent = text
    status.dataset.kind = kind
  }

  host.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]')
    if (!target) return
    const action = target.getAttribute('data-action')
    const root = target.getAttribute('data-root')

    if (action === 'pick-folder') {
      try {
        setStatus('正在打开文件夹选择器…')
        const picked = await window.rhine.library.pickFolders()
        if (picked?.canceled || !picked?.roots?.length) {
          setStatus('')
          return
        }
        const outcome = await importRoots(picked.roots, setStatus)
        if (outcome?.imported) {
          // 曲库服务已持久化 roots 并重建专辑——用返回的库状态刷新列表与统计
          library.roots = outcome.imported.roots ?? library.roots
          renderImportBlock(host, library)
          setStatus(importSummary(outcome.imported), 'ok')
        }
      } catch (error) {
        setStatus(`选择失败：${error.message}`, 'error')
      }
      return
    }

    if (action === 'reveal-root' && root) {
      await window.rhine.library.reveal(root).catch(() => {})
      return
    }

    if (action === 'remove-root' && root) {
      const next = await window.rhine.library.removeRoot(root)
      library.roots = next.roots ?? []
      renderImportBlock(host, library)
      setStatus('已移除该目录（已导入的曲目仍保留在曲库中）')
      return
    }

    if (action === 'rescan') {
      library.onRescan?.()
    }
  })
}

/**
 * 导入一批目录并刷新界面。
 * @param {string[]} roots
 * @param {(text:string, kind?:string) => void} setStatus
 */
/**
 * 导入一批目录。
 *
 * 联动关键（2026-10-03 修复）：这里只做**主进程预检**（存在性/权限），
 * 真正入库必须走 `onImport(roots)` → 上游 `POST /api/library/scan {roots}`。
 * 之前直接调主进程扫描器（library:scan），它只返回文件统计、不入曲库——
 * 结果是「扫到 774 个文件但 0 专辑/0 曲目、目录列表为空」，导入形同虚设。
 *
 * @param {string[]} roots
 * @param {(text:string, kind?:string) => void} setStatus
 */
async function importRoots(roots, setStatus) {
  setStatus(`正在检查 ${roots.length} 个文件夹…`)
  try {
    // 预检：拿到权限/占用等错误，提前告诉用户（这些上游 API 也会报，但这里能更快反馈）
    const precheck = await window.rhine.library.scan(roots)
    const precheckProblems = []
    if (precheck.rejectedRoots?.length) precheckProblems.push(`无法读取：${precheck.rejectedRoots.join('、')}`)
    const denied = (precheck.errors ?? []).filter((e) => e.code === 'PERMISSION_DENIED')
    if (denied.length) precheckProblems.push(`${denied.length} 处没有访问权限（${denied[0].message}）`)
    if (precheckProblems.length) setStatus(precheckProblems.join('；'), 'warn')

    // 真正入库：交给上游曲库服务扫描、持久化 roots、生成专辑/曲目
    if (!onImportRef) throw new Error('导入通道未初始化（onImport 缺失）')
    setStatus('正在扫描入库（这一步在曲库较大时需要一点时间）…')
    const imported = await onImportRef(roots)
    return { precheck, imported }
  } catch (error) {
    setStatus(`导入失败：${error.message}`, 'error')
    return null
  }
}

/* ══════════════════════════拖拽导入 ══════════════════════════ */

let dragDepth = 0

/** 在窗口上启用拖拽导入。 */
export function enableDragImport() {
  if (!isDesktop) return
  const hint = () => document.querySelector('#drop-hint')
  const show = (on) => {
    const el = hint()
    if (el) el.hidden = !on
  }

  window.addEventListener('dragenter', (event) => {
    // 必须 preventDefault，否则 drop 事件不触发
    event.preventDefault()
    dragDepth += 1
    show(true)
  })

  window.addEventListener('dragover', (event) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  })

  window.addEventListener('dragleave', (event) => {
    event.preventDefault()
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) show(false)
  })

  window.addEventListener('drop', async (event) => {
    event.preventDefault()
    dragDepth = 0
    show(false)

    const files = [...(event.dataTransfer?.files ?? [])]
    if (!files.length) return

    const paths = await window.rhine.library.resolveDropped(files)
    if (!paths?.length) {
      notify('没能识别拖入的文件夹路径，请改用「添加文件夹」按钮。')
      return
    }
    notify(`正在导入 ${paths.length} 个文件夹…`)
    // 复用面板内的状态提示；面板未打开时给一条全局通知
    const status = document.querySelector('#import-status')
    const setter = (text, kind) => {
      if (status) {
        status.textContent = text
        status.dataset.kind = kind ?? ''
      } else {
        notify(text)
      }
    }
    const outcome = await importRoots(paths, setter)
    if (outcome?.imported) {
      setter(importSummary(outcome.imported), 'ok')
      // 面板开着的话同步刷新目录列表
      const host = document.querySelector('#import-mount')
      if (host && hostState) {
        hostState.roots = outcome.imported.roots ?? hostState.roots
        renderImportBlock(host, hostState)
      }
    }
  })
}

/** 导入完成后的摘要文案：以曲库实际生成的专辑/曲目为准，不再显示体积。 */
function importSummary(importedLibrary) {
  const albums = importedLibrary?.albums?.length ?? 0
  const tracks = importedLibrary?.albums?.reduce((sum, a) => sum + (a.tracks?.length ?? 0), 0) ?? 0
  return `已入库 ${albums} 张专辑 · ${tracks} 首曲目`
}

/* ══════════════════════════动效设置 ══════════════════════════ */

/** 渲染动效设置区块。 */
export function renderMotionSettings(host) {
  if (!isDesktop) return false
  const info = motion.describe()

  host.innerHTML = `
    <section class="panel-section" id="motion-settings">
      <h3>动效</h3>
      <p class="panel-intro">视觉节奏参考 Apple Music。全部效果都可关闭或降级，不影响功能。</p>

      <label class="switch-row">
        <span>启用动效</span>
        <label class="switch">
          <input type="checkbox" id="motion-enabled" ${info.active ? 'checked' : ''}>
          <span class="track"></span>
        </label>
      </label>

      <label class="field-label" for="motion-duration">时长
        <span>当前：${esc(info.durationLabel)}</span>
      </label>
      <select id="motion-duration" ${info.active ? '' : 'disabled'}>
        ${info.options.duration.map((o) => `<option value="${o.value}" ${o.value === motion.settings.duration ? 'selected' : ''}>${o.label}${o.ms ? `（${o.ms}ms）` : ''}</option>`).join('')}
      </select>

      <label class="field-label" for="motion-easing">缓动曲线</label>
      <select id="motion-easing" ${info.active ? '' : 'disabled'}>
        ${info.options.easing.map((o) => `<option value="${o.value}" ${o.value === motion.settings.easing ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>

      <label class="field-label" for="motion-perf">性能模式
        <span>影响：${info.perf.blur ? '开' : '关'}毛玻璃 · ${info.perf.shadows ? '开' : '关'}阴影 · ${info.perf.particle ? '开' : '关'}粒子</span>
      </label>
      <select id="motion-perf">
        ${info.options.performanceMode.map((o) => `<option value="${o.value}" ${o.value === motion.settings.performanceMode ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>

      <p class="scan-status">实际时长 <b>${info.durationMs}ms</b>${info.systemReduced ? ' · 系统要求减弱动效，已强制关闭' : ''}</p>
    </section>
  `

  const enabled = host.querySelector('#motion-enabled')
  enabled?.addEventListener('change', async () => {
    const next = { ...motion.settings, enabled: enabled.checked }
    await applyMotion(next)
    renderMotionSettings(host)
  })

  host.querySelector('#motion-duration')?.addEventListener('change', async (e) => {
    await applyMotion({ ...motion.settings, duration: e.target.value })
    renderMotionSettings(host)
  })

  host.querySelector('#motion-easing')?.addEventListener('change', async (e) => {
    await applyMotion({ ...motion.settings, easing: e.target.value })
    renderMotionSettings(host)
  })

  host.querySelector('#motion-perf')?.addEventListener('change', async (e) => {
    await applyMotion({ ...motion.settings, performanceMode: e.target.value })
    renderMotionSettings(host)
  })

  return true
}

async function applyMotion(patch) {
  motion.apply(patch)
  await window.rhine.settings.set({ motion: patch }).catch(() => {})
}

/* ══════════════════════════GPU 设置 ══════════════════════════ */

/** 渲染 GPU 设置区块。 */
export async function renderGpuSettings(host) {
  if (!isDesktop) return false
  const report = (await window.rhine.gpu.getReport().catch(() => null)) ?? startup?.gpu ?? null
  if (!report) return false

  const prefs = startup?.settings?.gpu ?? { enabled: true, forceCpu: false }
  const scope = report.scope ?? {}

  host.innerHTML = `
    <section class="panel-section" id="gpu-settings">
      <h3>图形加速</h3>
      <p class="panel-intro">GPU 负责 3D 档案卡渲染、音频解码与波形可视化；文件读写与标签解析仍由 CPU 处理。</p>

      <label class="switch-row">
        <span>启用硬件加速</span>
        <label class="switch">
          <input type="checkbox" id="gpu-enabled" ${prefs.enabled !== false ? 'checked' : ''}>
          <span class="track"></span>
        </label>
      </label>

      <label class="switch-row">
        <span>强制 CPU 渲染<span>驱动异常或需要省电时开启</span></span>
        <label class="switch">
          <input type="checkbox" id="gpu-force-cpu" ${prefs.forceCpu ? 'checked' : ''}>
          <span class="track"></span>
        </label>
      </label>

      <dl class="gpu-summary">
        <div><dt>显卡</dt><dd>${esc(report.vendorLabel ?? report.vendor ?? '未知')} · ${esc(report.rendererName ?? '')}</dd></div>
        ${report.driverVersion ? `<div><dt>驱动</dt><dd>${esc(report.driverVersion)}</dd></div>` : ''}
        <div><dt>状态</dt><dd>${report.hardwareAccelerated ? '硬件加速可用' : '软件渲染（已回退）'}</dd></div>
        <div><dt>加速范围</dt><dd>${Object.values(scope).map(esc).join('、') || '3D 渲染'}</dd></div>
      </dl>

      <p class="scan-status">${esc(report.recommended ?? '')}</p>
      <p class="scan-status warn">GPU 与端口设置在启动时生效，改完需要重启应用。</p>
    </section>
  `

  const persist = async (patch) => {
    const res = await window.rhine.settings.set({ gpu: { ...prefs, ...patch } }).catch(() => null)
    if (res?.restartRequired) notify('设置已保存，重启应用后生效。')
  }

  host.querySelector('#gpu-enabled')?.addEventListener('change', (e) => persist({ enabled: e.target.checked }))
  host.querySelector('#gpu-force-cpu')?.addEventListener('change', (e) => persist({ forceCpu: e.target.checked }))

  return true
}

/* ══════════════════════════挂载入口 ══════════════════════════ */

/**
 * 在音乐库面板挂载导入区块。
 * 非桌面环境（浏览器里打开上游 Web 版）时静默跳过，保留上游原有行为。
 *
 * @param {HTMLElement} host
 * @param {object} library
 * @param {() => void} onRescan
 */
/** 当前挂载的导入区块状态与入库回调（拖拽导入在面板外也要能用）。 */
let hostState = null
let onImportRef = null

/**
 * 在音乐库面板挂载导入区块。
 * 非桌面环境（浏览器里打开上游 Web 版）时静默跳过，保留上游原有行为。
 *
 * @param {HTMLElement} host
 * @param {object} library
 * @param {() => void} onRescan
 * @param {(roots: string[]) => Promise<object>} onImport
 *   把目录交给上游曲库入库的回调（内部 POST /api/library/scan {roots}），
 *   返回刷新后的 MusicLibrary。**这是导入真正生效的通道**——主进程扫描器
 *   只做预检，不入曲库。
 */
export function mountImport(host, library, onRescan, onImport) {
  // 已停用（2026-10-03）：音乐添加恢复作者原版的 textarea 方式，
  // 本函数保留仅供回溯；动效/GPU 设置区块（mountDesktopSettings）不受影响。
  return false
  if (!isDesktop || !host) return false
  bootDesktop()
  onImportRef = onImport ?? null
  const state = { ...library, onRescan }
  hostState = state
  return renderImportBlock(host, state)
}

/**
 * 在设置页挂载动效与GPU 区块。
 * @param {HTMLElement} host
 */
export function mountDesktopSettings(host) {
  if (!isDesktop || !host) return false
  bootDesktop()
  void renderMotionSettings(host)
  void renderGpuSettings(host)
  return true
}

/* ══════════════════════════启动 ══════════════════════════ */

let booted = false

/**
 * 桌面端启动引导：应用动效设置、启用拖拽、监听设置广播。
 * 幂等，可在界面就绪后与每次设置页打开时调用。
 */
export function bootDesktop() {
  if (!isDesktop || booted) return
  booted = true

  if (startup?.settings?.motion) motion.apply(startup.settings.motion)
  window.rhine.onMotionChanged((next) => motion.apply(next))

  // 拖拽导入已随「桌面导入方案」一并停用（2026-10-03 按用户要求恢复
  // 作者原版的 textarea 导入方式）；enableDragImport 保留但不再调用

  // 收集渲染层错误，供自检断言
  window.__RHINE_ERRORS__ = []
  window.addEventListener('error', (e) => window.__RHINE_ERRORS__.push(String(e.message)))
  window.addEventListener('unhandledrejection', (e) => window.__RHINE_ERRORS__.push(`rejection: ${e.reason}`))
}

/* ── 工具 ── */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function escAttr(s) { return esc(s) }
function notify(text) {
  try {
    window.dispatchEvent(new CustomEvent('rhine:notify', { detail: text }))
  } catch { /* 界面未挂载通知器时忽略 */ }
}
