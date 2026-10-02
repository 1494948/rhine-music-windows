# 版权、署名与资源来源

本说明区分代码授权、音乐适配的开发者署名和第三方素材的权利。公开源码不表示放弃版权，也不表示获得全部原作素材的再授权。

## 开发者与上游

| 范围 | 署名与来源 |
| --- | --- |
| 音乐播放器适配及后续修改 | **Copyright (c) 2026 RonaldDeng**。包括本地曲库与播放服务、音乐专辑模型适配、音乐界面、导航、相机交互、文字效果、响应式及版本维护中由本项目新增或修改的部分；不主张对未修改的上游代码或第三方素材享有原创权利。 |
| 原版 RhineLabUI | **Copyright (c) 2026 LBEILC**。[原仓库](https://github.com/LBEILC/RhineLabUI)，初始基于提交 [`5abab02367465d9189f4ae65bcb6f17fdb5938f7`](https://github.com/LBEILC/RhineLabUI/tree/5abab02367465d9189f4ae65bcb6f17fdb5938f7)。保留其三维档案界面、渲染与动效基础、建模脚本、资料说明和 Git 历史。 |

有权授权的程序代码、建模脚本和技术文档沿用 [MIT License](LICENSE)，保留以上两项署名。分发代码或其重要部分时须一并保留版权声明及完整许可证；适配者的署名不取代上游署名。MIT 允许使用、修改及商业分发，软件按原样提供；本说明不在 MIT 上另加用途限制。具体以许可证原文为准，参见 [MIT 许可说明](https://choosealicense.com/licenses/mit/)。

[README.original.md](README.original.md) 保留上游原说明，其中“本项目”“原创”等措辞归属于该上游文档的语境。RonaldDeng 不代表 LBEILC，音乐适配不表示上游作者参与、认可或为本衍生版本提供支持。

## 原作及非代码资产

视觉参考为《明日方舟》特别映像[「莱茵生命：访问」](https://www.bilibili.com/video/BV1rr4y1b7sz/)。相关作品、名称、标志、设定、视觉设计、原 PV 及其声音的权利归相应权利人所有。本项目是独立爱好者工程，与官方制作方无隶属、赞助或授权合作关系，不主张拥有原作版权或商标。

- `art/*.blend`、`public/assets/*.glb`、界面图标、截图、动图及原作相关演示文本**不因代码采用 MIT 而自动获得原作素材许可**。上游未另行将全部非代码资产声明为 MIT；建模脚本的 MIT 授权也不等于原作相关视觉元素可任意再分发。
- `public/audio/atmosphere.ogg`、`motif.ogg`、`pulse.ogg` 和 `observatory-preview.mp3` 为继承自上游的程序编配，按其[音频说明](public/audio/README.md)随项目采用 LICENSE；不将其重新署名为音乐适配者原创。
- `public/audio/typing-preview.wav` 与 `src/typing-samples.ts` 的三个 38ms 短音来自上述原 PV，来源、时间码及处理记录见 [typing-source.json](public/audio/typing-source.json)。**这些采样不属于 MIT 授权范围；来源标注不是原权利人的再分发许可。** 本项目不能为复用者授予相应权利。仅用于本地比对的 `reference/typing-original.wav` 不随本次源码快照和 ZIP 分发；旧 Git 历史未重写。
- [演示封面](public/demo-covers/README.md)是本项目早期音乐适配阶段生成的三张抽象图像，当前文档用它们演示界面，不冒充真实唱片或音乐库。V0.2.0 历史截图由该版本运行画面采集，V0.3.0 界面回归截图使用隔离示例库采集；截图不改变其中字体、模型与原作元素各自的权利。
- 真实歌曲、商业专辑封面、私人曲库索引、缓存和在线介绍不随本仓库及发布包分发。

代码复用者可替换这些资产；使用或再分发涉及第三方权利的内容时，需另行遵守对应许可或取得必要授权。本文件不作“全部资源已获商业授权”的保证。

## 字体与直接依赖

| 组件 | 权利人与许可 | 随包文本 |
| --- | --- | --- |
| MiSans | 小米／Beijing Xiaomi Mobile Software Co., Ltd.，按 MiSans 字体协议随应用原样嵌入；不是 MIT，不将字体作为独立商品或字体包发布 | [署名](public/fonts/NOTICE.txt)、[完整字体协议](public/fonts/MiSans-license.pdf) |
| Three.js | three.js authors，MIT | [three.txt](public/licenses/three.txt) |
| Rolling Number | Kit Langton，MIT | [rolling-number.txt](public/licenses/rolling-number.txt) |
| music-metadata | Borewit，MIT | [music-metadata.txt](public/licenses/music-metadata.txt) |
| OpenCC-JS | nk2028，MIT；所用 OpenCC 字典数据另受 Apache-2.0 约束 | [MIT](public/licenses/opencc-js.txt)、[第三方说明](public/licenses/opencc-js-third-party.md)、[Apache-2.0](public/licenses/apache-2.0.txt) |

这些文本保留依赖包原文。完整版本树见 `package-lock.json`；其他构建工具和间接依赖按安装包各自的 LICENSE / NOTICE 使用，不被本项目重新授权。

## 在线资料

Wikipedia 摘要、Wikidata 与 MusicBrainz 数据按其来源许可处理。客户端保存介绍时同时保存来源链接、取得时间和许可说明；此类用户自行查询的缓存不纳入项目 MIT 授权，也不进入发布包。MusicBrainz 将核心数据和补充数据分别授权，详见[官方数据许可](https://musicbrainz.org/doc/About/Data_License)；不能仅因为程序开源就统一将数据改授 MIT。

如发现署名遗漏或具体权利问题，请通过本仓库 [Issues](https://github.com/RonaldDeng/Rhine-Music-Demo/issues) 提供涉及文件、来源及说明，维护者可据此核对。

---

## Windows 桌面发行版（Rhine Music Windows）

| 范围 | 署名与来源 |
| --- | --- |
| Windows 桌面发行版改造 | **Copyright (c) 2026 Rhine Music Windows contributors**。包括 Electron 桌面壳层、跨平台改造（端口探测、路径、浏览器/文件管理器调用）、系统文件夹选择器与拖拽导入、GPU 检测与回退、动效系统、构建与发布流程。**不主张对未修改的上游代码或第三方素材享有原创权利。** |
| 上游音乐适配 | **Copyright (c) 2026 RonaldDeng**。见本文件上文「开发者与上游」一节。 |
| 原版 RhineLabUI | **Copyright (c) 2026 LBEILC**。见本文件上文「开发者与上游」一节。 |

### 独立衍生作品声明

本 Windows 桌面发行版是**第三方独立衍生作品**：

- 与 RonaldDeng / LBEILC **无隶属、赞助、合作或背书关系**。
  上游作者未参与本版本的开发、未审阅、未认可，也不为本版本提供技术支持。
- 本版本以 [MIT License](LICENSE) 发布。依据 MIT 授予的权利
  （使用、复制、修改、合并、发布、分发、再许可），**无需另行取得上游许可**；
  对应的义务是**保留版权声明与许可原文**，本仓库已完整保留。
- 本节署名**追加**而不**取代**上述上游署名。上游的版权声明与 NOTICE 说明
  在本仓库中原样保留，未被修改或替换。
- 上游问题请提给[上游仓库](https://github.com/RonaldDeng/Rhine-Music-Demo/issues)；
  本版本引入的问题（Electron 壳层、导入、GPU、动效、打包）请提给本仓库。

### 非代码资产的再分发边界（重要）

上游 NOTICE 已明确声明：**代码采用 MIT 不代表其非代码资产也获得 MIT 授权**。
本仓库沿用上游在该问题上的既有实践（公开分发并保留完整声明），
但**不主张比上游更多的权利**，也不能为复用者授予上游未授予的权利：

| 资产 | 状态 |
| --- | --- |
| `public/assets/*.glb` | 运行时必需，随上游公开分发；权利状态与上游一致 |
| `public/audio/*.ogg`、`observatory-preview.mp3` | 继承自上游的程序编配，按上游音频说明随项目采用 LICENSE |
| `public/audio/typing-preview.wav`、`src/typing-samples.ts` | **上游明确声明不属于 MIT 授权范围**（源自第三方影像作品）。本仓库同样不主张任何权利 |
| 视觉参考（原作设定、名称、标志） | 权利归相应权利人所有；本仓库与官方无关联 |
| `art/*.blend`、`docs/media/` | **不进入本仓库与发布包** |

如任一权利人认为本仓库的某项分发不妥，请通过本仓库 Issues 指出，
维护者将及时移除或调整。

### 本仓库新增的第三方依赖

| 组件 | 权利人| 许可 |
| --- | --- | --- |
| Electron | OpenJS Foundation 与 Electron contributors | MIT |
| electron-builder | electron-userland | MIT |
| cross-env | Andrey Sitnik | MIT |
| Vite | Evan You与 Vite contributors | MIT |
| TypeScript | Microsoft | Apache-2.0 |

上游原有的 Three.js、music-metadata、OpenCC-JS、Rolling Number、MiSans 字体
等依赖与许可**保持不变**，见本文件上文「字体与直接依赖」一节及
`public/licenses/` 下的原文。

### 构建产物

- 安装包与便携版以 **未签名** 形式分发（无代码签名证书）。
- 打包的 `public/assets/*.glb` 因运行时需要而随包分发，
  其权利状态与上游一致，**不因打包行为获得新的授权**。
- 构建过程**不包含** `art/*.blend`（Blender 工程）与 `docs/media/`（演示截图动图）。
- 真实歌曲、商业专辑封面、私人曲库索引与缓存**不随仓库或发布包分发**。
