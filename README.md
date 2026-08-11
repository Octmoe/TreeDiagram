# TreeDiagram V2

TreeDiagram 是面向 AI Agent 协作的持久设计空间：宿主负责聊天、推理和工具循环；TreeDiagram 负责设计事实、共享注意力、可审查候选、确定性校验和不可变 Release。它不调用模型，也不保存模型私有推理。

V2 是全新产品边界，只创建 `treediagram-v2` workspace，不迁移或兼容读取 V1。V1 基线仍可通过 [ARCHIVE.md](./ARCHIVE.md) 审计和恢复。

当前源码版本为 `2.0.0-alpha.1`，按 Apache-2.0 许可发布。首个预览版以 Windows、Node.js 24+ 和 Codex Desktop/CLI 为主要验证环境；其他平台在 CI 和独立机器验证完成前不作兼容性承诺。

## 最短试用

要求 Node.js 24+、npm 与 Codex。克隆源码后运行一条显式安装命令：

```powershell
npm.cmd run install:codex
```

命令会执行冻结依赖安装、构建、本机 MCP 配置生成、repo marketplace 注册和插件安装。它会为安装副本生成 Codex cachebuster，但会自动恢复源码 manifest，不让安装过程污染 Git 工作区。若当前终端无法调用 Codex CLI，可先只准备运行时：

```powershell
npm.cmd run install:codex -- --no-codex
```

然后在可使用 Codex CLI 的终端执行：

```powershell
codex plugin marketplace add .
codex plugin add treediagram@treediagram-local
```

在 Codex 中审核并信任 TreeDiagram 的 `SessionStart` Hook，然后新建任务。此后打开任意项目时，插件会自动：

1. 把该任务的 `cwd` 作为项目根目录；
2. 初始化 `<项目>/.treediagram/state-v2.sqlite`；
3. 为该项目启动或复用独立 Sidecar，并把动态 URL 注入任务上下文；
4. 通过 Codex 托管的 stdio MCP 连接同一个项目设计树。

日常使用不再需要运行 npm，也不会把一个项目的设计树复用到另一个项目。不同项目拥有不同 `workspaceId`、SQLite 文件、Sidecar 端口与进程记录；同一项目的多个任务共享设计事实，但 Attention 仍按任务会话隔离。

### 不进入 AI 会话，直接查看已有设计树

电脑重启会结束 Sidecar 进程，但不会删除项目中的设计状态。若想在下一次 AI 会话之前先查看设计树，可直接双击仓库根目录的 [`Open TreeDiagram.cmd`](./Open%20TreeDiagram.cmd)，然后选择已经包含 `.treediagram` 的项目目录。启动器会：

1. 拒绝没有现有设计树的目录，避免一次误选隐式初始化新 workspace；
2. 恢复或复用该项目自己的 Sidecar；
3. 使用该项目的动态端口自动打开浏览器。

这个入口不启动 Codex、不调用 Agent、不运行 initialize Skill，也不创建 ChangeSet。命令行等价入口为：

```powershell
node .\plugins\treediagram\scripts\project.mjs open --workspace H:\path\to\project
```

在 TreeDiagram 源码目录中也可以运行：

```powershell
npm.cmd run treediagram:open -- --workspace H:\path\to\project
```

本仓库开发时可用下面的一条命令重新构建、刷新插件运行时并在后台启动当前项目；命令完成后终端可关闭：

```powershell
npm.cmd run try:codex
```

插件更新后需要重新安装并新建任务，Codex 才会加载新的缓存副本与 Hook 定义。`SessionStart` 只匹配任务首次启动与恢复；对话压缩不会重复执行项目启动检查。

从 Git 拉取新版本后运行：

```powershell
npm.cmd run update:codex
```

卸载应在 Codex 的 `/plugins` 浏览器中完成。下面的命令会给出卸载入口，并可在提供项目路径时先停止对应 Sidecar；它不会删除项目设计数据：

```powershell
npm.cmd run uninstall:codex -- --workspace H:\path\to\project
```

需要自定义 workspace 或演示数据时使用完整命令：

```powershell
npm.cmd run build
npm.cmd run workspace:init -- --workspace <path> --name "My design"
npm.cmd run seed:demo -- --workspace <path>
npm.cmd start -- --workspace <path>
```

`seed:demo` 可省略。服务只绑定 `127.0.0.1`。不传 `--workspace` 时，CLI、MCP 与 Sidecar 都使用当前工作目录；插件模式会直接使用 Codex 提供的项目 `cwd`。

Sidecar 打开后可浏览树、搜索和多选节点、固定约束、检查历史与关系、查看 Agent 焦点、比较候选差异、接管 lease、采用或丢弃候选、确认 root、校验并发布。点击 Working 节点或候选会写入当前项目的“Agent 可见焦点”，但不会自动触发模型调用或设计写入；Agent 通过 `attention_get` 读取 `primaryNodeId/primaryChangeId`，再由 `design_context_get` 获得所选候选的完整结构化内容。读取会解析同一项目最近一次 Sidecar 选择，因此旧标签页和新 Codex 任务的 session 不一致也不会丢失焦点；不同项目仍由独立 workspace 隔离。

候选节点会依据同一 ChangeSet 中尚未采用的 `contains` 关系，以虚线和候选徽标直接投影到设计树的预期位置；没有可解析父节点的候选单独显示为“待定位”。`supports`、`depends_on`、`constrains` 等非层级关系以 `↔` 数量提示。悬停或聚焦右侧关系卡时，左树会分色高亮起点与终点；卡片也直接展示“起点 → 关系类型 → 终点”。

审批采用自上而下的单一路径：根节点可直接批准，其他新节点只有在唯一父节点已进入 Working State 后才能批准。指向新子节点的 `contains` 是附属结构变更，不在右侧重复形成审批卡；批准或丢弃子节点时，节点与该挂载关系在同一 SQLite 事务中一起处理。`supports`、`depends_on` 等语义关系仍单独审查。ChangeSet 仍有任何待处理候选时禁止校验和发布。

项目 Sidecar 的实际端口记录在 `<项目>/.treediagram/sidecar.json`。插件会把已经包含 `host=codex` 与当前 `session` 的完整 URL 注入任务，不需要手工拼接固定端口。

Sidecar 是按项目常驻的独立后台进程，不随浏览器页面、单个 Codex 任务或 stdio MCP 连接关闭；同一项目再次进入时会先进行 workspaceId 绑定的健康检查，健康则复用，失效则重新启动。需要显式结束当前仓库的 Sidecar 时可运行 `npm.cmd run treediagram:stop`；停止过程发送 `SIGTERM`，等待 HTTP 服务关闭并释放 SQLite 后移除进程记录。系统关机或进程异常也会结束服务，设计数据仍保留在项目的 `.treediagram` 目录中。

新会话不会静默继承旧焦点；Sidecar 会显示恢复候选，只有用户明确恢复后才复制 Attention。

## MCP

V2 提供 23 个聚焦工具，覆盖读取、Attention、候选提案、校验和审批动作。所有工具同时返回结构化数据与简洁摘要；可修复错误包含分类、字段路径、期望值、实际值和建议动作。

手工 stdio（默认绑定当前目录）：

```powershell
$env:TREEDIAGRAM_WORKSPACE = "H:\path\to\project"
npm run mcp
```

HTTP：启动项目 Sidecar 后连接其动态 URL 下的 `/mcp`。两种传输使用同一个语义 dispatcher。

Codex 插件位于 [`plugins/treediagram`](./plugins/treediagram)，包含插件清单、stdio MCP 启动器、项目绑定 Hook 与六个 Skills：Initialize、Derive、Grill、Check、Unbox、Re-evaluate。Grill 通过分轮追问厘清决策；Check 负责原 Grill 的一次性压力审查。插件把 MCP UI 当作能力增强；关键人工动作始终可在 Sidecar 完成。

Hermes 的 stdio/HTTP 配置、Skills 安装、会话绑定和兼容矩阵见 [Hermes 兼容说明](./docs/HERMES_COMPATIBILITY.md)。

## 安全与并发边界

- 同一 workspace 同时只有一个活动 ChangeSet，并由一个宿主会话持有写 lease；接管必须是用户显式动作。
- Agent 只能提出、修订或丢弃候选，不能把聊天文本当成采用或发布授权。
- Adopt、Publish、Confirm Root、扩大 Delegation 和 Lease Takeover 使用短时、目标绑定、版本绑定、单次消费的 `ApprovalGrant`；数据库只保存 token hash。
- 所有设计写入、授权消费、发布快照和 Attention 版本更新都在 SQLite transaction 内完成。
- Sidecar 浏览器写请求限制为同源；MCP 与 Sidecar 默认只在 loopback 暴露。
- 插件 Hook 与 MCP 不获得绕过 Codex 权限的能力；首次 Hook 信任、缺失依赖时的 npm 网络访问仍遵循 Codex 审批与管理员策略。

精确契约见 [V2_CONTRACTS.md](./docs/V2_CONTRACTS.md)，产品出发点见 [DESIGN_V2.md](./DESIGN_V2.md)，里程碑边界见 [IMPLEMENTATION_PLAN_V2.md](./IMPLEMENTATION_PLAN_V2.md)。

## 质量门禁

```bash
npm run format:check
npm run typecheck
npm test
npm run test:e2e
npm run build
```

发布维护者还应运行：

```bash
npm run release:check
npm run release:verify
```

其中 `release:check` 要求 Git 工作区干净且已经配置 `origin`；完整源码发布步骤见 [发布指南](./docs/RELEASING.md)。

测试覆盖领域一致性、V1 workspace 拒绝、Attention 会话隔离与显式恢复、单写 lease、Grant 版本/过期/单次消费、stdio/HTTP MCP、发布闭环和 Sidecar 用户路径。真实模型测试不参与确定性正确性。

## V2 结构

```text
packages/contracts       V2 DTO、schema、ToolError 与事件
packages/domain          领域校验、影响闭包和 digest
packages/storage-sqlite  V2 schema、workspace、transaction store
packages/attention       AttentionContext、恢复与 Agent activity
packages/mcp             共享工具语义、stdio 与 Streamable HTTP
packages/ui-core         Sidecar 状态与 React 组件
apps/sidecar             loopback Fastify 服务与常驻三栏 UI
plugins/treediagram      Codex 插件、Skills 与 MCP 配置
integrations/hermes      Hermes 传输配置样例
tests/v2                 unit、integration 与 browser e2e
```

V2 状态位于 `<workspace>/.treediagram/state-v2.sqlite`，元数据位于 `<workspace>/.treediagram/workspace.json`。备份前停止 Sidecar，然后复制整个 `.treediagram` 目录；恢复后重新绑定同一路径即可。

## 许可证

TreeDiagram 依据 [Apache License 2.0](./LICENSE) 发布。贡献代码默认按同一许可证提供；第三方依赖继续适用各自的许可证。
