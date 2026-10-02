# 发布到 GitHub：完整步骤

本文档说明如何把 Rhine Music for Windows 发布到你自己的 GitHub 仓库。

> **AI Document 规范提醒**：本机 git 必须用
> `C:\Program Files\Git\cmd\git.exe`（系统级，凭据管理器会自行弹出浏览器授权）。
> **永远不要向用户索要密码或 Personal Access Token** —— 那套流程不需要。

---

## 0. 前置

| 项 | 要求 |
|---|---|
| git | `C:\Program Files\Git\cmd\git.exe`（已验证可用） |
| 浏览器授权 | 首次 push 时自动弹出，登录并授权即可 |
| 仓库 | 你自己的空仓库（不要勾选 README/.gitignore/LICENSE） |

---

## 1. 首次提交

```bash
cd "C:/AI Document/projects/rhine-music-windows"

# 用系统级 git
"C:/Program Files/Git/cmd/git.exe" add -A
"C:/Program Files/Git/cmd/git.exe" status --short | head -20   # 先看清要提交什么

"C:/Program Files/Git/cmd/git.exe" commit -m "feat: Windows 桌面发行版 v0.4.0

基于 RonaldDeng/Rhine-Music-Demo (MIT) 改造为 Electron 桌面应用。

- 跨平台改造：三平台端口探测、路径与文件管理器调用
- 音乐库导入：系统文件夹选择器 + 拖拽，递归扫描与去重
- GPU 加速：NVIDIA/AMD/Intel 检测与 CPU 回退
- Apple Music 风格动效，四维可调
- 工程规范：README/CONTRIBUTING/CI/Issue 与 PR 模板

保留 LBEILC 与 RonaldDeng 署名，详见 NOTICE.md"
```

**提交前先确认 `.gitignore` 生效**：

```bash
"C:/Program Files/Git/cmd/git.exe" status --short | grep -E "node_modules|dist-installer|/dist/" 
# 应无输出
```

---

## 2. 探测远端是否为空（**必做**）

**盲目 push 会覆盖已有内容**。

```bash
"C:/Program Files/Git/cmd/git.exe" remote -v                    # 若为空则跳过
"C:/Program Files/Git/cmd/git.exe" ls-remote https://github.com/<你的用户名>/rhine-music-windows.git
```

- **无输出** =远端为空，可直接推
- **有输出** = 远端已有内容，**先 fetch 再合并**，不要 force push

---

## 3. 连接你的仓库并推送

### 情况 A：远端为空（最常见）

```bash
cd "C:/AI Document/projects/rhine-music-windows"
"C:/Program Files/Git/cmd/git.exe" remote add origin https://github.com/<你的用户名>/rhine-music-windows.git
"C:/Program Files/Git/cmd/git.exe" branch -M main
"C:/Program Files/Git/cmd/git.exe" push -u origin main
```

### 情况 B：远端已有内容

```bash
"C:/Program Files/Git/cmd/git.exe" remote add origin https://github.com/<你的用户名>/rhine-music-windows.git
"C:/Program Files/Git/cmd/git.exe" fetch origin
"C:/Program Files/Git/cmd/git.exe" branch -M main

# 先看差异，确认没有冲突
"C:/Program Files/Git/cmd/git.exe" diff origin/main --stat

# 合并（保留双方历史）
"C:/Program Files/Git/cmd/git.exe" merge origin/main --allow-unrelated-histories
# 若有冲突，逐个解决后
"C:/Program Files/Git/cmd/git.exe" add -A
"C:/Program Files/Git/cmd/git.exe" commit
"C:/Program Files/Git/cmd/git.exe" push -u origin main
```

>远端若已有 LICENSE 或 README 且与本仓库冲突，
> **以本仓库为准**（它保留了上游的双重署名，删掉会造成署名丢失）。

---

## 4. 打标签并创建 Release

```bash
cd "C:/AI Document/projects/rhine-music-windows"
"C:/Program Files/Git/cmd/git.exe" tag -a v0.4.0 -m "Windows 桌面发行版 v0.4.0"
"C:/Program Files/Git/cmd/git.exe" push origin v0.4.0
```

然后在 GitHub 网页上创建 Release，或用 `gh`：

```bash
gh release create v0.4.0 dist-installer-v2/*.exe \
  --title "Rhine Music v0.4.0 (Windows)" \
  --notes-file RELEASE-NOTES-v0.4.0.md
```

---

## 5. 产物上传（**必读**）

> **单个文件 > 100 MB 无法 push 到 GitHub。** 构建产物**绝不提交进仓库**，
> 一律走 Releases 附件。

| 文件 | 大小（约） |
|---|---|
| `Rhine Music-0.4.0-x64.exe`（安装包） | 80–95 MB |
| `Rhine Music-0.4.0-portable.exe`（便携版） | 80–95 MB |
| `win-unpacked/Rhine Music.exe` | 180 MB+ |

> `win-unpacked/Rhine Music.exe` **不能单独分发** ——
> 它脱离同级目录跑不起来（缺 dll 与资源）。**不要**把它当成交付文件。

**正式归档位置**（AI Document 规范：分发包只保留`releases/` 一份）：

```bash
mkdir -p "C:/AI Document/releases/rhine-music-windows/v0.4.0"
cp dist-installer-v2/*.exe "C:/AI Document/releases/rhine-music-windows/v0.4.0/"
cp WINDOWS.md "C:/AI Document/releases/rhine-music-windows/v0.4.0/使用说明.md"
```

---

## 6. 清理构建中间产物

```bash
cd "C:/AI Document"
python cleanup.py                            # 先只扫描，报告可回收空间
python cleanup.py --clean --aggressive -y# 再清理
```

**注意**：
- `dist-installer-v*/win-unpacked/resources/app.asar` 会被进程长期持有句柄
  （错误码 32），**删不掉是本环境常态**，重启后再跑一次即可
- 按规范，`dist-installer*` 属构建产物，随时可重建，可放心清
- **未经用户明确同意，不要删除任何项目内容**

---

## 7. 完整检查清单

```bash
cd "C:/AI Document/projects/rhine-music-windows"

# 类型
"C:/Users/徐梓烽/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" node_modules/typescript/bin/tsc --noEmit

# 单元测试
"C:/Users/徐梓烽/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" --test electron/test/library-scanner.test.cjs

# 产物有效性（MZ 头）
head -c 2 "dist-installer-v2/Rhine Music-0.4.0-x64.exe" | xxd    # 应为 4d5a
```

- [ ] `tsc --noEmit` 0 error
- [ ] 单元测试 9/9 通过
- [ ] 两个 exe 都有 `MZ` 头
- [ ] `NOTICE.md` 保留 LBEILC + RonaldDeng + 本项目三份署名
- [ ] `LICENSE` 未被修改
- [ ] 仓库里没有 `node_modules`、`dist-installer*`、`dist/`
- [ ] Release 附件已上传

---

## 8. 常见问题

**push 时提示 `fatal: unable to access ... CRYPT_E_NO_REVOCATION_CHECK`**

本机 TLS 吊销检查被代理阻断：

```bash
"C:/Program Files/Git/cmd/git.exe" -c http.schannelCheckRevoke=false push
```

**push 时弹不出浏览器授权**

确认用的是系统级 git（`C:/Program Files/Git/cmd/git.exe`），
PortableGit 里的那个没有凭据管理器。

**Release 附件超过 2 GB 限制**

单个 Release 附件上限 2 GB。两个 exe 共约 180 MB，没问题。

**想改仓库名**

AI Document 规范要求「目录名 = GitHub 仓库名，逐字一致」。
改名要同时改目录名与远端地址，否则容易推错目标。
