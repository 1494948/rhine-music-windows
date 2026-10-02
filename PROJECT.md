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
| 目标仓库 | 用户自建 GitHub 仓库（`rhine-music-windows`） |
| 分支 | `main` |
| 产品名 | Rhine Music |
| appId | `com.rhinemusic.windows` |
| 产物命名 | `Rhine Music-<版本>-setup.exe` / `-portable.exe` |
| 许可 | MIT（保留 LBEILC + RonaldDeng 署名，追加本项目） |

## 6. 已知的坑（本机实测）

1. **`ELECTRON_RUN_AS_NODE` 必须清除**，否则 `electron.exe` 以纯 Node 模式启动
2. **沙箱下必须加 `--no-sandbox --disable-gpu`**，否则渲染进程被杀
3. **`git clone` 会报 `CRYPT_E_NO_REVOCATION_CHECK`** → 用
   `git -c http.schannelCheckRevoke=false clone`
4. **electron-builder 每次必须换新输出目录**（`--config.directories.output=dist-installer-vN`），
   安全删除钩子会拦下目录清理
5. **`app.asar` 长期被进程占用**（错误码 32），清理要等进程退出
6. **`fs.cpSync` 在中文长路径下报 `EIO`**，便携版打包要自实现递归复制
7. **winCodeSign 下载会因本机 TLS 中间人代理失败** → 预取到
   `%LOCALAPPDATA%\electron-builder\Cache`
8. **同一文件禁止并行 Edit**（会静默丢改动）

## 7. 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-10-02 | 建立项目骨架，复制上游源码（src/scripts/public/content） | 阶段 1 起点 |
| 2026-10-02 | 产出 `docs/CROSS-PLATFORM-AUDIT.md`（macOS 依赖全量审计） | 阶段 1 交付：先摸清依赖再动手 |
| 2026-10-02 | 确认技术选型 Electron（弃 Tauri） | 上游重度依赖 Three.js + Node 生态，Tauri 重写成本高于体积收益 |
