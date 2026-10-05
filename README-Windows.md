# Rhine Music 路 Windows 版

把本地音乐放进三维专辑架。本包是 [RonaldDeng/Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo) v0.3.0 的 Windows 构建，提供 **EXE 启动器** 与 **原生 Win32 窗口**（WebView2）。

## 系统要求

- Windows 10 / 11（x64）
- 支持 WebGL 2 的显卡驱动
- Microsoft Edge WebView2 运行时（Windows 11 通常已自带；若启动失败请安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)）
- 本包已内置 Node.js 与 libmpv 播放内核，无需另行安装

## 三步开始

1. 将整个文件夹解压到固定位置（路径尽量不含异常权限限制）。
2. 双击 **`RhineMusic.exe`**。首次启动会打开原生窗口并加载三维专辑架。
3. 点击「音乐库」，填写本机音乐文件夹的**绝对路径**（例如 `D:\Music`），保存并扫描。

尚未准备音乐时，可点「先查看演示封面」体验界面。

## 组件说明

| 文件 | 作用 |
| --- | --- |
| `RhineMusic.exe` | 原生 Win32 窗口启动器（WebView2），自动拉起本地音乐服务与播放内核 |
| `libmpv-2.dll` | 原生音频解码（DSF/DFF/FLAC/WAV/MP3 等），WASAPI 输出 |
| `启动音乐播放器.bat` | 命令行备用启动方式，默认用系统浏览器打开 |
| `app/` | 播放器源码、已构建界面与本地音乐服务 |
| `runtime/` | 内置 Node.js 运行时 |
| `../music-data-v3/` | 默认数据目录（配置、索引、封面缓存、日志），位于本包父目录 |

## 播放内核

- **歌曲 / 氛围 BGM / 界面音效** 全部走 libmpv（不再使用 HTML5 Audio）。
- 默认 **WASAPI 共享** 模式：可与系统其他声音共存。
- 可选 **WASAPI 独占**（USB DAC 比特完美）：设置界面开启「独占输出」。独占时界面 BGM/音效会自动让出设备，停止播放后恢复。
- 支持 DSD（DSF/DFF）与主流无损/有损格式；DFF 会正确显示采样率、位深、码率与时长。
- 设置中有「诊断播放内核」，可查看当前是否走原生通道。

## 常用操作

| 操作 | 功能 |
| --- | --- |
| `←` / `→` | 切换分类 |
| `↑` / `↓` | 切换专辑；详情中换片 |
| `Enter` | 打开专辑 / 跳过进场 |
| `Space` | 播放／暂停 |
| `/` | 搜索 |
| `Esc` | 关闭弹窗 / 返回 |
| 拖动 CD 盘 | 旋转查看 |

## 数据与路径

- 默认数据目录：`<本包父目录>\music-data-v3\`
- 可用环境变量 `MUSIC_DATA_DIR` 覆盖
- 歌曲始终从原路径读取，不复制、不改写标签
- 服务仅监听 `127.0.0.1`

## 故障排查

**双击没有窗口？** 先安装 WebView2 Runtime，再试 `启动音乐播放器.bat`。

**找不到 Node？** 确认 `runtime\node.exe` 存在；也可设置环境变量 `RHINE_NODE` 指向本机 `node.exe`。

**端口被占用？** 启动器会从 5175 起顺延选择空闲端口；日志在 `music-data-v3\player-service.log`。

**界面仍很卡？** 在设置中降低画质或关闭景深。

**听不到声音？**

1. 默认已是 WASAPI **共享**，板载声卡可与界面音效 / 氛围 BGM 共存。
2. USB DAC 比特完美可在设置中开启独占；或设 `RHINE_AUDIO_EXCLUSIVE=1` 后启动。
3. 先看设置里的 **BGM 音量 / 音效音量**（默认约 45%/55%），过低会听不见。
4. 诊断日志：`music-data-v3\mpv-config\mpv-playback.log`，看 `bgm-state` / `sfx-state` 是否 `current-ao=wasapi`。
5. 可运行 `RhineMusic.exe --diag-audio` 做无界面自检（会实际出声）。
6. 若仍无声，把日志里 `bgm-state` / `sfx-state` 与 `path= | ao-null= | current-ao=` 相关行发来。

**DFF 显示「未知」？** 索引元数据已升级（v3），请在音乐库中**重新扫描**一次。

## 版权

- 音乐适配与后续修改：Copyright (c) 2026 RonaldDeng
- 上游 RhineLabUI：Copyright (c) 2026 LBEILC
- 代码许可：MIT（详见 `app/` 内 LICENSE 与 NOTICE.md）
- 本 Windows 打包仅为运行移植，不改变上游署名与许可边界
