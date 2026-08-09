# V1 Standalone Harness Archive

TreeDiagram 原“树形界面主导、内置模型与固定 Workflow 控制器”的完整实现已于 2026-08-09 归档。

- Git tag：`archive/v1-harness-baseline-2026-08-09`
- 最后提交：`771d20f fix(workflows): make readiness retry idempotent`
- 归档范围：该提交中的全部代码、设计文档、测试和工作区格式
- 新方向：[DESIGN_V2.md](./DESIGN_V2.md)

归档采用 Git 不可变引用，而不是删除或压缩源文件。需要检查或运行旧版本时：

```bash
git switch --detach archive/v1-harness-baseline-2026-08-09
```

需要基于旧版本建立修复分支时：

```bash
git switch -c codex/v1-maintenance archive/v1-harness-baseline-2026-08-09
```

V2 分支暂时保留旧源文件作为迁移资产；在 MCP、Attention Context 和新树 UI 建立替代能力前，
不进行不可恢复的批量删除。
