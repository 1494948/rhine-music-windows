/**
 * 桌面端集成模块的类型声明。
 *
 * desktop-ui.js / motion.js 是纯 JS（由 Vite 直接打包，不经 tsc），
 * 但从 TypeScript 侧引用时需要类型。
 *
 * 注意：这里用 `declare module "..."` 的 ambient 写法而不是相对路径，
 * 因为 tsconfig 的 moduleResolution 是 Bundler，且 include 只有 src。
 * 相对路径写法在 Bundler 解析下解析不到 src/ 之外的 .js 文件。
 */
declare module "@desktop/desktop-ui.js" {
  export const isDesktop: boolean
  export function bootDesktop(): void
  export function mountImport(
    host: HTMLElement,
    library: unknown,
    onRescan: () => void,
    onImport: (roots: string[]) => Promise<unknown>,
  ): boolean
  export function mountDesktopSettings(host: HTMLElement): boolean
  export function renderImportBlock(host: HTMLElement, library: unknown): boolean
  export function renderMotionSettings(host: HTMLElement): boolean
  export function renderGpuSettings(host: HTMLElement): Promise<boolean>
  export function enableDragImport(): void
}

declare module "@desktop/motion.js" {
  export interface MotionSettings {
    enabled: boolean
    duration: "instant" | "fast" | "normal" | "slow"
    easing: "apple" | "emphasized" | "decelerate" | "linear"
    performanceMode: "full" | "balanced" | "performance"
  }
  export const motion: {
    settings: MotionSettings
    active: boolean
    durationMs: number
    apply(next: Partial<MotionSettings>): MotionSettings
    play(el: HTMLElement, kind?: string): void
    describe(): {
      active: boolean
      durationMs: number
      durationLabel: string
      options: Record<string, Array<{ value: string; label: string; ms?: number }>>
      perf: { blur: boolean; shadows: boolean; particle: boolean; label: string }
      systemReduced: boolean
    }
  }
}
