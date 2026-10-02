name: Pull Request
description: 提交代码改动
labels: [pr]
body:
  - type: markdown
    attributes:
      value: |
        提交前请跑一遍：`npm run typecheck` 与 `npm run check:scanner`。

  - type: textarea
    id: what
    attributes:
      label: 改了什么
      description: 用一句话说清核心改动
    validations:
      required: true

  - type: textarea
    id: why
    attributes:
      label: 为什么这么改
      description: 背景、动机、参考的 Issue
    validations:
      required: true

  - type: textarea
    id: how-verified
    attributes:
      label: 怎么验证的
      description: 实际执行了哪些命令、看到什么结果。截图或录屏更好（动效/GPU 问题）
      placeholder: |
        - npm run typecheck → 0 error
        - npm run check:scanner → 9/9 通过
        - RHINE_SELFTEST=1 npx electron . → 2 pass / 0 fail
    validations:
      required: true

  - type: dropdown
    id: area
    attributes:
      label: 改动区域
      options:
        - electron/main（主进程）
        - electron/preload（桥接）
        - electron/renderer（动效 / 导入 UI / GPU 设置）
        - src（上游 TypeScript）
        - scripts（上游 Node 脚本）
        - 构建与依赖
        - 仅文档
    validations:
      required: true

  - type: checkboxes
    id: checks
    attributes:
      label: 自查
      options:
        - label: 改动尽量放在 electron/ 内，没有大面积侵入上游 src/
        - label: 若改了上游文件，已加注释块说明原因并关联文档
        - label: 类型检查与单元测试通过
        - label: 动效关闭时界面布局不变
        - label: 渲染层改动已核对 UI 陷阱清单（见 CONTRIBUTING.md）
        - label: 主进程改动：错误有回传渲染层，不是只打日志
        - label: 没有提交音乐文件、封面或私人数据
