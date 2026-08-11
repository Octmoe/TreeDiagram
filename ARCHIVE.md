# 前代版本归档

TreeDiagram 的 standalone Agent Harness 已从活跃源码树移除，完整代码、规格、测试与工作区格式保存在不可变 Git 标签：

```text
archive/v1-harness-baseline-2026-08-09
```

最后提交为 `771d20f fix(workflows): make readiness retry idempotent`。

只读检查或运行前代版本：

```bash
git switch --detach archive/v1-harness-baseline-2026-08-09
```

需要维护分支：

```bash
git switch -c codex/legacy-maintenance archive/v1-harness-baseline-2026-08-09
```

当前 V2 不迁移、不读取也不原地升级前代 workspace。请勿把前代数据库复制到 V2 项目后强制启动；应在独立目录和独立分支中处理。
