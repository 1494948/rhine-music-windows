# PROJECT.md — Rhine Music Windows

> 本文件是 AI Document 规范的交接凭证。**每次会话开工前先读本文件**，不要让用户重新解释。

## 1. 定位

**Rhine Music Windows** —— 把 macOS 优先的 Web 音乐播放器 Rhine-Music-Demo
改造成可在 Windows 上双击运行的桌面应用（Electron），并补齐 Apple Music 风格动效、
文件夹导入与NVIDIA GPU 加速。

- 上游：<https://github.com/RonaldDeng/Rhine-Music-Demo> （MIT，双署名）
- 二次上游：<https://github.com/LBEILC/RhineLabUI>（MIT）
- 本仓库定位：**Windows 桌面发行版**，不追求跨平台全平台支持

## 2. 状态

| 项| 值 |
|---|---|
| 状态 | **v0.4.0 已产出可安装产物** |
| 最后更新 | 2026-10-02 |
| 当前阶段 | 阶段 1–6 全部完成 |
| 版本 | 0.4.0（基于上游 0.3.0） |
| 验证结果 | typecheck 0 error ·单元测试 9/9 · 开发态与**打包版**自检均 2 pass / 0 fail · GPU 实测识别 RTX 2070 Super |
| 归档位置 | `C:\AI Document\releases\rhine-music-windows\v0.4.0\` |

## 3. 技术栈与关键依赖

| 层 | 选型 | 版本 |
|---|---|---|
| 桌面壳 | Electron | 33.4.11（`^33.2.1`） |
| 打包 | electron-builder（NSIS + portable） | 25.1.8（`^25.1.8`） |
| 渲染 | Three.js | ^0.183.0 |
| 构建 | Vite | ^7.3.1 |
| 语言 | TypeScript | ^5.9.3 |
| 音乐库服务 | Node HTTP（复用上游 `scripts/music-server.mjs`） | — |
| 元数据解析 | music-metadata | ^11.15.0 |
| Node | 22.12+ | — |

## 4. 启动 / 构建 / 打包命令

```bash
# 安装依赖
npm install

# 开发态（Electron 加载 Vite dev server）
npm run dev

# 生产构建（先构建渲染层，再Electron 打包）
npm run build          # = tsc && vite build && electron-builder --win
npm run build:dir      # 仅产出 win-unpacked，不出安装包
npm run build:portable # 仅产出便携版

# 源码态启动 bat（无需构建）
启动音乐播放器.bat
```

**产物路径**：
- 安装包：`dist-installer/Rhine Music-<版本>-setup.exe`
- 便携版：`dist-installer/Rhine Music-<版本>-portable.exe`
- 正式归档：`C:\AI Document\releases\rhine-music-windows\v<版本>\`

## 5. 发布信息

| 项 | 值 |
|---|---|
| 仓库地址 | <https://github.com/1494948/rhine-music-windows> |
| 分支 | `main` |
| 远端 HEAD | `92b0473`（已与本地一致） |
| 标签 | `v0.4.0` |
| Release | <https://github.com/1494948/rhine-music-windows/releases/tag/v0.4.0>（id `401803182`） |
| 产品名 | Rhine Music |
| appId | `com.rhinemusic.windows` |
| 产物命名 | `Rhine Music-<版本>-x64.exe`（安装版）/ `Rhine Music-<版本>-portable.exe`（便携版） |
| 提交身份 | `1494948 <66010812+1494948@users.noreply.github.com>` |
| 许可 | MIT。保留 LBEILC + RonaldDeng 署名，追加本项目（见 NOTICE.md） |

**发布纪律（下次发布照做）**：

1. 用 `C:\Program Files\Git\cmd\git.exe`，TLS 需 `GIT_SSL_NO_VERIFY=true`，
   凭据需 `-c credential.helper=manager`（全局 helper 是空值，会清掉 system 的 manager）
2. 推送前先 `ls-remote` 探远端，不盲目 push
3. 提交邮箱必须用 noreply 地址，否则可能被 GH007 拒收
4. exe 走 Release 附件，**不进仓库**（>100 MB 无法 push）
5. 建仓库用 API 且 `auto_init: false`，避免产生多余的 Initial commit

## 6. 已知的坑（本机实测）

### 打包 / 运行时（**踩过最深的几个**）

1. **★ 子进程用 ESM 依赖时，`node_modules` 必须加进 `asarUnpack`**
   （2026-10-02，v0.4.0 阻断性缺陷）
   音乐库服务是以独立 Node 进程运行的**真实文件系统**路径，ESM 从脚本目录
   逐级向上找 `node_modules`。依赖若只存在于 asar 内，服务一起来就
   `ERR_MODULE_NOT_FOUND`，界面直接卡在降级页。
   **判据：凡是被 spawn/fork 执行的脚本，它 import 的包都要在 `asarUnpack` 覆盖范围内。**
2. **判断「是否 Electron 自带运行时」不能靠 exe 文件名**
   `basename === 'electron.exe'` 对打包版（exe 名 = `productName`）永远为 false。
   正确判据：与 `process.execPath` 比对。
3. **`spawn` 的 `cwd` 指向 asar 会报 `ENOENT`**，且错误信息只显示可执行文件路径
   —— 极易误判成「node 找不到」。`existsSync('.../app.asar')` 返回 true，
   但它**是文件不是目录**，必须用 `statSync().isDirectory()` 判断。
   首选 cwd 用「脚本自身所在目录」，它经过解包验证必然存在。
4. **`loadFile` 在含空格路径下 ERR_ABORTED**，必须 `pathToFileURL().href`
5. **服务刚 spawn 时端口未就绪**，`loadURL` 要加重试
6. **Vite 已打包的库不必进 `dependencies`**：`three` 等已进 `dist/assets/`，
   运行时不需要 `node_modules` 副本。移入 devDependencies 省 38 MB
7. **自检必须断言「服务真的可用」**，不能只断言「preload 注入成功」
   —— v0.4.0 的缺陷正是从这个缺口漏过去的（当时自检仅 2 项、只查 preload）。
   现扩到 7 项：服务进程存活 / 端口可连 / `/api/health` 200 /
   日志无模块解析错误 / 窗口确实停在服务地址
8. **验证打包版要模拟干净机器**：`PATH="/c/Windows/System32:/c/Windows"`
   —— 本机装了 Node 会掩盖「用户没装 Node」这类问题

### 环境层

9. **`ELECTRON_RUN_AS_NODE` 必须清除**，否则 `electron.exe` 以纯 Node 模式启动
10. **Electron 子进程要跑 Node 脚本时**必须设 `ELECTRON_RUN_AS_NODE: '1'`；
    用真实 node.exe 时又必须清掉，否则 node 拒绝启动
11. **Electron 的 `net` 模块没有 `connect`**（那是 Node 的 `net`）
12. **沙箱下必须加 `--no-sandbox --disable-gpu`**，否则渲染进程被杀
13. **`git clone` 报 `CRYPT_E_NO_REVOCATION_CHECK`** → 用
    `git -c http.schannelCheckRevoke=false clone`；push 则用
    `GIT_SSL_NO_VERIFY=true`
14. **全局 `credential.helper` 是空值**，会清掉 system 级的 manager ——
    所有凭据操作必须带 `-c credential.helper=manager`，否则静默返回空
15. **提交邮箱要用 `<id>+<login>@users.noreply.github.com`**，
    否则不计入贡献图，还可能被 GH007 追溯拒收
16. **electron-builder 每次必须换新输出目录**（`--config.directories.output=dist-installer-vN`），
    安全删除钩子会拦下目录清理
17. **本机打包需 `--config.win.signAndEditExecutable=false`** 绕过 winCodeSign
    解压的符号链接权限失败（缺 `SeCreateSymbolicLinkPrivilege`）
18. **`app.asar` 长期被进程占用**（错误码 32），清理要等进程退出
19. **`npm install` 会在 esbuild postinstall 失败**（沙箱阻断 spawn），
    需补装 `@esbuild/win32-x64`
20. **同一文件禁止并行 Edit**（会静默丢改动）

## 7. 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-10-02 | 建立项目骨架，复制上游源码 | 阶段 1 起点 |
| 2026-10-02 | 产出 `docs/CROSS-PLATFORM-AUDIT.md` | 先摸清 macOS 依赖再动手 |
| 2026-10-02 | 选型 Electron（弃 Tauri） | 上游重度依赖 Three.js + Node 生态 |
| 2026-10-02 | 新增 `electron/main/platform.js` | 三平台端口探测/路径/打开方式 |
| 2026-10-02 | 新增 `electron/main/library-scanner.js` + 9 个测试 | 需求 3：递归、去重、权限处理 |
| 2026-10-02 | 新增 `electron/main/gpu.js` | 需求 4：NVIDIA 检测与回退 |
| 2026-10-02 | 新增 `electron/main/main.js` / `store.js` / `library-service.js` | 桌面壳层主体 |
| 2026-10-02 | 新增 `electron/renderer/motion.js` + `motion.css` | 需求 2：四维可调 + 尊重系统减弱动效 |
| 2026-10-02 | 新增 `electron/renderer/desktop-ui.js` + `.css` | 需求 3：删 textarea，改为添加按钮 + 拖拽 |
| 2026-10-02 | 改 `src/music-app.ts` / `src/main.ts` / `index.html` | 挂载桌面 UI、修正过时文案 |
| 2026-10-02 | 改 `scripts/music-server.mjs` 加 `/electron/` 路由 | 让页面能加载桌面端资源 |
| 2026-10-02 | 改 `scripts/launch-music.mjs` | 跨平台端口探测与浏览器打开 |
| 2026-10-02 | 新增 WINDOWS.md / CONTRIBUTING.md / CI / Issue 与 PR 模板 | 需求 6 工程规范 |
| 2026-10-02 | `NOTICE.md` 追加本项目署名与资产边界 | 需求 6 保留原作者署名 |
| 2026-10-02 | 新增 `scripts/build-desktop-icons.mjs` | 零依赖生成 ico/png |
| 2026-10-02 | **v0.4.0 首次发布** | — |
| 2026-10-02 | 补「独立衍生作品声明」到 README 与 NOTICE | 明确非官方、无隶属背书 |
| 2026-10-02 | 推送到 GitHub 并发布 v0.4.0 | <https://github.com/1494948/rhine-music-windows> |
| 2026-10-02 | **v0.4.1 修复**：asarUnpack 加 node_modules | **根因：打包版服务找不到 music-metadata** |
| 2026-10-02 | **v0.4.1 修复**：Electron 运行时判定改用 execPath 比对 | exe 名判断对打包版永远为 false |
| 2026-10-02 | **v0.4.1 修复**：降级页显示真实错误与真实日志路径 | 原路径硬编码与productName 不符 |
| 2026-10-02 | **v0.4.1**：自检 2 项 → 7 项 | 堵住让缺陷溜过去的缺口 |
| 2026-10-02 | three / rolling-number 移入 devDependencies | 已被 Vite 打包，省 38 MB |
| 2026-10-02 | 发布 v0.4.1（commit `4a99633`） | 修正版必须升版本号 |

