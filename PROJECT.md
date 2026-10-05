# PROJECT.md —— rhine-music-local-mod

## 1. 定位

**莱茵音乐 · 第三方二次修改版（本地改造分支）**：在 `RonaldDeng/Rhine-Music-Demo v0.3.0` 的 Windows 打包版之上做界面与性能改造，目标是修复专辑浏览卡顿、补充专辑详情展示、新增"小白条"详情⇄歌词切换控件与歌词动效。

代号 `rhine-music-local-mod`。与 `projects/rhine-music-windows/`（用户自研的 Electron 版）**是两条独立血脉，不要互相覆盖**。

## 2. 状态

**开发中** · 最后更新：2026-10-05

- 已完成：源码解包入库（baseline 标签 `baseline/thirdparty-0.3.0`）
- 待办：需求 A 卡顿修复 / B 专辑档案 / C 小白条 / D 歌词动效（详见 `docs/` 与 `works/兴趣/2026-10-05-Rhine音乐专辑页交互与性能实现方案/实现方案.md`）

## 3. 技术栈与关键依赖

界面是 **Vite + 原生 TypeScript（无框架）+ three.js**；音频与窗口由外层原生包提供。

| 依赖 | 版本 |
|---|---|
| vite | ^7.3.1（dev） |
| typescript | ^5.9.3（dev） |
| three | ^0.183.0（含 @types/three ^0.183.0） |
| music-metadata | ^11.15.0（扫描期读元数据，**歌词内嵌标签也走它**） |
| opencc-js | ^1.4.2（简繁转换，专辑介绍用） |
| @kitlangton/rolling-number | 0.4.1 |
| prettier | ^3.9.6（dev） |
| Node.js | `>=22.12.0`（engines 要求） |

原生外壳（**不入库**，从原分发包取）：`RhineMusic.exe`（Win32 + WebView2 启动器）、`libmpv-2.dll`（音频内核）、`runtime/node.exe`。

## 4. 启动 / 构建 / 打包

```bash
# 安装依赖（只跑一次；node_modules 不入库）
npm install

# 开发态：界面（Vite，127.0.0.1）
npm run dev

# 开发态：本地音乐服务（另开一个终端）
npm run music

# 类型检查 + 构建（prebuild 会自动跑 export-records.mjs）
npm run build          # = tsc && vite build && node scripts/build-pwa.mjs

# 内容/界面自检
npm run check:music    # 一揽子检查（曲库、专辑介绍、动效、相机、灯光、模型等）
npm run check:content
```

**用独立测试数据目录**（避免污染真实曲库索引）：

```bash
MUSIC_DATA_DIR="C:/AI Document/playground/rhine-music-local-mod-data" npm run music
```

**终验（真机分发副本）**：把 `dist/` 与改动的 `scripts/` 同步到一个**基准物整包复制出来的副本**里，用副本的 `RhineMusic.exe` 实测。基准物 `C:\Users\徐梓烽\Downloads\Rhine-Music-Windows-0.3.0-二次修改\` **只读，禁止写回**。

## 5. 发布信息

| 项 | 值 |
|---|---|
| **GitHub 仓库** | **无 —— 本仓库仅本地使用**（`git remote -v` 必须始终为空） |
| 分支 | `main` |
| 基线标签 | `baseline/thirdparty-0.3.0` |
| 产品名 | Rhine Music（莱茵音乐）· 第三方二次修改版 |
| 当前版本 | 0.3.0（沿用上游 `package.json` 版本号） |
| 产物命名规则 | 无（本仓库不产出发布包） |

**为什么不推远端**：① 用户明确要求全程仅本地；② `NOTICE.md` 声明非代码资产（3D 模型、音效采样等）不随 MIT 再分发，公开发布存在许可风险。**任何会话都不得添加 remote、不得 push。**

## 6. 已知的坑

- **基座是第三方二次修改版，改动内容无文档**：与上游 v0.3.0 的差异未知。
  唯一可信基准是 `Downloads\Rhine-Music-Windows-0.3.0-二次修改\` 原件，**不要动它**；
  需要对比时另复制一份副本。
- **中文用户名路径**（`C:\Users\徐梓烽`）：项目内路径保持纯 ASCII。
- **本机 git 用 `C:\Program Files\Git\cmd\git.exe`**（有凭据管理器）；传路径参数写 `C:/...`，
  不要用 Git Bash 的 `/c/...` 形式。沙箱对"多语句 + cd 串联"的长命令偶发拒绝，
  改用 `git -C "C:/..." <命令>` 单条执行更稳。
- **不要把 `app/public/public/`（嵌套 37MB）当冗余删掉**：它是上游打包脚本的产物，
  删了可能影响构建或运行表现。原样保留。
- **真机性能问题的观测口**：WebView2 无法直接开 DevTools，需给启动器加
  `--remote-debugging-port=9222`，或用 `启动音乐播放器.bat` 走系统浏览器调试。
- 键盘操作是主要交互：`←/→` 切分类、`↑/↓` 换专辑、`Enter` 打开、`Esc` 返回。
- 构建产物 / 依赖体积：`node_modules` ≈112MB、`dist` ≈38MB，均不入库。

## 7. 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-10-05 | 建仓：从 `Downloads\Rhine-Music-Windows-0.3.0-二次修改\` 复制源码（74MB），写 `.gitignore`，`git init -b main`，首次提交并打标签 `baseline/thirdparty-0.3.0` | 建立可对比、可回滚的本地基线；全程不配置远端 |
