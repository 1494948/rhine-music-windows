# 贡献指南

感谢参与 Rhine Music for Windows。

本项目是 [RonaldDeng/Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo)（MIT）
的 Windows 桌面发行版，上游另有 [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)（MIT）。
**三份署名都必须保留**，详见 [NOTICE.md](NOTICE.md)。

---

## 开发环境

| 工具 | 版本 |
|---|---|
| Node.js | 22.12 或更新的 LTS |
| npm | 随 Node |
| 操作系统 | Windows 10/11（主要开发平台） |

```bash
npm install
npm start          # 启动桌面应用
npm run start:safe # 显卡/沙箱异常时
```

---

## 目录约定

| 路径 | 放什么 | 说明 |
|---|---|---|
| `electron/main/` | 主进程（CommonJS） | 窗口、服务、扫描、GPU、设置 |
| `electron/preload/` | contextBridge 桥接 | 只暴露白名单 API |
| `electron/renderer/` | 注入页面的增强 | 动效、导入 UI、GPU 设置 |
| `electron/test/` | 单元测试 | `node --test` |
| `src/` | 上游 TypeScript 源码 | 尽量少改，见「改上游代码的原则」 |
| `scripts/` | 上游 Node 脚本 | 含跨平台改造 |
| `docs/` | 改造文档 | 每个能力一份 |

**主进程用 CommonJS，页面代码用 ESM。** 这是 Electron 的硬约束：
`package.json` 的 `type` 必须是 `commonjs`，否则主进程 `require` 会失败。

---

## 改上游代码的原则

上游代码来自 MIT 授权的外部项目，**尽量减少侵入式修改**：

1. **优先在 `electron/` 内做扩展**，通过 preload API 挂到页面上，
   不直接改 `src/*.ts` 的内部逻辑
2. 确需改上游文件时，用**注释块标注**改动原因与关联文档：

```ts
// 跨平台改造（2026-10-02）：原实现从 #music-roots textarea 读取目录，
// 该入口已按需求删除。详见 docs/MUSIC-IMPORT.md
```

3. 同步更新 `docs/CROSS-PLATFORM-AUDIT.md` 里对应的条目

这样上游更新时冲突面最小，署名边界也清晰。

---

## 提交信息

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>

<body>

<footer>
```

**type**：

| type | 用于 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修bug |
| `docs` | 只改文档 |
| `style` | 代码格式（不改逻辑） |
| `refactor` | 重构 |
| `perf` | 性能优化 |
| `test` | 测试 |
| `build` | 构建配置、依赖 |
| `chore` | 杂项 |

**scope**（按改动区域）：`main` / `preload` / `renderer` / `scanner` / `gpu` / `motion` / `build` / `deps`

示例：

```
feat(scanner): 支持拖拽导入与跨平台去重

拖拽的 File 对象需在主进程用 webUtils.getPathForFile 取真实路径，
渲染进程侧拿不到。跨根目录去重统一走 normalizeForCompare。

fix(main): 子进程需设 ELECTRON_RUN_AS_NODE=1

Electron 里 process.execPath 指向 electron.exe，不设该变量会再开一个
图形进程而不是跑 Node 脚本。
```

**破坏性变更**在 footer 写 `BREAKING CHANGE: <说明>`。

---

## 提交前检查

```bash
npm run typecheck       # 类型必须通过
npm run check:scanner   # 单元测试必须全绿
```

**渲染层改动的额外要求**：

- 遵守 [UI 陷阱清单](electron/renderer/README.md#ui-陷阱清单)，尤其：
  - `[hidden]` 属性可能被类选择器覆盖 → 全局加 `[hidden] { display: none !important }`
  - 全屏遮罩**不要**用 `backdrop-filter`，会把整个应用糊掉
  - `<label>` 默认 `display: inline`，画开关必须显式给 `display: inline-block`
  - 浮层默认拦截点击 → 纯展示浮层加 `pointer-events: none`
  - 叠层文字二选一（SVG 内或 HTML 覆盖层），可选参数默认值用 `null` 而非 `||` 兜底
  - 异步回调重绘前校验用户是否还在该页面
- 关闭动效时布局不能变

**主进程改动的额外要求**：

- 子进程 spawn 必须设 `ELECTRON_RUN_AS_NODE: '1'`
- 交外部进程执行的文件（`.ps1`/`.exe`）路径要走 `unpackAware()` 改写 asar 路径
- 设置写入必须走 `store.set()`，退出前 `store.flush()`
- 错误必须回传渲染层，不能只 `console.error`（否则 UI 一直转圈）

---

## 提Issue

请用模板。**务必附上**：

- Windows 版本与显卡型号
- 复现步骤
- 错误信息（服务日志：`%APPDATA%\rhine-music-windows\logs\player-service.log`）
- 截图（动效/GPU 问题建议录屏）

**提 bug 前先自查**：

- [ ] 端口 5178 是否被占用
- [ ] 显卡驱动是否最新
- [ ] 切「优先帧率」动效后问题是否消失（用于区分渲染性能问题）
- [ ] 关硬件加速后问题是否消失（用于定位驱动）

---

## 提 PR

1. 从 `main` 切分支：`feat/xxx`、`fix/xxx`、`docs/xxx`
2. 改动聚焦一件事，别把重构和功能混在一起
3. 填 PR 模板，说明**改了什么**、**为什么**、**怎么验证的**
4. CI 必须全绿

---

## 许可

贡献的代码以 **MIT** 协议发布，与项目一致。

**不要**提交：
- 音乐文件、专辑封面（版权不明）
- 私人曲库索引、缓存
- 真实用户数据或截图（含私人曲名）

截图请用**演示数据**或空状态。当前文档里的截图均由隔离示例库采集。
