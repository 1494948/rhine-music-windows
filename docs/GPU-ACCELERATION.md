# GPU 加速：作用范围、检测与回退

> 阶段 3 交付说明。对应需求 4：接入 NVIDIA GPU 支持（自动检测 + 优雅回退 CPU），明确作用范围，提供开关。

## 1. 作用范围（先说清「加速了什么」）

| 环节 | 是否走 GPU | 说明 |
|---|---|---|
| **Three.js 场景渲染** | ✅ 主要收益 | 3D 档案卡、专辑模型、玻璃材质、灯光与阴影。这是帧率瓶颈所在 |
| **音频解码** | ✅ 部分 | FLAC/AAC 等交给 Chromium 媒体进程；启用后走硬解（`--enable-accelerated-video-decode` 等） |
| **波形 / 频谱可视化** | ✅ | Canvas2D 合成与频谱 FFT 上传GPU |
| `music-metadata` 标签解析 | ❌ 纯 CPU | 瓶颈在磁盘 IO 与 JS 解析，GPU 帮不上 |
| 音乐文件读写 / HTTP 服务 | ❌ 纯 IO | Node fs 与 http，与 GPU 无关 |
| 曲库索引与去重 | ❌ 纯 CPU | 同上 |

> 一句话：**GPU 加速的是"看得见的部分"和"听得见的解码"，不是"读文件的 IO"。**
> 把 IO 归到 GPU 加速名下是不诚实的表述。

## 2. 检测流程

```
启动
  ├─ app.getGPUFeatureStatus()        → Chromium 侧能力（webgl 是否 enabled）
  ├─ nvidia-smi --query-gpu=name,driver_version
  │    └─ 命中 → vendor = 'nvidia'，记录驱动版本
  ├─ 隐藏窗口 + WEBGL_debug_renderer_info → 真实 GPU 名
  └─ classifyVendor(name) → nvidia / amd / intel / apple / software / unknown
```

判定为 `software`（SwiftShader/llvmpipe）时，`hardwareAccelerated` 为 `false`，
UI 会显示「当前使用软件渲染」并建议更新驱动 —— **这是回退成功的信号，不是错误**。

## 3. NVIDIA 专属开关

```js
'--force_high_performance_gpu'   // 优先独显（混合显卡笔记本上默认可能选核显）
'--disable-features=UseChromeOSDirectVideoDecoder'
```

通用高性能开关（所有厂商）：

```
--use-angle=default
--ignore-gpu-blocklist            // 忽略被 Chromium 拉黑的驱动
--enable-gpu-rasterization        // GPU 光栅化
--enable-zero-copy                // 零拷贝传输
--enable-accelerated-video-decode
--enable-features=CanvasOopRasterization
```

## 4. 优雅回退

用户可在设置里三档控制：

| 设置 | 行为 | 适用|
|---|---|---|
| 开启硬件加速（默认） | 用上面的高性能开关 | 有可用GPU |
| 关闭硬件加速 | `--disable-gpu --disable-gpu-compositing` | 驱动异常、屏幕撕裂、笔记本省电 |
| 强制 CPU 渲染 | 额外加 `--use-gl=swiftshader` | 完全不想让GPU 参与 |

检测到 `vendor === 'software'` 时自动切到软件光栅化路径。

**回退是可逆的、无副作用的**：不写注册表、不装驱动、不改系统设置。

## 5. 一个必须说清的约束

> **GPU 与端口设置在进程启动时生效，修改后需要重启应用。**

Chromium 的 `commandLine.appendSwitch()` 只在进程初始化阶段有效。
因此 `settings:set` 的返回值里带 `restartRequired: true`，UI 需明确提示用户。
这不是实现缺陷，是 Chromium 的机制。

## 6. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 检测显示 `software` | 驱动缺失/过旧，或远程桌面会话 | 更新显卡驱动；或用 `设置 → 关闭硬件加速` 明确关掉提示 |
| 笔记本有独显但走核显 | Windows 图形设置里选了节能模式 | Windows 设置 → 系统 → 显示 → 图形 → 改为高性能；本项目的 `--force_high_performance_gpu` 也会帮忙 |
| 3D 场景掉帧 | 渲染分辨率过高 | 设置页已有渲染质量（scale / pixelRatio / SMAA），降一档 |
| 音频解码报错 | 硬解格式不支持 | FLAC/WAV 本就 CPU 解码，不影响；MP3/AAC 才走硬解 |
| `nvidia-smi` 找不到 | 驱动未装或不在 PATH | 不影响检测，程序会退回 WebGL renderer 字符串 |

## 7. 验证方式

```bash
RHINE_SELFTEST=1 npx electron . --no-sandbox
```

日志中的 `gpu` 字段会给出 vendor / rendererName / driverVersion / hardwareAccelerated。
也可在应用内「设置 → 图形加速」区查看实时摘要。
