# TreeDiagram V2

## 用 Codex AI 辅助安装（推荐）

在 Codex 中新建一个任务，把下面这段话直接发给 AI：

```text
请帮我安装 TreeDiagram V2：
1. 如果本机还没有源码，把 https://github.com/Octmoe/TreeDiagram 克隆到合适的开发目录；
2. 阅读仓库 README.md 和 MANUAL.md；
3. 检查 Node.js 24+、npm 与 Codex CLI 是否可用；
4. 在 TreeDiagram 仓库运行 npm.cmd run install:codex；
5. 验证本地 marketplace 与 treediagram 插件安装成功。
不要删除已有项目的 .treediagram 数据。遇到 Hook 信任、权限提升或系统级依赖安装时暂停并让我确认。
完成后提醒我新建一个 Codex 任务，再开始使用插件。
```

如果当前任务已经打开本仓库，可以简化为：

```text
请阅读 README.md 和 MANUAL.md，并替我完成 TreeDiagram V2 的本地 Codex 插件安装与验证。
```

安装过程中 Codex 可能要求你审查并信任 TreeDiagram 的 `SessionStart` Hook。安装完成后必须新建任务，新的 Skills、MCP 工具和 Hook 才会加载。这与 [OpenAI 官方插件说明](https://learn.chatgpt.com/docs/plugins) 一致。

完整安装、日常使用、界面说明、服务生命周期和故障排查见 [V2 使用手册](./MANUAL.md)。

## 它是什么

TreeDiagram 是面向 AI Agent 协作的持久设计空间：

- 宿主 AI 负责聊天、推理与工具调用；
- TreeDiagram 保存设计事实、候选变更、关系、Attention 和 Release；
- Agent 只能提出可审查候选，不能把聊天文本当作采用或发布授权；
- TreeDiagram 本身不调用模型，也不保存模型私有推理。

当前版本为 `2.0.0-alpha.1`，按 Apache-2.0 发布。主要验证环境为 Windows、Node.js 24+ 和 Codex Desktop/CLI。

## 手动安装

```powershell
git clone https://github.com/Octmoe/TreeDiagram.git
cd TreeDiagram
npm.cmd run install:codex
```

若当前终端无法调用 Codex CLI：

```powershell
npm.cmd run install:codex -- --no-codex
codex plugin marketplace add .
codex plugin add treediagram@treediagram-local
```

审查并信任 Hook，然后新建 Codex 任务。日常使用不需要重复运行 npm。

## 第一次使用

1. 在 Codex 中打开真正要设计的项目，而不是 TreeDiagram 源码仓库。
2. 新建任务，确认启动上下文显示 TreeDiagram workspace 和 Sidecar URL。
3. 对 AI 说：

   ```text
   请使用 TreeDiagram 初始化这个项目，把当前想法整理成一个小而可审查的根设计。
   ```

   对已有复杂实现进行结构化梳理时，可改为：

   ```text
   请使用 TreeDiagram Initialize 的已有复杂设计梳理模式，从总体到细节多轮拆分，并把推测的中间设计思路与已有事实分开标记。
   ```

4. 在浏览器中审查候选：先批准父节点，再批准子节点。
5. 处理完全部候选后执行校验并发布 Release。

TreeDiagram 为每个项目使用独立的 `<项目>/.treediagram/`，不会把不同项目的设计树混在一起。

## 不进入 AI 会话，直接查看设计树

双击仓库根目录的 [Open TreeDiagram.cmd](./Open%20TreeDiagram.cmd)，选择一个已经包含 `.treediagram` 的项目目录。它只恢复或复用该项目的 Sidecar，不启动 Agent、不运行 Initialize，也不创建 ChangeSet。

命令行等价入口：

```powershell
npm.cmd run treediagram:open -- --workspace H:\path\to\project
```

## 更新与卸载

```powershell
git pull
npm.cmd run update:codex
```

更新后新建 Codex 任务。卸载请在 Codex 的 `/plugins` 浏览器中完成；如需先停止某个项目的 Sidecar：

```powershell
npm.cmd run uninstall:codex -- --workspace H:\path\to\project
```

卸载不会删除项目中的 `.treediagram` 数据。

## 开发与验证

```powershell
npm ci
npm run release:verify
```

主要结构：

```text
packages/contracts       V2 DTO、schema、ToolError 与事件
packages/domain          领域校验、影响闭包和 digest
packages/storage-sqlite  V2 schema、workspace 与事务存储
packages/attention       Attention、焦点恢复与 Agent activity
packages/mcp             stdio/HTTP MCP 与共享工具语义
packages/ui-core         Sidecar React 界面
apps/sidecar             loopback Fastify 服务
plugins/treediagram      Codex 插件、Hook、Skills 与启动器
tests/v2                 unit、integration 与 browser e2e
```

设计与实现资料：

- [V2 使用手册](./MANUAL.md)
- [产品设计](./DESIGN_V2.md)
- [实现计划](./IMPLEMENTATION_PLAN_V2.md)
- [精确契约](./docs/V2_CONTRACTS.md)
- [Hermes 兼容说明](./docs/HERMES_COMPATIBILITY.md)
- [发布指南](./docs/RELEASING.md)
- [前代归档入口](./ARCHIVE.md)

## 安全边界

- Sidecar 只绑定 `127.0.0.1`，浏览器写请求限制为同源。
- 本地插件 cachebuster 变化时，健康检查会识别旧 runtime generation，并为该项目安全重启 Sidecar。
- 同一 workspace 同时只有一个活动 ChangeSet 和一个写 lease。
- 写 lease 会在成功写入时续租；过期或系统重启前遗留的 lease 可由新会话安全恢复。遇到仍活跃的其他会话时，Agent 会向 Sidecar 登记短时交接请求，用户点击“交给此 Agent”后再继续，无需修改 URL 或复制会话 ID。
- 用户可从 Sidecar 主动关闭项目服务，或在核对项目名和归档绝对路径后把 `.treediagram` 移入项目本地 `.treediagram-archive/`。归档历史只允许用户在文件系统中手动永久删除。
- Adopt、Publish、Confirm Root、扩大 Delegation 与 Lease Takeover 需要短时、目标绑定、版本绑定、单次消费的授权。
- 备份前先停止对应 Sidecar，再复制整个 `.treediagram` 目录。

## 许可证

TreeDiagram 依据 [Apache License 2.0](./LICENSE) 发布。
