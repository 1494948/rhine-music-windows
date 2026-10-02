# 渲染层桌面增强

注入到上游页面里的桌面端增强代码。**纯增量**：Web 环境下全部自动跳过，
不影响上游原有行为。

| 文件 | 职责 |
|---|---|
| `motion.js` | 动效系统：四维设置、时长/缓动写入 CSS 变量、尊重系统偏好 |
| `motion.css` | 动效样式：窗口进场、视图切换、卡片瀑布、封面缩放 |
| `desktop-ui.js` | 导入 UI（添加按钮 + 目录列表）、动效设置项、GPU 设置项、拖拽导入 |
| `desktop-ui.css` | 上述 UI 的样式 |
| `fallback.html` | 音乐库服务未就绪时的降级页 |

## 接入方式

`src/main.ts` 已在切视图前完成初始化；`src/music-app.ts` 在两个面板渲染处挂载 UI。
新增能力只需在 `desktop-ui.js` 里加函数，再从上游面板调用 `DesktopUI.xxx()`。

## UI 陷阱清单

这六条都在真实项目里造成过「界面完全不可用」，改CSS 前逐条自查。

### 1. `[hidden]` 被类选择器覆盖 → 全屏遮罩永久遮挡

```css
.modal-wrap { position: fixed; inset: 0; display: flex; }  /* 特异性 0,1,0 */
```
```html
<div class="modal-wrap" hidden></div>
```

`[hidden]` 与 `.modal-wrap` 特异性相同，作者样式表在 UA 之后解析，
`display: flex` 胜出，`hidden` 完全失效 —— 遮罩从启动起吞掉所有点击。

**修复**：样式表最前面加 `[hidden] { display: none !important; }`。

### 2. 全屏遮罩上的 `backdrop-filter` 会把整个应用糊掉

一旦遮罩常驻显示，模糊会作用于**整个窗口**，表现为"程序画面模糊不清"，
且极易被误判成 DPI 或显卡问题。无GPU 环境下开销极大，甚至渲染进程被杀。

**结论**：遮罩只用纯色半透明背景。全屏 blur 一律不做；
确需模糊只用在尺寸受限的元素上。

### 3. `<label>` 默认 `display: inline`，宽高无效

```css
.switch { position: relative; width: 44px; height: 26px; }  /* 会塌缩成 0×0 */
```

`<label>` 是 inline 元素，宽高对它无效；子元素又绝对定位，
于是开关塌缩为 0×0，**界面上完全看不见**（但程序化 click 仍触发，测试不会报错）。

**修复**：`.switch { display: inline-block }`（`desktop-ui.css` 已处理）。

### 4. 浮层默认拦截点击

`position: fixed` 的提示条/浮层会挡住下方按钮。纯信息展示的浮层必须
`pointer-events: none`；若其中有可交互元素，则容器 none、具体元素 auto。

### 5. 叠层文字二选一

SVG 内画了文字，外层又绝对定位叠了 HTML 文字层 → 重叠成`58%58%`。

**二选一**：文字全放 SVG，或全放 HTML 覆盖层。

**且**：可选参数的默认值必须用 `null` / `''` 表示"不画"，
不要用 `||` 兜底成另一种内容：

```js
// 错的：调用方不传label，调用方明明删了 label，圆环里还是画了百分比
o.label || (pct + '%')
// 对的
o.label ?? null
```

### 6. 异步回调重绘前校验用户还在不在这个页面

联网查询/评分是异步的。回调里无条件重绘，用户已切页时会把旧内容画到当前页。
**控制台 0 错误，只有看图才发现。**

```js
// app.js 的 go() 里记录当前视图
C().ui.view = view
// 视图内部的异步回调统一走包装
function renderPractice(host) {
  if (Core.ui.view !== 'practice') return
  practice.render(host)
}
```

---

## 动效与无障碍

- 时长/缓动全部走 CSS 变量，关闭动效时变量为 `0ms`，
  **transition 依然声明但瞬时完成** —— 不破坏依赖 `transitionend` 的逻辑
- 监听 `prefers-reduced-motion`。系统要求减弱动效时**覆盖用户开关**，
  这是无障碍底线，不给绕过入口
- 关闭动效只清`animation`/`transition`/`transform`，
  **不改 `display` 与尺寸** —— 布局完全一致，只是不动
- 卡片瀑布入场延迟限幅在 110ms：500 张卡片线性延迟会让最后一张等 14 秒
