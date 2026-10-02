/**
 * 桌面端注入的全局类型声明。
 *
 * preload 通过 contextBridge 把 `window.rhine` 暴露给页面。
 * 浏览器（无 Electron）环境下该对象不存在，因此全部标为可选。
 */

interface RhineStartupPayload {
  platform: NodeJS.Platform | string
  isWindows: boolean
  version: string
  settings: {
    motion: {
      enabled: boolean
      duration: "instant" | "fast" | "normal" | "slow"
      easing: "apple" | "emphasized" | "decelerate" | "linear"
      performanceMode: "full" | "balanced" | "performance"
    }
    gpu: { enabled: boolean; forceCpu: boolean }
    library: { roots?: string[]; suggestedRoots?: string[] }
    theme: "day" | "night"
    minimizeToTray: boolean
    port: number
  }
  gpu: {
    vendor: string
    vendorLabel: string
    rendererName: string
    driverVersion: string
    hardwareAccelerated: boolean
    recommended: string
    scope?: Record<string, string>
  } | null
  paths: { userData: string; musicData: string; log: string }
}

interface RhineScanStats {
  totalFiles: number
  totalBytes: number
  totalRoots: number
  rejectedCount: number
  errorCount: number
  truncated: boolean
}

interface RhineApi {
  startup: RhineStartupPayload | null

  getAppInfo(): Promise<{
    version: string
    platform: string
    userData: string
    electron: string
    chrome: string
    node: string
  }>
  openPath(target: string): Promise<boolean>

  library: {
    pickFolders(): Promise<{ canceled: boolean; roots: string[] }>
    scan(roots: string[]): Promise<{
      roots: string[]
      rejectedRoots: string[]
      files: Array<{ path: string; name: string; ext: string; size: number }>
      stats: RhineScanStats
      errors: Array<{ path: string; code: string; message: string }>
    }>
    getRoots(): Promise<{ roots: string[]; suggested: string[] }>
    removeRoot(root: string): Promise<{ roots: string[] }>
    reveal(target: string): Promise<{ ok: boolean }>
    resolveDropped(files: File[]): Promise<string[]>
  }

  gpu: {
    getReport(): Promise<NonNullable<RhineStartupPayload["gpu"]>>
  }

  settings: {
    get(): Promise<Record<string, unknown>>
    set(patch: Record<string, unknown>): Promise<{ settings: Record<string, unknown>; restartRequired: boolean }>
  }

  onStartup(fn: (payload: RhineStartupPayload) => void): () => void
  onMotionChanged(fn: (motion: RhineStartupPayload["settings"]["motion"]) => void): () => void
  onThemeChanged(fn: (theme: "day" | "night") => void): () => void
}

interface Window {
  rhine?: RhineApi
  /** 渲染层错误收集，供自检断言用 */
  __RHINE_ERRORS__?: string[]
}
