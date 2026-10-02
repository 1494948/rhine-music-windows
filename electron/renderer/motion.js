/**
 * Apple Music 风格动效系统。
 *
 * 设计目标：视觉与过渡节奏向 Apple Music 靠拢，但**可关闭、可调速、可降级**。
 *
 * 三个维度（对应设置页的三组控件）：
 *   1. 开关enabled —— 关掉后所有过渡时长归零，但布局照常（不做 display:none）
 *   2. 时长 duration —— instant / fast / normal / slow → 0 / 140 / 260 / 420 ms
 *   3. 缓动 easing —— apple（默认）/ emphasized / decelerate / linear
 *   4. 性能performanceMode —— full / balanced / performance
 *      performance 会关掉 backdrop-filter 与大面积 blur（Windows 上最贵的项）
 *
 * 用法：
 *   import { motion } from './motion.js'
 *   motion.apply(settings)          // 设置变更时调用
 *   el.dataset.motion = 'card'      // 标记参与动效的元素
 *   motion.play(el, 'enter')        // 手动触发
 */

/** 时长档位（毫秒）。Apple Music 的节奏基准约 250–300ms。 */
export const DURATIONS = {
  instant: 0,
  fast: 140,
  normal: 260,
  slow: 420,
}

/** 缓动曲线。apple 是 Apple 常用的复合曲线，decelerate 用于进场，emphasized 用于强调。 */
export const EASINGS = {
  /** 接近 Apple 的标准曲线：快起慢收 */
  apple: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
  /** 进场：起步快、减速停靠（Apple 强调「落位感」） */
  decelerate: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  /** 强调：用于按压/缩放这类需要「回弹」感的场景 */
  emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
  linear: 'linear',
}

export const PERFORMANCE_MODES = {
  full: { blur: true, shadows: true, particle: true, label: '完整效果' },
  balanced: { blur: true, shadows: true, particle: false, label: '平衡（默认）' },
  performance: { blur: false, shadows: false, particle: false, label: '优先帧率' },
}

const DEFAULTS = {
  enabled: true,
  duration: 'normal',
  easing: 'apple',
  performanceMode: 'balanced',
}

class MotionSystem {
  constructor() {
    this.settings = { ...DEFAULTS }
    this.reduced = false
    this._listeners = new Set()
    this.#detectSystemPreference()
  }

  /** 尊重系统的「减弱动态效果」设置（Windows 辅助功能里有这个选项）。 */
  #detectSystemPreference() {
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
      this.reduced = mq.matches
      mq.addEventListener?.('change', (e) => {
        this.reduced = e.matches
        this.apply(this.settings)
      })
    } catch {
      this.reduced = false
    }
  }

  /** @param {Partial<typeof DEFAULTS>} next */
  apply(next) {
    this.settings = { ...DEFAULTS, ...(next ?? {}) }
    this.#writeCssVars()
    this.#notify()
    return this.settings
  }

  get active() {
    // 用户开关关闭，或系统要求减弱动效 → 都不做动画
    return this.settings.enabled && !this.reduced
  }

  /** 实际时长：未启用时为 0；performance 模式略微缩短以保帧率 */
  get durationMs() {
    if (!this.active) return 0
    const base = DURATIONS[this.settings.duration] ?? DURATIONS.normal
    if (this.settings.performanceMode === 'performance') return Math.round(base * 0.7)
    return base
  }

  get easing() {
    return EASINGS[this.settings.easing] ?? EASINGS.apple
  }

  get perf() {
    return PERFORMANCE_MODES[this.settings.performanceMode] ?? PERFORMANCE_MODES.balanced
  }

  #writeCssVars() {
    const root = document.documentElement
    const ms = this.durationMs
    root.style.setProperty('--motion-duration', `${ms}ms`)
    root.style.setProperty('--motion-duration-fast', `${Math.round(ms * 0.6)}ms`)
    root.style.setProperty('--motion-duration-slow', `${Math.round(ms * 1.6)}ms`)
    root.style.setProperty('--motion-ease', this.easing)
    root.style.setProperty('--motion-ease-emphasized', EASINGS.emphasized)
    root.style.setProperty('--motion-ease-enter', EASINGS.decelerate)

    // 性能模式：关掉 blur（Windows 上 backdrop-filter 是最贵的一项）
    root.dataset.motionPerf = this.settings.performanceMode
    root.dataset.motion = this.active ? 'on' : 'off'
  }

  /**
   * 播放一次动效。
   * @param {HTMLElement} el
   * @param {'enter'|'exit'|'pulse'|'zoom'} kind
   */
  play(el, kind = 'enter') {
    if (!el || !this.active) return
    const cls = `motion-${kind}`
    el.classList.remove(cls)
    // 强制重排，保证连续点击能重新触发动画
    void el.offsetWidth
    el.classList.add(cls)
    const cleanup = () => el.classList.remove(cls)
    el.addEventListener('animationend', cleanup, { once: true })
    // 动画被系统跳过时不会触发 animationend，兜底清理避免类名残留
    setTimeout(cleanup, this.durationMs * 2 + 200)
  }

  /** 播放列表切换：整块内容交叉淡入 + 轻微上移 */
  transitionSwap(container, renderFn) {
    if (!container) return
    const paint = () => renderFn()
    if (!this.active) {
      paint()
      return
    }
    container.style.opacity = '0'
    container.style.transform = 'translateY(8px)'
    requestAnimationFrame(() => {
      paint()
      container.style.transition = `opacity var(--motion-duration) var(--motion-ease-enter), transform var(--motion-duration) var(--motion-ease-enter)`
      container.style.opacity = '1'
      container.style.transform = 'translateY(0)'
      setTimeout(() => {
        container.style.transition = ''
        container.style.transform = ''
      }, this.durationMs + 40)
    })
  }

  /** 封面缩放（Apple Music 播放页放大封面时的弹性感） */
  zoomCover(el, scale = 1.12) {
    if (!el) return
    if (!this.active) {
      el.style.transform = ''
      return
    }
    el.style.transition = `transform var(--motion-duration-slow) var(--motion-ease-emphasized)`
    el.style.transform = `scale(${scale})`
  }

  resetCover(el) {
    if (!el) return
    el.style.transition = `transform var(--motion-duration) var(--motion-ease)`
    el.style.transform = ''
  }

  onChange(fn) {
    if (typeof fn !== 'function') return () => {}
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  #notify() {
    for (const fn of this._listeners) {
      try {
        fn(this.settings)
      } catch (error) {
        console.error('[motion] 监听器异常:', error)
      }
    }
  }

  /** 给设置页用的可读摘要 */
  describe() {
    return {
      active: this.active,
      durationMs: this.durationMs,
      durationLabel: this.active ? `${this.durationMs} ms` : '已关闭',
      easing: this.settings.easing,
      performanceMode: this.settings.performanceMode,
      performanceLabel: this.perf.label,
      blurEnabled: this.active && this.perf.blur,
      systemReduced: this.reduced,
      options: {
        duration: Object.entries(DURATIONS).map(([k, v]) => ({ value: k, label: { instant: '无', fast: '快速', normal: '标准', slow: '缓慢' }[k], ms: v })),
        easing: Object.keys(EASINGS).map((k) => ({ value: k, label: { apple: '标准（Apple）', emphasized: '强调', decelerate: '进场减速', linear: '线性' }[k] })),
        performanceMode: Object.entries(PERFORMANCE_MODES).map(([k, v]) => ({ value: k, label: v.label })),
      },
    }
  }
}

export const motion = new MotionSystem()
