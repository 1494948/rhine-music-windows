# 动效系统：Apple Music 风格与设置项

> 阶段 4 交付说明。对应需求 2：视觉与动效向 Apple Music 靠拢，并新增动效设置项。

## 1. 设计取向

Apple Music 的动效特征是「**快起慢收、有落位感、不过度**」：
一次视图切换约 250–300ms，进场用减速曲线，出场用加速曲线，
元素位移幅度小（8–16px），封面缩放带回弹。

本项目照此实现，但**所有动效都可关闭、可调速、可降级**——
无障碍与低端机用户不该被迫吃满特效。

## 2. 四个可调维度

对应设置页「动效」区的四组控件：

| 维度 | 选项 | 默认 |
|---|---|---|
| **动画开关** | 开 / 关 | 开 |
| **时长** | 无(0ms) / 快速(140) / 标准(260) / 缓慢(420) | 标准 |
| **缓动曲线** | 标准 Apple / 强调 / 进场减速 / 线性 | 标准 Apple |
| **性能模式** | 完整效果 / 平衡 / 优先帧率 | 平衡 |

### 缓动曲线对照

| 名称 | 曲线 | 用途 |
|---|---|---|
| 标准（Apple） | `cubic-bezier(0.25, 0.1, 0.25, 1)` | 通用 |
| 强调 | `cubic-bezier(0.2, 0, 0, 1)` | 封面缩放、面板弹出、按压回弹 |
| 进场减速 | `cubic-bezier(0.05, 0.7, 0.1, 1)` | 视图切换、卡片入场 |
| 线性 | `linear` | 需要匀速的进度类动画 |

## 3. 性能影响（设置页直接展示这张表）

| 项目 | 完整 | 平衡 | 优先帧率 | 说明 |
|---|---|---|---|---|
| 窗口进场动画 | ✅ | ✅ | ✅ |一次性，代价可忽略 |
| 视图切换淡入 | ✅ | ✅ | ✅ | 单容器合成层|
| 卡片 hover 抬升 | ✅ | ✅ | 简化 | 降级为 2px 位移，去掉 box-shadow |
| 封面缩放 | ✅ | ✅ | ✅ | 合成层transform，GPU 友好 |
| 毛玻璃 `backdrop-filter` | ✅ | ✅ | ❌ | **最贵的一项**：大元素上会额外创建合成层 |
| 粒子/装饰动画 | ✅ | ❌ | ❌ | 逐帧重绘，帧率杀手 |

> **「优先帧率」模式会关闭毛玻璃**，这是 Windows 上收益最明显的一档。
> 上游界面大量使用 `backdrop-filter`，在集显笔记本上容易掉到 30fps 以下。

## 4. 实现要点

### 4.1 全部时长走 CSS 变量

`motion.js` 在运行时写入：

```js
--motion-duration / --motion-duration-fast / --motion-duration-slow
--motion-ease / --motion-ease-emphasized / --motion-ease-enter
```

好处：关掉动效只需把变量设为 `0ms`，**所有 transition 依然声明但瞬时完成**，
不会破坏任何依赖 `transitionend` / `animationend` 的逻辑。

### 4.2 尊重系统偏好

监听 `prefers-reduced-motion: reduce`（Windows 辅助功能 → 视觉效果里有此项）。
系统要求减弱动效时，**用户自己的开关会被覆盖**（`motion.active === false`）。
这是无障碍底线，不给用户绕过的入口。

### 4.3 关闭动效不破坏布局

`html[data-motion="off"]` 下清空 `animation` / `transition` / `transform`，
但**不改变 `display` 或尺寸**——界面结构完全一致，只是不动。

### 4.4 卡片瀑布入场

`nth-child(1..4)` 递增延迟 28ms，之后统一 110ms。
限幅的原因：500 张卡片若线性延迟，最后一张要等 14 秒 —— 不可接受。

## 5. 动效清单

| 场景 | 效果 | 时长档 |
|---|---|---|
| 应用启动 | 轻微放大淡入（0.985→1） | slow |
| 视图切换 | 交叉淡入 + 10px 上移 | normal |
| 卡片网格入场 | 淡入 + 14px 上移 + 0.97→1 缩放，逐个延迟 | slow |
| 卡片 hover | 抬升 4px + 放大 1.02 | normal |
| 卡片按压 | 缩小 0.975 | fast |
| 封面缩放 | 弹性放大 1.12 | slow |
| 播放列表切换 | 横向 8px 位移淡入 | normal |
| 面板/弹层 | 16px 上滑 + 0.98→1 | normal |
| 开关切换 | 缩放脉冲 1→1.12→1 | normal |
| 加载指示 | 三点循环脉冲 | 1.1s 无限 |

## 6. 接入方式

渲染层（已在 Electron preload 暴露 `window.rhine`）：

```js
import { motion } from './motion.js'

// 1. 启动时应用持久化的设置
const settings = await window.rhine.settings.get()
motion.apply(settings.motion)

// 2. 跟随主进程广播（设置页改动即时生效，无需重启）
window.rhine.onMotionChanged((next) => motion.apply(next))

// 3. 使用
motion.transitionSwap(container, () => renderNextView())
motion.zoomCover(coverEl)
motion.play(el, 'pulse')
```

## 7. 验证方式

- [ ] 设置页改时长，界面动效**立即**变化，无需重启
- [ ] 关掉动画开关，所有元素静止但布局正常
- [ ] 切「优先帧率」，毛玻璃消失、hover 变简版
- [ ] Windows 开启「减弱动画」后，动效被系统自动关闭
- [ ] 连点同一张卡片，动画能重新触发（`motion.play` 里有强制重排）
