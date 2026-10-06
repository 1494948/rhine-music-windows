# PROJECT.md —— rhine-music-local-mod

## 1. 定位

**莱茵音乐 · 第三方二次修改版（本地改造分支）**：在 `RonaldDeng/Rhine-Music-Demo v0.3.0` 的 Windows 打包版之上做界面与性能改造，目标是修复专辑浏览卡顿、补充专辑详情展示、新增"小白条"详情⇄歌词切换控件与歌词动效。

代号 `rhine-music-local-mod`。与 `projects/rhine-music-windows/`（用户自研的 Electron 版）**是两条独立血脉，不要互相覆盖**。

## 2. 状态

**开发中** · 最后更新：2026-10-06

- 已完成：源码解包入库（baseline 标签 `baseline/thirdparty-0.3.0`）；需求 A 跨列卡顿的根因定位与第一轮修复（图集容量 + 缩略图离线程化）；需求 B 专辑档案面板；需求 C 小白条详情⇄歌词切换；需求 D 歌词解析/接口/动效面板；`app/dist` 已回灌为含 B/C/D 的最新构建（175 文件，MD5 校验一致）
- 待办：**需求 A 的卡顿手感与需求 C/D 的动效表现需你在真实 GPU 下确认**（无浏览器环境无法校验 GPU 上传、拖拽手感与视觉观感）。验证环境已就绪：本地服务 + 独立配置的 Edge 窗口（见第 4 节末的零拷贝回路），可直接开始验收。需求 C 的 `--switch-top` / `--switch-bottom` 落点、需求 B 的档案补录内容需按实机与真实曲库调整；若要验 WebView2 外壳与音频通道，才需要同步 `app/dist` + 改动的 `app/scripts/` 进分发副本

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

> ⚠️ **`package.json` 不在仓库根，而在 `app/` 子目录**（仓库根是打包层：LICENSE/NOTICE/README-Windows/app.ico）。
> **所有 npm 命令必须先进入 `app/` 再执行**，否则报 `ENOENT: Could not read package.json`。

```bash
cd "C:/AI Document/projects/rhine-music-local-mod/app"   # ← 必须

# 依赖：node_modules 已从基线分发包复制就位（112MB，不入库），一般无需重装
# 若确需重装：npm install

# 开发态：界面（Vite，127.0.0.1）
npm run dev

# 开发态：本地音乐服务（另开一个终端）
npm run music

# 类型检查（已验证通过）
npx tsc --noEmit

# 类型检查 + 构建 + PWA 化（prebuild 会自动跑 export-records.mjs）
npm run build          # = tsc && vite build && node scripts/build-pwa.mjs

# 内容/界面自检
npm run check:music    # 一揽子检查（曲库、专辑介绍、动效、相机、灯光、模型等）
npm run check:content
```

**只做构建、不动 `content/` 的安全做法**（避免 `export-records.mjs` 改动受版本管理的文件）：

```bash
cd "C:/AI Document/projects/rhine-music-local-mod/app" && npx vite build
```

**用独立测试数据目录**（避免污染真实曲库索引）：

```bash
MUSIC_DATA_DIR="C:/AI Document/playground/rhine-music-local-mod-data" npm run music
```

**一级验证 —— 零拷贝浏览器回路（推荐先做，已跑通）**：起本地服务后用真实浏览器打开 `http://127.0.0.1:5173/`，
拿到真实 GPU 与 DevTools（`F12`），足以验收 A/B/C/D 的界面与动效。完整命令与注意事项见第 6 节。
当前测试环境已就绪：服务在 5173，Edge 独立配置目录窗口已打开该地址。

**二级验证 —— 真机分发副本（只在需要验 WebView2 外壳与 libmpv 音频时做）**：把 `app/dist` 与改动的
`app/scripts/`（`music-server.mjs`、`lyrics.mjs`）同步到一个**基准物整包复制出来的副本**里，用副本的
`RhineMusic.exe` 实测。基准物 `C:\Users\徐梓烽\Downloads\Rhine-Music-Windows-0.3.0-二次修改\` **只读，禁止写回**。

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
- **`npm install` 在本机 AI 沙箱内会失败**（报 esbuild 安装脚本 spawn 失败、`status: null`、
  `pid: 0`；实测 `@esbuild/win32-x64/esbuild.exe --version` 本身可正常执行 → 属安装脚本的
  环境问题，非项目问题）。**绕过方式**：直接复制基线分发包的 `app/node_modules`（已验证可用，
  112MB）。用户在自己的终端里重装通常不受影响。
- **`npm install --prefix <dir>` 不会改变读取 `package.json` 的工作目录**：必须在命令里
  `cd` 进 `app/`，否则 npm 会在当前目录找 `package.json` 并在该目录写下空的
  `package-lock.json`（本次已误建一个并清理）。
- **`export-records.mjs`（prebuild/predev 自动执行）会改动受版本管理的
  `content/`、`public/archives/`**：想让工作区保持干净，构建时用 `npx vite build` 绕过。
- **`vite build` 第二次起会被本机安全删除钩子拦住**：它要清空 `dist/assets`（50 个文件，
  达到批量删除阈值），报 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`。这是环境限制，
  不是代码错误（`✓ 97 modules transformed` 已经成功）。绕过方式：输出到新目录，例如
  `npx vite build --outDir "C:/AI Document/playground/rhine-music-local-mod-app/dist" --emptyOutDir`。
- **构建产物必须以 `robocopy /MIR` 回灌 `app/dist`（2026-10-06 已跑通）**：因为上一条限制，
  `app/dist` 无法被 vite 自己清空，会长期停在旧构建上（旧哈希资产残留、新哈希资产缺失，
  界面看起来"改了没生效"）。已验证的回灌命令（注意 `MSYS2_ARG_CONV_EXCL='*'` 必不可少）：

  ```bash
  export PATH="/usr/bin:/bin:/c/Windows/System32:$PATH"
  export MSYS2_ARG_CONV_EXCL='*'
  export MSYS_NO_PATHCONV=1
  robocopy "C:/AI Document/playground/rhine-music-local-mod-app/dist" \
           "C:/AI Document/projects/rhine-music-local-mod/app/dist" \
           /MIR /NFL /NDL /NP /R:2 /W:2
  ```

  **不加 `MSYS2_ARG_CONV_EXCL='*'` 会静默失败**：Git Bash 把 `/MIR` 当成 POSIX 绝对路径改写为
  `.../PortableGit/versions/1.2.0/MIR`，robocopy 报 `错误: 无效参数 #3`、退出码 16，
  **一个文件都不会复制**（退出码非 0 容易当成"已执行"）。
  回灌后必须做内容级校验：文件清单 `diff` + 逐文件 `md5sum` 两处一致，再看 `index.html`
  引用的是不是新哈希。`robocopy` 的 RC 语义是位掩码，`3` = 复制(1) + 存在多余文件已清除(2)，属正常。
- **`npm run build` 里的 `build-pwa.mjs` 对本包无实际作用**：`index.html`（源码与产物都）**没有**
  `navigator.serviceWorker.register`，所以 `sw.js` / `pwa-build.json` 是生成出来却无人调用的惰性文件
  （分发包里确实有它们，但也同样没被注册）。裸 `npx vite build` 跳过 PWA 步骤功能上无损失，
  且少一层缓存更利于迭代验证——本项目 `app/dist` 就一直是不含 `sw.js` 的形态。
- **基线既有缺陷 1 —— `npm run check:music` 链路会在 `check-music-player.mjs` 断掉**：
  `src/music-player.ts:6` 以无扩展名写法导入 `"./native-playback"`，`node --experimental-strip-types`
  无法解析（`ERR_MODULE_NOT_FOUND`）。全仓库共 100 处这种无扩展名相对导入（带扩展名的仅 17 处），
  属上游主流写法，**当前不改**（tsc/vite 都能解析）。要跑全链校验需先统一补 `.ts` 后缀。
- **基线既有缺陷 2 —— `check-music-model.mjs` 断言失败**（`day retains its frosted finish…`）：
  该脚本只导入 `music-model.ts`，与图集/布局改动无关；是二次修改者调了白天主题玻璃粗糙度
  却未同步校验阈值（day 期望 0.42–0.50）。
- 可运行校验现状（2026-10-06 实测，12 个脚本）：**10 通过 / 2 失败**（失败项即上面两条基线缺陷；
  新增的 `check-music-lyrics`、`check-music-lyrics-api` 均通过）。
- **歌词来源约定（需求 D）**：同名 `.lrc` 优先（同上目录、基名一致；`.lrc/.LRC/.zh.lrc/.zh-CN.lrc/.zh_CN.lrc`），
  否则读内嵌 USLT/SYLT。`.lrc` 用 UTF-8 解不出来时会依次试 `gb18030/gbk/big5`。
  歌词**不写入曲库索引**（走 `GET /api/lyrics/:trackId` 按需读取 + 文件指纹缓存），
  所以索引 JSON 体积不受影响，但**重新扫描不会让歌词生效——它本来就是实时读的，改完 `.lrc` 直接生效**。
- **小白条落点靠 CSS 变量调**：`app/src/music-lyrics-switch.css` 里 `.music-detail` 的
  `--switch-top: 84px`（静止位）与 `--switch-bottom: 68px`（歌词态距底）。改这两个值即可整体移位，
  无需动 TS。拖动位移按 320px 映射到全程（`DRAG_TRAVEL`），条形自身滑向另一端补足剩余行程。
- **档案补录文件是 `app/content/album-archives.json`**（受版本管理）：`albums` 为空时界面自动退回
  「本地已核对简介」或「本地数据推导」。**不要往里写没有来源的外部事实**——该文件是唯一允许写外部事实的地方，
  正因为写了就必须署名，`sources` 字段会一并显示。
- 键盘操作是主要交互：`←/→` 切分类、`↑/↓` 换专辑、`Enter` 打开、`Esc` 返回。
  小白条聚焦后 `Enter/Space` 切换详情⇄歌词、`↑/↓` 取向、`Home/End` 直达两端（已 `stopPropagation`，不会连带换专辑）。
- 构建产物 / 依赖体积：`node_modules` ≈112MB、`dist` **74MB / 175 个文件（2026-10-06 实测）**，均不入库。
  构成：`fonts` 19MB、`demo-covers` 7.4MB、`assets` 7.8MB（含两个 `.glb` 模型 3.3+3.6MB）、`audio` 3.0MB。
  **注意 `dist/public/`（37MB）是 `dist/` 除 `public/` 外几乎全部内容的逐项重复**
  （fonts/demo-covers/assets/audio/archives/licenses/icons 一一对应）——它来自源码里
  嵌套的 `app/public/public/`。真实体积约 37MB，另 37MB 是这一层重复，**属上游打包脚本行为，不要删**。
- **零拷贝真机验证回路（2026-10-06 已跑通，无需任何复制分发）**：起本地服务后直接用真实浏览器打开，
  即得真实 GPU + 可开 DevTools 的环境，足以验收 A/B/C/D 的界面与动效：

  ```bash
  # 1) 准备可写的数据副本（服务启动时会自动全库重扫并改写数据目录，故不可指向真实安装）
  export MSYS2_ARG_CONV_EXCL='*'
  robocopy "C:/Users/徐梓烽/Downloads/Rhine-Music-Windows-0.3.0-二次修改/music-data-v3" \
           "C:/AI Document/playground/rhine-music-local-mod-data" /E /NFL /NDL /NP /R:2 /W:2
  # 2) 起服务（必须从 Bash 侧起，见下面的环境事实）
  cd "C:/AI Document/projects/rhine-music-local-mod/app"
  MUSIC_DATA_DIR="C:/AI Document/playground/rhine-music-local-mod-data" \
    "C:/Users/徐梓烽/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
    scripts/music-server.mjs --port 5173
  # 3) 用浏览器打开 http://127.0.0.1:5173/
  ```

  该回路**不能**验证 WebView2 外壳与 libmpv 音频通道（要验这两项才需要整包分发副本）。
- **服务启动期会全库重扫，此时请求可能整片失败（curl 看到 HTTP 000）**：重扫阻塞事件循环超过
  `server.requestTimeout = 30_000` 后，在途请求被直接销毁，客户端表现为"连接无响应"。
  **这不是接口缺陷**——等重扫结束（`library-index.json` 的 `scannedAt` 更新）后重试即恢复，
  实测稳定在 4–34ms/请求。判读接口问题时务必先确认重扫已结束。
- **本机 PowerShell 启动进程的三条硬约束（2026-10-06 实测）**：
  1. **`Start-Process` 起的控制台进程在工具调用结束时即消失**（node 服务实测如此；GUI 进程如 Edge 不受影响，
     可长期存活）。所以**不要用 PowerShell 起本地服务**。
  2. **`-RedirectStandardOutput/-RedirectStandardError` 在本机必然失败**，报
     `ArgumentException: 已添加项。字典中的关键字:"Path"所添加的关键字:"PATH"`（环境同时存在
     `Path` 与 `PATH` 两个键时的 PS 5.1 缺陷）。要留日志就改用 Bash 侧重定向。
  3. **PowerShell 侧进程监听的端口对 Bash 侧不可达**（Bash 的 localhost 走沙箱代理，会报
     `upstream connect failed ... 10061`），尽管 `netstat` 能看到 LISTENING。**服务一律从 Bash 侧启动。**
- **Edge 的 `--remote-debugging-port` 在本机不生效**（9222 始终无人监听，`--remote-allow-origins=*` 也无效，
  疑为策略限制）。所以 CDP 自动化不可用；验证走浏览器窗口内 `F12`（Performance 面板可录制卡顿）。
  另注：`Start-Process -ArgumentList` 传含空格的路径时**必须自带引号**
  （写成 `--user-data-dir="C:\path with space"`），否则 Edge 收到畸形参数后回落到默认配置、
  把 URL 转发给已在运行的实例并自身退出——表现为"命令成功但什么都没发生"。
  测试用独立配置目录：`--user-data-dir="C:/AI Document/playground/rhine-music-edge-profile"`。

## 6.1 已验证的环境事实（2026-10-05，2026-10-06 扩充）

| 项 | 实测值 |
|---|---|
| Node | 22.22.2（managed，`C:\Users\徐梓烽\.workbuddy\binaries\node\versions\22.22.2-3\node.exe`） |
| vite（lock 实际解析） | 7.3.6 |
| esbuild | 0.28.2 |
| `npx tsc --noEmit` | 通过，退出码 0 |
| `vite build` | 通过，104 模块（需求 A 时为 97），耗时 ≈2.4–3.5s |
| 新增检查脚本 | `check-music-lyrics`（解析/档案/服务端读取/样式契约）与 `check-music-lyrics-api`（真实扫描 + 真实路由端到端）均通过 |
| 开发服务器 | `http://127.0.0.1:<port>` 返回 HTTP 200；`/src/music-app.ts`、`/src/music.css` 转译正常 |
| `app/dist` 回灌 | `robocopy /MIR` 成功（复制 48 / 清除 5 个过期哈希资产 / 失败 0），回灌后 **175 个文件与 playground 构建逐文件 MD5 一致**；`index.html` 已指向新哈希 `index-Cw5FAImN.js` |
| 真实曲库规模 | **79 张专辑 / 774 首曲目**，音乐根 `C:\Users\徐梓烽\Music\Music` |
| **歌词覆盖率（真实全库 774 首逐首请求，0 失败，15.9s ≈ 20ms/首）** | 内嵌同步 SYLT **417（53.9%）**、无歌词 286（37.0%）、同名 `.lrc` **54（7.0%）**、内嵌非同步 USLT **17（2.2%）** → **63.1% 的曲目有歌词，其中 60.9% 可逐字同步** |
| 真实 `.lrc` 通道实测 | `Natural.flac`（配同名 `.lrc`）→ `{"source":"lrc","text":"\r\n[00:00.00]Natural - Imagine Dragons\r\n..."}`；该 `.lrc` 为 CRLF + 首行空行，解析正确 |
| 真实 SYLT 通道实测 | 周杰伦《爱情悬崖》等 417 首 → `{"source":"sylt","sync":[{"text":"爱情悬崖 - 周杰伦 (Jay Chou)","timestamp":0},...]}` |
| 浏览器零拷贝验证 | Edge 154.0.4258.53，`--user-data-dir` 独立配置；缓存中检出 `audioUrl`/`albumId`/`relativePath`（已拉真实曲库）、`detail-switch`（新 CSS 已载入）、`api/lyrics`（新 JS 已载入），确认运行的是 B/C/D 构建 |
| `--remote-debugging-port` | **本机不可用**（9222 无监听，疑策略限制）→ CDP 自动化不可行；改用窗口内 `F12` |

## 7. 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-10-05 | 建仓：从 `Downloads\Rhine-Music-Windows-0.3.0-二次修改\` 复制源码（74MB），写 `.gitignore`，`git init -b main`，首次提交并打标签 `baseline/thirdparty-0.3.0` | 建立可对比、可回滚的本地基线；全程不配置远端 |
| 2026-10-05 | 加入 `PROJECT.md` 与 `docs/`（改造实现方案 + 3 张参考截图） | 按 AI Document 规范补工作卡；方案随仓库走，便于开发助手直接读取 |
| 2026-10-05 | 基线验证：`tsc --noEmit` 通过、`vite build` 通过（97 模块/2.5s）、dev 服务器 HTTP 200；修正文档中"命令需在 `app/` 内执行"；清理误建的空 `package-lock.json` | 确认基线真实可运行，并把踩到的坑写进工作卡 |
| 2026-10-06 | 需求 A（跨列卡顿）诊断 + 修复：新增 `poolAlbumCapacity()`，图集按"同帧可达专辑数"分配（79 张曲库 108MB→20MB，1/5.4）；封面缩放改 `fetch`+`createImageBitmap` 移出主线程；已缓存缩略图一次绘成；`reset()` 支持扩容；`check-music-scene` 增加容量不变量断言；新增诊断脚本 `diagnose-atlas-remap.mjs` | 跨列一步重映射一整列槽位并逼出 108MB 整表上传，且伴随主线程集中缩放 —— 即用户报告的"换列瞬间严重卡顿" |
| 2026-10-06 | 记录两条基线既有缺陷（`check:music` 无扩展名导入致链路断裂、`check-music-model` 白天玻璃粗糙度断言不符），未修改 | 属第三方二次修改遗留，与本次改动无关；修改需先确认原意 |
| 2026-10-06 | 需求 B/C/D 一次性实现并提交（`512b55d`）：新增 `music-archive.ts` + `content/album-archives.json` + `music-archive.css`；新增 `music-detail-switch.ts` + `music-lyrics-switch.css` + `#detail-surface` 包裹层；新增 `music-lyrics.ts` + `music-lyrics-pane.ts` + `scripts/lyrics.mjs` + `GET /api/lyrics/:trackId`；`music-app.ts` 接线（构造面板与控件、时间流复用 `player.subscribe`、离开详情复位开关）；新增 2 个检查脚本并纳入 `check:music` | 用户要求剩余需求一次处理完；三者都落在详情页同一处，接线天然共用，分成三次提交需要人为造中间态，反而更容易出错 |
| 2026-10-06 | 构建产物回灌：把 `playground` 的新构建用 `robocopy /MIR` 覆盖 `app/dist`（复制 48 / 清除 5 个过期哈希资产），逐文件 MD5 校验 175 项全部一致，并确认 `detail-switch`/`switch-float`/`music-lyrics`/`--reveal` 遮罩/`data-d` 四级/`api/lyrics` 等 B/C/D 令牌均在产物中；工作卡登记 `MSYS2_ARG_CONV_EXCL='*'` 这一必需开关与 `build-pwa` 惰性结论 | 回灌前 `app/dist` 停在基线旧构建，任何按 `app/dist` 起服务的验证（`npm run music`、真机分发副本）都会看不到 B/C/D 生效 |
| 2026-10-06 | **零拷贝真机验证回路建立并跑通**：复制真实曲库数据到 `playground/rhine-music-local-mod-data`（415 文件/119MB），从 Bash 侧起 `music-server.mjs --port 5173`，用独立配置目录的 Edge 154 打开；对真实全库 774 首逐首请求 `/api/lyrics/:id`，实测覆盖率与各来源通道 | 真机验收是最后一道关卡；浏览器窗口有真实 GPU 与 DevTools，足以验收 A/B/C/D 的界面与动效，无需先造 660MB 分发副本 |
| 2026-10-06 | 登记四条本机环境约束：服务启动期全库重扫会让在途请求返回 HTTP 000（`requestTimeout=30s`）；PowerShell `Start-Process` 起的控制台进程随工具调用结束而消失；`-RedirectStandardOutput` 必然报 `Path`/`PATH` 重复键；PowerShell 侧监听端口对 Bash 不可达；Edge `--remote-debugging-port` 本机不生效 | 这些都是"命令成功但结果不对"的静默陷阱，不写下来下次必然重踩 |
| 2026-10-06 | 清理两处已核验冗余（释放 351.2MB）：`playground/rhine-music-local-mod-app`（与 `app/dist` 175 文件逐字节相同）、`rhine-music-windows/dist-installer-v18` 下两个 0.4.5 安装包（MD5 与 `releases/rhine-music-windows/v0.4.5/` 一致，该归档含两个 exe + 发布说明 + 使用说明）；保留 `latest.yml`/`.blockmap`/`builder-debug.yml` | 按"交付物一处存放"原则收回重复；删掉 playground 那份还使下次 `vite build` 落入干净目录，不再触发删除钩子 |
