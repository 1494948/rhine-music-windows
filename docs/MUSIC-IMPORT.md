# 音乐库导入：文件夹选择器与拖拽

> 阶段 3 交付说明。对应需求 3：删除设置页的 textarea 添加入口，改为「添加」按钮调起系统选择器 + 拖拽导入。

## 1. 改造前 vs 改造后

| | 改造前（上游） | 改造后（本项目） |
|---|---|---|
| 添加入口 | `<textarea id="music-roots" placeholder="/Users/你的用户名/Music">` | 「添加」按钮 → 系统文件夹选择器 |
| 路径输入 | 手打绝对路径 | 只能通过选择器/拖拽获得，**杜绝手输错误** |
| 拖拽 | 不支持 | 支持拖文件夹到窗口任意位置 |
| 跨平台 | placeholder 写死 macOS 路径 | 路径由系统对话框产生，天然跨平台 |
| 多选| 支持（多行） | 支持（选择器 multiSelections） |

**被删除的代码位置**：`src/music-app.ts:1073` 的 textarea 及其相关处理函数。

## 2. 两条导入路径

### 2.1 「添加」按钮 → 系统文件夹选择器

```
渲染层点击「添加」
  → window.rhine.library.pickFolders()
  → 主进程 dialog.showOpenDialog({ properties: ['openDirectory','multiSelections'] })
  → 返回路径数组
  → window.rhine.library.scan(roots)
  → 递归扫描 + 去重 + 落盘到设置
```

关键点：
- `openDirectory` 保证只能选文件夹，不会误选单个文件
- Windows 上会调起原生 Shell 选择器（`IFileDialog`），不是浏览器自绘的文件 input
- 用户取消时返回 `{ canceled: true }`，不触发任何扫描

### 2.2 拖拽导入

```
用户把文件夹拖到窗口
  → 渲染层 dragover: preventDefault（必须，否则 drop 不触发）
  → drop: 拿到 File[] / DataTransferItem 列表
  → window.rhine.library.resolveDropped(files)
  → 主进程 webUtils.getPathForFile(file) 取真实路径
  → 扫描
```

**为什么必须在主进程取路径**：Electron 从 v32 起出于安全考虑，
渲染进程里 `File.path` 已被移除。唯一途径是 `webUtils.getPathForFile()`，
它只能在 preload/主进程上下文调用。这是最容易踩空的一点。

**拖入的是文件而非文件夹时**：自动取其所在目录（体验更宽容）。

## 3. 递归扫描的边界

实现在 `electron/main/library-scanner.js`，参数刻意保守：

| 参数 | 值 | 理由 |
|---|---|---|
| `MAX_FILES_PER_ROOT` | 20000 | 误拖整块盘时不至于扫到天荒地老 |
| `MAX_DEPTH` | 12 | 防御异常深的目录树 |
| `CONCURRENCY` | 32 | Windows 上过高会撞 IONode 句柄上限（`EMFILE`） |
| 符号链接 | 默认不跟随 | 防环；跟随需显式开启 |
| 跳过目录 | `.git` `node_modules` `$RECYCLE.BIN` `System Volume Information` 等 | 避免权限噪音 |

支持的音频格式（沿用上游口径）：
`flac / wav / m4a / mp4 / alac / dsf / dff / mp3 / aac / aiff / aif / ogg / opus`

## 4. 去重策略

三层，缺一不可：

1. **同一次扫描内**：`existingPaths` Set 共享给每个 `scanRoot`
2. **跨根目录**：父目录与子目录同时被选中时，合并为一个根（子目录文件不重复统计）
3. **跨平台归一化**：`normalizeForCompare()` 统一分隔符、去尾斜杠，
   Windows 下额外转小写 —— 避免 `C:\Music\a.mp3` 与 `C:/music/A.MP3` 被算成两个

## 5. 权限与失败处理

扫描**从不抛出未捕获异常**，每个失败都被记录成结构化条目：

```js
{ path, code, message }
```

错误码与用户可读文案：

| code | 触发条件 | 展示文案（节选） |
|---|---|---|
| `NOT_FOUND` | 目录已删除/移动 | 「xxx」已不存在，可能已被移动或删除 |
| `NOT_A_DIRECTORY` | 传入了文件 | 不是文件夹 |
| `PERMISSION_DENIED` | EACCES / EPERM | 没有权限读取「xxx」，请在文件夹属性中授予访问权限，或以管理员身份运行 |
| `EBUSY` | 被其他程序占用 | 「xxx」正被其他程序占用，已跳过 |
| `EMFILE` / `ENFILE` | 句柄耗尽 | 打开的文件过多，已跳过该目录 |
| `ELOOP` | 符号链接成环 | 「xxx」包含循环链接，已跳过 |
| `MAX_DEPTH` | 超过 12 层 | 层级超过 12，已跳过 |
| `TOO_MANY_FILES` | 超过 20000 | 超过 20000 个文件，已截断 |

**扫描中断而非整体失败**：某个子目录读不到，只记一条错误，其余继续。
只有根目录本身不可读才会被列入 `rejectedRoots`。

## 6. 数据落盘位置

| 数据 | 路径 |
|---|---|
| 已选目录列表 | `%APPDATA%\rhine-music-windows\settings.json` → `library.roots` |
| 曲库索引 | `%APPDATA%\rhine-music-windows\music-data\library-index.json` |
| 服务日志 | `%APPDATA%\rhine-music-windows\logs\player-service.log` |

**迁移说明**：从上游沿用 `../music-data-v3` 的用户需要手动把旧数据目录内容
复制到新的 `music-data` 目录。曲库索引会在下次扫描时自动重建。

## 7. 验证方式

```bash
npm run check:scanner
```

覆盖 9 个用例：递归、去重（三种口径）、权限异常（两类）、
系统目录跳过、路径清洗、统计字段。

手工验证清单：

- [ ] 设置页不再出现 textarea，只剩「添加」按钮与已导入目录列表
- [ ] 点「添加」弹出 Windows 原生文件夹选择器，可多选
- [ ] 选中含中文/空格的目录能正确导入
- [ ] 拖拽文件夹到窗口能导入，且窗口有高亮反馈
- [ ] 同一目录导入两次，专辑/曲目数不翻倍
- [ ] 选一个无权限目录（如 `C:\Windows\System32\config`），UI 给出可读错误而非崩溃
- [ ] 已导入目录能「在资源管理器中显示」与移除
