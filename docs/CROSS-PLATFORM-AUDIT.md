# 跨平台改造：macOS 专属依赖清单与替换方案

> 阶段 1 交付物。对上游 `RonaldDeng/Rhine-Music-Demo`（MIT）逐文件审计的结果。
> 每一项都标注了「原始位置 / 问题 / 替换方案 / 涉及文件」。

## 0. 结论摘要

上游是**纯 Web 技术栈**（Vite + TypeScript + Three.js），音乐服务是一个
本地 Node HTTP 服务（`scripts/music-server.mjs`），通过浏览器访问。
它**不是** Electron / Tauri 应用，因此「macOS 专属依赖」的总量比预期小得多：

| 类别 | 数量 | 严重度 |
|---|---|---|
| 平台判断写死 darwin | 2 处 | 低 |
| AppleScript / Finder 集成 | 1 处（仅注释） | 无 |
| macOS 专属启动器 | 1 个文件 | **高（阻断 Windows）** |
| macOS 路径硬编码 | 3 处 | 中 |
| 浏览器打开方式写死 `/usr/bin/open` | 1 处 | **高（Windows 阻断）** |
| 打包 / 桌面壳层 | 0| **高（需新建）** |

**没有发现** `swift` / `objc` / `child_process` 调原生 API / 钥匙串 / 通知中心等深度系统集成。
上游的音乐库扫描、封面解析、在线资料查询全部是跨平台 Node 代码。

所以本次改造的真正工作量不在「移植」，而在**新增桌面壳层**（Electron）+
**补齐 Windows 的系统集成**（文件选择器、拖拽、GPU 检测、窗口动效）。

## 1. 平台判断写死 `darwin`

### 1.1 `scripts/launch-music.mjs:43`

```js
export function sameLegacyProcess(port, projectDir, run = spawnSync) {
  if (process.platform !== 'darwin') return false   // ← Windows 上恒为 false
  ...
}
```

**问题**：该函数用macOS 的 `ps`/`lsof` 组合判断「是否已有本项目的旧版服务」。
Windows 上直接返回 `false`，后果是**端口占用检测失效** —— 启动第二个实例时不会
复用已有服务，也不会给出「端口被占用」的清晰提示，而是静默失败或反复换端口。

**替换方案**：抽象为 `platform-probe.mjs`，按平台分派：

| 平台 | 端口归属判定 |
|---|---|
| darwin | `lsof -nP -iTCP:<port> -sTCP:LISTEN`（保留原逻辑） |
| win32 | `netstat -ano -p tcp \| findstr :<port>` → 取 PID → `wmic process where processid=<pid> get commandline`（回退 `Get-CimInstance`）|
| linux | `ss -lptn 'sport = :<port>'` |

匹配条件从「命令行包含 `node <projectDir>/scripts/music-server.mjs`」
改为跨平台的「命令行包含 `music-server.mjs` 且包含本项目目录」。

**影响文件**：`scripts/launch-music.mjs`、`scripts/platform-probe.mjs`（新增）、
`scripts/check-music-launcher.mjs`（该文件第 42 行的测试原本 `skip: process.platform !== 'darwin'`，
改造后应改为在 win32 上也运行）。

### 1.2 `scripts/capture-readme.mjs:24`

```js
process.platform === "win32"
```

**问题**：无。这是**已经正确处理跨平台**的写法（截图脚本里对 win32 做了分支）。

**替换方案**：保留，无需改动。仅记录以免误改。

### 1.3 `src/pwa.ts:13`

```js
const ios = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
```

**问题**：这是 **iOS 触控板误判**的经典写法（MacIntel + 触摸点数 = iPad 伪装桌面模式），
在 Windows 上不会误触发，属于**无害**。

**替换方案**：保留。桌面版不会走PWA 分支，此函数仅影响移动端网页。

## 2. AppleScript / Finder 集成

### 2.1 `启动音乐播放器.command:2`

```bash
# Finder does not load the user's interactive shell configuration.
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
```

**问题**：这是**唯一**的类 AppleScript / Finder 依赖，而且只是**注释 + PATH 修补**。
说明上游作者知道「从 Finder 双击启动时读不到 shell 配置」，于是手工补PATH。
**没有任何 osascript / tell application / Finder 调用。**

**替换方案**：Electron 桌面版不需要这个文件 —— 双击 exe 由Windows 启动器负责，
不再依赖 shell 环境。文件保留在仓库里仅作 macOS 兼容，**不参与 Windows 构建**。

**影响文件**：`启动音乐播放器.command`（保留，不打包）、新增 `启动音乐播放器.bat`（Windows 源码态启动）。

## 3. macOS 路径硬编码

### 3.1 `src/music-app.ts:1073`（**用户截图指向的入口**）

```html
<textarea id="music-roots" rows="3" placeholder="/Users/你的用户名/Music">…</textarea>
```

**问题**：placeholder 写死 macOS 路径。用户在 Windows 上看到 `/Users/你的用户名/Music`
会不知道该填什么（截图里正是这个界面）。

**替换方案**：**按需求删除该 textarea 入口**，改为「添加」按钮直接调起
系统文件夹选择器（`dialog.showOpenDialog({ properties: ['openDirectory'] })`）。
placeholder 随之消失，跨平台路径问题一次性解决。详见 `docs/MUSIC-IMPORT.md`。

### 3.2 `scripts/check-music-launcher.mjs:43`

```js
const root = '/Users/example/中文 与 空格 工程'
```

**问题**：测试夹具用macOS 路径，**仅测试数据**，不是运行时依赖。

**替换方案**：改为 `path.join(os.tmpdir(), '中文 与 空格 工程')`，让测试在任意平台都成立。

### 3.3 数据目录默认值

`scripts/launch-music.mjs` 里`dataDir = path.resolve(projectDir, '../music-data-v3')`
—— 相对项目目录，**已是跨平台**，无需改动。但桌面版要改为
`app.getPath('userData')`（见下）。

## 4. 浏览器打开方式写死

### 4.1 `scripts/launch-music.mjs:219`

```js
function openBrowser(url) {
  const result = spawnSync('/usr/bin/open', [url], { stdio: 'ignore' })
  if (result.status !== 0) console.log(`浏览器未自动打开，请手动访问：${url}`)
}
```

**问题**：**Windows 上必然失败**（无 `/usr/bin/open`），且 `spawnSync` 抛错时
`result.status` 为 `null`，错误信息不会打印。

**替换方案**：

| 平台 | 实现 |
|---|---|
| win32 | `cmd /c start "" "<url>"`（`start` 的首引号参数是窗口标题，不可省略）|
| darwin | `open <url>` |
| linux | `xdg-open <url>` |

**但桌面版根本不需要这个函数** —— Electron 直接 `win.loadURL()`，
不走「起服务 + 开浏览器」。该函数仅在源码态开发时保留。

## 5. 打包 / 桌面壳层（**最大缺口**）

上游**完全没有**桌面应用层：

| 上游现状 | Windows 桌面版需要 |
|---|---|
| Vite dev server + 浏览器 | Electron 主进程 + BrowserWindow |
| `npm run dev` 起服务 | 双击 exe |
| 音频靠`<audio>` 标签 | 需接入 Electron 音频策略 |
| 封面/模型走 HTTP `/api/artwork/:id` | 走 `file://` 或自定义协议 |
| 音乐库在 Node 服务的 `music-data-v3/` | 迁到 `app.getPath('userData')` |
| 无窗口、无托盘、无单实例 | 全部需要新建 |
| 无 GPU 策略 | 需要 NVIDIA 检测与回退 |

**方案选择：Electron 而非 Tauri**

| 维度 | Electron | Tauri |
|---|---|---|
| 复用上游 Three.js 场景 | ✅ 直接用 Chromium |⚠️ WebView2 差异（光���模型、色彩管理）|
| 接入 `music-metadata`（Node 库） | ✅ 直接 require |❌ 需 Rust侧重写 |
| 打包体积 | ~180 MB | ~8 MB |
| 团队熟悉度 | 高（本机已有 `electron-desktop-app` 技能） | 低 |

决定：**Electron**。理由是上游重度依赖 Three.js + Web Audio + `music-metadata`
（Node 生态），Tauri 的收益（体积）不足以抵消重写成本与渲染差异风险。

## 6. 需要新建的 Windows 专属能力清单

| # | 能力 | 实现 | 归属阶段 |
|---|---|---|---|
| 1 |桌面壳层与窗口生命周期 | `electron/main/main.js` | 阶段 2 |
| 2 | Vite 产物加载（file:// 与 http 双模） | `electron/main/main.js` | 阶段 2 |
| 3 | 音乐库服务以子进程内嵌 | `electron/main/library-service.js` | 阶段 2 |
| 4 | 文件夹选择器 | `dialog.showOpenDialog` | 阶段 3 |
| 5 | 窗口拖拽导入 | `webContents` `will-navigate` + `webUtils.getPathForFile` | 阶段 3 |
| 6 | NVIDIA GPU 检测与回退 | `app.getGPUFeatureStatus()` + `nvidia-smi` | 阶段 3 |
| 7 | Apple Music 风格动效 | `electron/renderer/motion.css` + 设置项 | 阶段 4 |
| 8 | 启动速度优化 | 预构建 + 延迟加载 + 快照 | 阶段 5 |

## 7. 许可证兼容性结论

- 上游 `LICENSE`：**MIT**（双署名：LBEILC + RonaldDeng）
- 上游 `NOTICE.md`：明确「MIT 不自动覆盖 `art/*.blend`、`public/assets/*.glb`、
  界面图标、截图动图、`typing-preview.wav` 等非代码资产」
- 桌面版**新增代码**同样以 MIT 发布，追加本项目署名，**不取代**上游两项署名
- **构建产物处理**：`art/`（Blender 工程，11 MB）与 `docs/media/`（截图动图，33 MB）
  不进入桌面版安装包；`public/assets/*.glb` 因运行时需要**必须保留**，
  打包时在NOTICE 中原样附带
- 字体 MiSans 按其字体协议随包，**不重新授权**

详见 `NOTICE.md` 与 `LICENSE`（均保持上游原文，仅在NOTICE 追加本项目条目）。
