# Rhine Music for Windows

> 本地音乐播放器桌面版 —— 可在 Windows 上双击运行。
> 上游：<https://github.com/RonaldDeng/Rhine-Music-Demo>（MIT）· 二次上游：<https://github.com/LBEILC/RhineLabUI>（MIT）

以完整专辑封面、实体唱片盒与本地曲库构成的私人音乐终端。本仓库是上游项目的
**Windows 桌面发行版**：用 Electron 把原本「起本地服务 + 开浏览器」的形态封装成
可安装的桌面应用，并补齐 Windows 系统集成、GPU 加速与动效设置。

---

## 功能

| 能力 | 说明 |
|---|---|
| 本地音乐库 | 递归扫描本地音频，按专辑/单曲组织，封面优先取内嵌图 |
| 文件夹导入 | 「添加」按钮调起系统选择器，或直接拖文件夹到窗口 |
| GPU 加速 | 自动识别 NVIDIA / AMD / Intel，失败优雅回退 CPU |
| Apple Music 风格动效 | 窗口过渡、播放列表切换、封面缩放，可关可调 |
| 3D 档案卡 | Three.js 渲染的专辑卡片与实体唱片盒 |
| 托盘常驻 | 关闭窗口最小化到托盘，可设为直接退出 |
| 深浅主题 | 跟随系统或手动指定 |

支持格式：`flac` `wav` `m4a` `mp4` `alac` `dsf` `dff` `mp3` `aac` `aiff` `aif` `ogg` `opus`
（DSF / DFF 暂不支持播放，仅列出）

---

## 安装

从 Releases 下载：

| 文件 | 说明 |
|---|---|
| `Rhine Music-<版本>-setup.exe` | **安装版**（推荐）。有安装向导，可选安装路径，自动建快捷方式 |
| `Rhine Music-<版本>-portable.exe` | **便携版**。免安装，双击即用 |

> 两者都未做代码签名，Windows SmartScreen 可能提示「未知发布者」。
> 点「更多信息」→「仍要运行」即可。

**三件最容易困惑的事**：
1. 关闭窗口**不等于退出**（默认最小化到托盘，从托盘图标右键「退出」）
2. 数据存在 `%APPDATA%\rhine-music-windows\`，卸载时默认保留
3. 升级前先从托盘完全退出，否则新文件写不进去

---

## 从源码运行

**前置**：Node.js 22.12 或更新的 LTS 版本。

```bash
npm install
npm start          # 正常启动
npm run start:safe # 显卡驱动异常或虚拟机里用这个
```

Windows 上也可直接双击 `启动音乐播放器.bat`。

> `npm install` 不能跳过：音乐服务依赖 `music-metadata` 解析标签，
> 界面依赖 `three`。

---

## 构建 Windows 产物

```bash
npm run build          # 安装包 + 便携版
npm run build:dir      # 仅解包目录（快速验证，不出安装包）
npm run build:portable # 仅便携版
```

产物位置：

```
dist-installer/
├── Rhine Music-0.4.0-x64.exe         # 安装包
└── Rhine Music-0.4.0-portable.exe    # 便携版
```

> **国内网络**：`.npmrc` 已配好镜像。若 electron-builder 报
> `unable to verify the first certificate`，是本机代理做 TLS 中间人导致，
> 临时用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过。
>
> **构建目录占用**：`dist-installer/` 约 300 MB，属构建产物可随时重建。
> 正式归档只保留一份在 `releases/`。

---

## 音乐库导入

两种方式任选：

1. **点「添加」按钮** → 弹出 Windows 原生文件夹选择器，可多选
2. **拖拽** → 把文件夹直接拖到应用窗口任意位置

导入会递归扫描子目录，处理去重（同一路径、跨平台大小写差异都识别），
并对权限不足、被占用、循环链接等情况给出可读提示而非静默失败。

原上游设置页那个手填路径的输入框（placeholder 写的是 `/Users/你的用户名/Music`）
已删除 —— Windows 上那个路径毫无意义，手输也容易出错。

详见 [`docs/MUSIC-IMPORT.md`](docs/MUSIC-IMPORT.md)。

---

## GPU 加速

启动时自动检测并给出建议：

- **NVIDIA**：启用独显优先 + 硬解 + 零拷贝
- **AMD / Intel**：启用通用高性能开关
- **无独显或驱动过旧**：自动回退软件渲染，3D 帧率下降但功能完整

设置页三档控制：开启硬件加速 / 关闭硬件加速 / 强制 CPU 渲染。

**加速范围**：3D 场景渲染、音频解码、波形可视化。
**不加速**：文件读写、标签解析（纯 CPU/IO，与 GPU 无关）。

> GPU 与端口设置在**进程启动时**生效，改完需重启应用。这是 Chromium 机制，
> 不是缺陷。设置页会明确提示。

详见 [`docs/GPU-ACCELERATION.md`](docs/GPU-ACCELERATION.md)。

---

## 动效设置

设置页「动效」区可调四个维度：

| 维度 | 选项 |
|---|---|
| 开关 | 开 / 关 |
| 时长 | 无 / 快速 140ms / 标准 260ms / 缓慢 420ms |
| 缓动曲线 | 标准 Apple / 强调 / 进场减速 / 线性 |
| 性能模式 | 完整效果 / 平衡 / 优先帧率（关闭毛玻璃） |

「优先帧率」会关掉 `backdrop-filter` —— 这是 Windows 上收益最明显的一档
（上游界面大量使用毛玻璃，集显笔记本容易掉到 30fps 以下）。

若系统开启了「减弱动画」（设置 → 辅助功能 → 视觉效果），动效会被自动关闭，
这是无障碍底线，不提供绕过入口。

详见 [`docs/MOTION-SYSTEM.md`](docs/MOTION-SYSTEM.md)。

---

## 数据与日志位置

| 内容 | 路径 |
|---|---|
| 设置 | `%APPDATA%\rhine-music-windows\settings.json` |
| 曲库索引 | `%APPDATA%\rhine-music-windows\music-data\library-index.json` |
| 服务日志 | `%APPDATA%\rhine-music-windows\logs\player-service.log` |

> 目录名取决于 `productName`，实际显示为 `Rhine Music`。

**从上游 Web 版迁移**：把旧的 `music-data-v3` 目录内容复制到新的
`music-data` 目录。曲库索引会在下次扫描时自动重建。

---

## 常见问题

**Q：双击没反应 / 一闪而过**
A：命令行里跑 `npm start` 看报错。最常见是 `ELECTRON_RUN_AS_NODE`
环境变量没清，用 `npm run start:safe` 试。

**Q：提示端口被占用**
A：设置页改端口（默认 5178），改完重启应用。

**Q：界面很卡**
A：设置 → 动效 → 性能模式切「优先帧率」；
设置 → 图形加速关掉硬件加速（也用于排查驱动问题）。

**Q：导入没反应 / 提示没有权限**
A：确认选的是文件夹而非文件。目录若需管理员权限，以管理员身份运行应用。
完整错误码表见 `docs/MUSIC-IMPORT.md`。

**Q：3D 场景不流畅**
A：先看设置里的显卡检测结果。若显示「软件渲染」，更新显卡驱动；
上游已有渲染质量设置（缩放比例 / 抗锯齿），降一档也有效。

**Q：能否移植回 macOS**
A：能。`electron/main/platform.js` 已做三平台分派，
macOS 分支保留原有 `open` / `lsof` 行为。构建目标改 `mac` 即可。

---

## 项目结构

```
electron/
├── main/                # 主进程（CommonJS）
│   ├── main.js              # 窗口、托盘、IPC、生命周期
│   ├── library-service.js   # 内嵌上游音乐服务的生命周期
│   ├── library-scanner.js   # 递归扫描 / 去重 / 权限处理
│   ├── platform.js          # 跨平台路径、端口探测、文件管理器
│   ├── gpu.js               # GPU 检测与开关
│   └── store.js             # 设置持久化（原子写）
├── preload/preload.js    # contextBridge 白名单 API
├── renderer/             # 注入页面的桌面增强
│   ├── desktop-ui.js        # 导入 UI、动效设置、GPU 设置
│   ├── motion.js            # 动效系统
│   ├── motion.css
│   └── desktop-ui.css
├── test/                 # 单元测试
└── renderer/fallback.html

scripts/                 # 上游脚本（含跨平台改造）
src/                     # 上游 TypeScript 源码
docs/                    # 改造文档
```

---

## 测试

```bash
npm run check:scanner    # 扫描器单元测试（9 个用例）
npm run typecheck        # TypeScript 类型检查

# 集成自检（会真的启动 Electron）
RHINE_SELFTEST=1 npx electron . --no-sandbox
```

---

## 许可与署名

代码以 **MIT** 发布。**原作者署名必须保留**：

| 范围 | 作者 |
|---|---|
| 音乐播放器适配及后续修改 | **Copyright (c) 2026 RonaldDeng** |
| 原版 RhineLabUI | **Copyright (c) 2026 LBEILC** |
| Windows 桌面发行版改造 | Rhine Music Windows contributors |

非代码资产（`art/*.blend`、界面图标、截图、`typing-preview.wav` 等）
**不因代码采用 MIT 而自动获得许可**，详见 [NOTICE.md](NOTICE.md)。
