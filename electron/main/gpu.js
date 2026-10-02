/**
 * GPU 加速：NVIDIA 检测、能力探测、优雅回退。
 *
 * 作用范围（明确边界，便于用户理解「加速了什么」）：
 *   1. Three.js WebGL 渲染（3D 档案卡 / 专辑模型 / 光照）—— 主战场
 *   2. 音频解码（WebAudio + Chromium 解码器，运行在 GPU 进程/媒体进程）
 *   3. 波形 / 频谱可视化计算（渲染层 Canvas2D + WebGL）
 *
 * 不加速：音乐文件读写、music-metadata 解析、HTTP 服务 —— 那些是纯 CPU/IO。
 */
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

/** @typedef {'nvidia'|'amd'|'intel'|'apple'|'software'|'unknown'} GpuVendor */

const GPU_SCOPE = {
  decode: '音频解码',
  render: 'Three.js 场景渲染',
  visualize: '波形 / 频谱可视化',
}

/**
 * 通过 Windows 图形 API 与 nvidia-smi 探测 GPU。
 * @param {import('electron').App} app
 * @returns {Promise<GpuReport>}
 */
async function detectGpu(app) {
  /** @type {GpuVendor} */
  let vendor = 'unknown'
  let rendererName = ''
  let driverVersion = ''

  // 路线 1：Electron/Chromium 的 GPU 特性状态（最可靠，跨平台）
  let featureStatus = {}
  try {
    featureStatus = app.getGPUFeatureStatus() ?? {}
  } catch {
    featureStatus = {}
  }

  // 路线 2：nvidia-smi 确认是否为 NVIDIA 及驱动版本
  const nvidia = await probeNvidiaSmi()

  // 路线 3：通过 renderer 的 WEBGL_debug_renderer_info 拿真实 GPU 名
  rendererName = nvidia.name ?? ''
  if (!rendererName) {
    rendererName = await probeRendererFromApp(app)
  }
  if (nvidia.version) driverVersion = nvidia.version

  vendor = classifyVendor(rendererName, nvidia.present)

  const webglAvailable = featureStatus.webgl === 'enabled'
  const hardwareConcurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null

  return {
    vendor,
    rendererName: rendererName || '未知渲染器',
    driverVersion,
    webglAvailable,
    /** 是否可以启用硬件加速（NVIDIA/AMD/Intel 独显或核显且 WebGL 可用） */
    hardwareAccelerated: webglAvailable && vendor !== 'software',
    /** Chromium 侧的降级原因（若发生） */
    degradedReason: webglAvailable ? null : (featureStatus.webgl ?? 'WebGL 不可用'),
    featureStatus,
    recommended:
      webglAvailable && vendor !== 'software'
        ? '启用：3D 档案卡与光照由 GPU 渲染，音频解码与波形可视化走 GPU 加速'
        : '回退：当前使用软件渲染（SwiftShader），3D 场景帧率会明显下降，可尝试更新显卡驱动',
  }
}

/** @returns {Promise<{present:boolean,name:string|null,version:string|null}>} */
async function probeNvidiaSmi() {
  const out = { present: false, name: null, version: null }
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,driver_version', '--format=csv,noheader'],
      { windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 },
    )
    const first = stdout.split(/\r?\n/).find((l) => l.trim())
    if (!first) return out
    const [name, version] = first.split(',').map((s) => s.trim())
    out.present = true
    out.name = name || null
    out.version = version || null
  } catch {
    // 没有 nvidia-smi（无 NVIDIA 卡，或驱动未装 PATH）——属正常情况
  }
  return out
}

/** @param {import('electron').App} app @returns {Promise<string>} */
async function probeRendererFromApp(app) {
  try {
    // 借一个隐藏窗口读取 WebGL renderer 字符串
    const { BrowserWindow } = require('electron')
    const win = new BrowserWindow({ show: false, width: 64, height: 64 })
    try {
      await win.loadURL('data:text/html,<canvas id=c></canvas>')
      const name = await win.webContents.executeJavaScript(`(() => {
        try {
          const gl = document.getElementById('c').getContext('webgl2') || document.getElementById('c').getContext('webgl')
          if (!gl) return ''
          const ext = gl.getExtension('WEBGL_debug_renderer_info')
          return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : String(gl.getParameter(gl.RENDERER) || '')
        } catch { return '' }
      })()`)
      return String(name || '')
    } finally {
      win.destroy()
    }
  } catch {
    return ''
  }
}

/** @param {string} name @param {boolean} nvidiaPresent @returns {GpuVendor} */
function classifyVendor(name, nvidiaPresent) {
  const n = String(name).toLowerCase()
  if (n.includes('nvidia') || nvidiaPresent) return 'nvidia'
  if (n.includes('amd') || n.includes('radeon') || n.includes('ati')) return 'amd'
  if (n.includes('intel')) return 'intel'
  if (n.includes('apple') || n.includes('m1') || n.includes('m2') || n.includes('m3')) return 'apple'
  if (n.includes('swiftshader') || n.includes('llvmpipe') || n.includes('software')) return 'software'
  return 'unknown'
}

/**
 * 按用户设置构造 Chromium 启动开关。
 * @param {{enabled:boolean, vendor:GpuVendor, forceCpu?:boolean}} options
 * @returns {string[]} commandLine 片段
 */
function buildGpuSwitches(options) {
  const { enabled, vendor, forceCpu = false } = options
  if (!enabled || forceCpu) {
    // 优雅回退：软件光栅化，仍能跑，只是 3D 帧率降低
    return ['--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer=false']
  }
  /** @type {string[]} */
  const switches = [
    // 优先独显；失败时 Chromium 自动回落到核显
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    '--enable-accelerated-video-decode',
    '--enable-features=CanvasOopRasterization,AcceleratedVideoDecodeLinuxGL',
  ]
  if (vendor === 'nvidia') {
    // NVIDIA 专属：优先独显 + 关闭低效的同步路径
    switches.push('--force_high_performance_gpu', '--disable-features=UseChromeOSDirectVideoDecoder')
  } else if (vendor === 'software') {
    return ['--disable-gpu', '--use-gl=swiftshader']
  }
  return switches
}

/** 给渲染层用的可读摘要。 */
function summarizeGpu(report) {
  const vendorNames = {
    nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel',
    apple: 'Apple', software: '软件渲染（无硬件加速）', unknown: '未知',
  }
  return {
    ...report,
    vendorLabel: vendorNames[report.vendor] ?? '未知',
    scope: GPU_SCOPE,
  }
}

module.exports = { detectGpu, buildGpuSwitches, summarizeGpu, GPU_SCOPE }
