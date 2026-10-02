/**
 * 零依赖 JSON 设置存储：原子写入、延迟合并落盘、退出前强制 flush。
 *
 * 依据本机 `electron-desktop-app` 技能第 10 条：
 * 延迟合并写盘必须在退出钩子里补一次强制落盘，否则「操作完立刻关程序」会丢数据。
 */
const fs = require('node:fs')
const path = require('node:path')

const FLUSH_DELAY_MS = 180

class JsonStore {
  /**
   * @param {string} file 绝对路径
   * @param {object} defaults
   */
  constructor(file, defaults = {}) {
    this.file = file
    this.defaults = defaults
    this.data = { ...defaults }
    this._timer = null
    this._dirty = false
    this.load()
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = { ...this.defaults, ...parsed }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // 损坏的 JSON：备份后重建，不让应用起不来
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
        } catch { /* 备份失败也不阻塞 */ }
      }
    }
  }

  get(key, fallback) {
    if (key == null) return this.data
    const value = key.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), this.data)
    return value === undefined ? fallback : value
  }

  set(key, value) {
    if (key == null) {
      this.data = { ...this.defaults, ...value }
    } else {
      const keys = key.split('.')
      const last = keys.pop()
      let target = this.data
      for (const k of keys) {
        if (typeof target[k] !== 'object' || target[k] === null) target[k] = {}
        target = target[k]
      }
      target[last] = value
    }
    this._schedule()
    return this.data
  }

  /** 合并多个设置（浅合并顶层） */
  merge(patch) {
    this.data = { ...this.data, ...patch }
    this._schedule()
    return this.data
  }

  _schedule() {
    this._dirty = true
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.flush()
    }, FLUSH_DELAY_MS)
    // 不阻止进程退出
    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  /** 立即落盘。临时文件 + rename 保证原子性。 */
  flush() {
    if (!this._dirty) return
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this._dirty = false
    const tmp = `${this.file}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (error) {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
      // 落盘失败不能静默——启动时会被读到旧值，用户会以为设置没生效
      console.error('[store] 写入失败:', error.message)
    }
  }
}

module.exports = { JsonStore }
