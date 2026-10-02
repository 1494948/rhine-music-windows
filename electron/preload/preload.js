/**
 * preload：白名单 API 桥接。
 *
 * 渲染进程运行在 contextIsolation 下，不能直接碰 Node/Electron。
 * 拖拽导入的关键点：`File` 对象取真实路径必须用 `webUtils.getPathForFile`，
 * 通过 IPC 传给主进程，在渲染进程侧是拿不到的。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron')

/** 统一处理 {ok,data,error} 包装，失败时抛出可读错误。 */
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args)
  if (!res) throw new Error(`${channel} 无响应`)
  if (!res.ok) {
    const err = new Error(res.error || `${channel} 调用失败`)
    err.code = res.code
    throw err
  }
  return res.data
}

contextBridge.exposeInMainWorld('rhine', {
  /**
   * 启动信息（同步可得）。
   * preload 在页面脚本之前执行，所以这里的值在界面首屏渲染时就已就绪，
   * 不需要界面代码 await 异步 IPC —— 上游是纯 Web 代码，不认识 Electron。
   */
  startup: (() => {
    try {
      return ipcRenderer.sendSync('app:startupSync') ?? null
    } catch {
      return null
    }
  })(),

  // 应用
  getAppInfo: () => call('app:info'),
  openPath: (target) => call('shell:openPath', target),

  // 音乐库
  library: {
    pickFolders: () => call('library:pickFolders'),
    scan: (roots) => call('library:scan', roots),
    getRoots: () => call('library:getRoots'),
    removeRoot: (root) => call('library:removeRoot', root),
    reveal: (target) => call('library:reveal', target),
    /** @param {File[]} files 拖拽得到的 File 列表 */
    resolveDropped: (files) => call('library:resolveDropped', files),
  },

  // GPU
  gpu: {
    getReport: () => call('gpu:getReport'),
  },

  // 设置
  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
  },

  // 事件订阅：返回取消订阅函数
  onStartup: (fn) => subscribe('app:startup', fn),
  onMotionChanged: (fn) => subscribe('motion:changed', fn),
  onThemeChanged: (fn) => subscribe('theme:changed', fn),
})

function subscribe(channel, fn) {
  if (typeof fn !== 'function') return () => {}
  const listener = (_event, payload) => {
    try {
      fn(payload)
    } catch (error) {
      console.error(`[preload] ${channel} 回调异常:`, error)
    }
  }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// 拖拽取路径：必须在 preload 里做，渲染进程拿不到
contextBridge.exposeInMainWorld('__rhineInternal', {
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return null
    }
  },
})
