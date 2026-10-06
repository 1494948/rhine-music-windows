# Rhine Music · 第三方二次修改版（本地改造分支）

> ⚠️ **这是第三方衍生作品，非官方版本。**
> 代码改编自 [RonaldDeng/Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo)（MIT），
> 后者基于 [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)。
> 原作者**未参与、未认可、也不为本版本提供任何支持**。与本项目相关的署名、
> 许可边界与非代码资产权利，全部见 [NOTICE.md](NOTICE.md)。

本分支（`rhine-music-local-mod`）在 Windows 打包版 `v0.3.0` 之上做界面、性能与数据源改造，
面向本地曲库的日常使用。源码位于仓库根，界面代码在 `app/`。

## 这一支做了什么

| 方向 | 内容 |
|---|---|
| **专辑切换性能** | 文件头测尺寸 + 单次解码到位；两级字节预算缩略图缓存（常驻 402 MB → 88 MB）；快照面与标签面复用池；空闲预取；详情解码单飞。跨列切换卡顿消除 |
| **歌词动效** | 逐字独立变换、行进入/退出分层衰减、接手过冲、间奏律动点、高亮行放大。设计思路**参考** [AMLL](https://github.com/Steve-xmh/applemusic-like-lyrics)（MIT，未复制其代码） |
| **歌词参数模块** | 字号/行距/颜色/渐变/浮动/延迟等 20 项，四组分类、逐项与分组复位、三套预设、JSON 导入导出、可选歌选行预览并跟随播放 |
| **专辑资料数据源** | 只用**国内可正常访问**的公开来源：QQ 音乐 / 网易云音乐 / 百度百科 / MusicBrainz，Apple Music 商店 + Discogs + Wikidata 作为末位兜底。逐条标注出处并缓存在本机 30 天 |
| **专辑档案面板** | 四级来源：人工补录 → 线上补录 → 本地已核对简介 → 本地数据推导。面板明确标出内容来自哪一层 |

真实曲库实测：**78 张可匹配专辑命中 60 张（76.9%）**，来源贡献 QQ 音乐 48 / MusicBrainz 35 /
百度百科 25 / 网易云音乐 19 / Discogs 1。

## 运行要求

- Windows 10/11 + **Microsoft Edge WebView2 运行时**（缺失时启动器会提示安装）
- 分发包内含 `RhineMusic.exe`（原生窗口，不需要浏览器）、`libmpv-2.dll`、自带 Node 运行时
- 源码构建需要 **Node.js ≥ 22.12**（见 `app/package.json` 的 `engines`）

多数专辑的封面、歌词与介绍取自**本机音乐文件自身的内嵌标签与同名 `.lrc` 文件**；
线上层是补充，不是必需。

## 构建（源码）

`package.json` 在 `app/` 子目录，**所有 npm 命令必须先进入 `app/`**：

```bash
cd app
npm install
npx tsc --noEmit      # 类型检查
npx vite build        # 只构建界面，不改动受版本管理的内容文件

npm run music         # 本地音乐服务（另一个终端）
npm run dev           # 开发态界面
npm run check:music   # 一揽子自检（曲库/歌词/线上层/动效/相机/灯光/模型等 14 项）
```

## 放包说明

分发包体积较大（约 515 MB，含运行时与音频内核），**不进 git**，作为 GitHub Release 附件提供。
仓库 `.gitignore` 已排除 `node_modules/`、`dist/`、`runtime/`、`*.exe`、`*.dll` 与 `music-data-v3/`。

`PROJECT.md` 是本项目的开发工作卡（环境事实、构建与打包命令、已知的坑、变更记录）。

## 许可

有权授权的程序代码、建模脚本与技术文档沿用 [MIT](LICENSE)，保留 RonaldDeng 与 LBEILC 两处署名。
**代码的许可不覆盖非代码资产**——3D 模型、字体、以及源自原作 PV 的音频采样等，
其权利归相应权利人所有，不以 MIT 再授权。完整边界与免责见 [NOTICE.md](NOTICE.md)。

真实歌曲、商业专辑封面、私人曲库索引与缓存**不随本仓库及发布包分发**。
