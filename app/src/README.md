# `app/src` 区域导览

源码按**功能区域**分目录，而不是按文件类型。目的只有一个：改一个功能时，
你要动的文件应该都躺在同一个目录里。

```
src/
├─ main.ts            3D 场景入口（主窗口）
├─ archive-main.ts    3D 场景入口（档案窗口）
├─ music-app.ts       音乐应用外壳：路由、事件分发、面板装配
├─ vite-env.d.ts      Vite 类型声明
│
├─ core/              与音乐业务无关的通用底座
├─ boot/              启动动画
├─ shelf/             唱片架三维场景：相机、灯光、模型、取景框、封面图集
├─ viewer/            模型查看器：离屏渲染、景深、锐化、玻璃揭示
├─ player/            播放内核：音频、原生 libmpv 通道、接歌过渡、播放顺序
└─ lyrics/            歌词：时间轴模型、面板组件、设置面板
```

## 各区域职责

### `core/` — 通用底座
不依赖任何音乐概念的模块。给其他区域共用。

| 关注点 | 文件 |
| --- | --- |
| 排版与外观 | `style.css`、`appearance.ts`、`responsive.css` |
| 页面切换动效 | `motion.ts`、`theme-transition.ts`、`ui-transitions.ts` |
| 渲染质量 | `render-quality.ts`、`quality-settings.ts/.css` |
| 内容解密 | `decryption.ts/.css`、`document-decryption.ts/.css` |
| 小工具 | `html.ts`、`asset-url.ts`、`brand.ts`、`data.ts` |
| 打字机节奏 | `typing-rhythm.ts`、`typing-samples.ts` |

改**全局样式、动效曲线、解密流程**来这里。这些模块不该知道「专辑」是什么。

### `boot/` — 启动动画
品牌 Logo 出现到主界面接管之间发生的一切：轨道飞行、时序编排。

改**开屏动画时长/轨迹**来这里。`boot.ts` 是总入口，`music-boot-timing.ts` 是节拍表。

### `shelf/` — 唱片架（本项目最大的区域）
三维唱片架场景：从专辑排布、相机运镜，到取景框、标题卷轴、灯光实验台。

| 关注点 | 文件 |
| --- | --- |
| 场景与模型 | `scene.ts`、`music-model.ts`、`music-track-focus.ts`、`cover-atlas.ts` |
| 相机与导航 | `music-camera.ts`、`music-wheel-navigation.ts`、`music-navigation-*` |
| 排布 | `music-array-layout.ts`、`music-real-columns.ts`、`music-ruler.ts`、`music-ticks.ts` |
| 灯光 | `music-lighting.ts`、`music-lighting-lab.ts`、`music-row-lighting.ts` |
| 动效 | `music-motion-lab.ts`、`music-motion-settings.ts`、`music-motion-ui.ts`、`music-text-motion.ts` |
| 档案与搜索 | `music-archive.ts/.css`、`music-search.ts`、`music-overview*.ts` |
| 标题与过渡 | `music-title.ts`、`music-title-reels.ts`、`music-transport-title.ts`、`music-presentation.ts` |
| 主题 | `music-theme.css`、`music-theme-switch.css`、`music.css` |

改**唱片架长什么样、相机怎么走、灯光什么色**来这里。这是维护最频繁的区域。

### `viewer/` — 模型查看器
把 3D 模型渲染成可检视的画面：离屏渲染、景深、锐化、玻璃揭示、查看覆盖层。

改**专辑封面放大后的渲染管线**来这里。与 `shelf/` 的区别：`shelf/` 管「东西在哪」，
`viewer/` 管「东西怎么被画出来」。

### `player/` — 播放内核
从音频解码到「下一首放什么」。

| 关注点 | 文件 |
| --- | --- |
| 音频输出 | `audio.ts`、`audio-settings.ts` |
| 原生通道 | `native-playback.ts`（WebView2 / libmpv 桥） |
| 播放控制 | `music-player.ts`（状态机、事件订阅、接歌） |
| 过渡 | `music-song-transition.ts`、`music-browser-gapless.ts` |
| 顺序 | `music-order.ts` |

改**播放行为**来这里。注意 `native-playback.ts` 的宿主是**异步注入**的——
订阅必须早于宿主就位（见该文件顶部注释与 `check-music-player-native.mjs`）。

### `lyrics/` — 歌词
| 关注点 | 文件 |
| --- | --- |
| 时间轴模型 | `music-lyrics.ts` |
| 面板组件 | `music-lyrics-pane.ts`、`music-lyrics-switch.css` |
| 设置 | `lyrics-settings.ts/.css` |

改**歌词解析、显示、配色**来这里。`music-lyrics-pane.ts` 的
`setTrack()` 必须装载**传进来的那首**，不能回头再从 `options.current()` 推导
（见 `check-music-lyrics-pane.mjs`）。

## 区域之间的依赖方向

```
core  ←  boot / shelf / viewer / player / lyrics / music-app.ts
boot  →  （无出向依赖，只被 music-app.ts 调用）
shelf ↔  viewer     （共享相机与场景对象）
shelf →  player     （取当前曲目做高亮）
player → lyrics     （播放进度驱动歌词滚动）
```

规则：**箭头只能从下往上指**。`core/` 不认识其他任何人；`lyrics/` 不认识 `shelf/`。
要跨界，走 `music-app.ts` 这个外壳做中介。

## 加新文件时放哪

1. 它认识「专辑」「唱片架」「相机」吗？→ `shelf/`
2. 它认识「音频」「下一首」吗？→ `player/`
3. 它认识「歌词」「时间轴」吗？→ `lyrics/`
4. 它只跟渲染管线有关？→ `viewer/`
5. 它只在启动阶段存在？→ `boot/`
6. 以上都不是，谁都能用？→ `core/`

文件名沿用现有前缀习惯：唱片架用 `music-`，歌词用 `lyrics-`，查看器用 `viewer-`，
启动用 `boot-`。样式表与它服务的模块同目录同名。

## 改完必须跑什么

```bash
# 在 app/ 下
node --experimental-strip-types scripts/check-music-lyrics-pane.mjs
node --test --experimental-strip-types scripts/check-music-player.mjs
npx tsc --noEmit
```

完整 16 项检查（含构建）在 `playground/rhine-perf/run-checks.mjs`。
新增跨文件契约时，检查脚本的 `read()` 走 `AREA` 映射表解析路径——
文件挪了目录，记得同步那张表。
