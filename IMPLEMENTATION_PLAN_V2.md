# TreeDiagram V2 实施计划

> 状态：V2 参考实现已完成
>
> 基线日期：2026-08-09；完成日期：2026-08-10
>
> 产品设计：[DESIGN_V2.md](./DESIGN_V2.md)

## 1. 实施边界

V2 按全新产品开发：

- 只支持新建 V2 workspace；
- 不读取、迁移或兼容旧格式 workspace；
- 不复用前代 Harness 的 Workflow、模型 Provider、聊天或重试状态机；
- 历史源码只通过归档标签查阅；
- 每个里程碑从无头能力开始，再增加 Sidecar 和宿主增强。

### 实施结果与计划调整

- M0 的三份精确契约已作为实现门禁直接纳入 contracts、领域事务和 contract tests，不再保留独立的前置讨论阶段；
- stdio、HTTP、Sidecar REST 共用一个 `ToolService`，以代码边界保证跨传输与跨宿主语义一致；
- Sidecar 是全部人工审批能力的完整基线；MCP Apps 只在宿主实际暴露该能力时渐进启用，不作为首个跨宿主版本的阻塞门；
- Codex 是参考宿主，Hermes 通过标准 MCP、标准 Skills 和会话标识适配，不向 Domain 增加宿主分支；
- 前代实现只保留归档引用，V2 workspace 对旧格式输入明确拒绝且不修改。

## 2. 目标代码边界

```text
packages/
  contracts/       V2 领域 DTO、MCP schema、错误与事件
  domain/          节点、关系、修订、ChangeSet、Release、权限规则
  storage-sqlite/  全新 V2 schema、repository、transaction
  attention/       AttentionContext、HostSessionBinding、活动与 lease
  mcp/             MCP tools/resources、认证、结构化结果
  ui-core/         Sidecar 与 MCP App 共用的状态和组件
apps/
  sidecar/         常驻本地设计树应用
plugins/
  treediagram/     Codex 插件清单、Skills、MCP 配置与宿主适配
skills/
  initialize/
  derive/
  grill/
  check/
  unbox/
  reevaluate/
```

包名和物理目录可以在 M0 调整，但依赖方向必须保持：

```text
contracts <- domain <- storage/attention <- mcp <- host adapters
                                      ui-core <- sidecar/MCP App
```

Domain 不得依赖 MCP、HTTP、React、Codex、Hermes 或宿主会话对象。

## 3. M0：干净骨架

### 交付

- 固化 V2 Domain、MCP/ToolError、Attention/Lease/Grant 三份精确契约（见 `docs/V2_CONTRACTS.md`）；
- 建立 V2 package graph 与应用入口；
- 建立全新 workspace 标识和空数据库创建流程；
- 删除 V2 默认启动路径对历史 apps/packages 的引用；
- 配置 format、lint、typecheck、unit 和 e2e 基线；
- 为前代源码保留 Git 归档引用，不建立运行时兼容层。

### 完成条件

- 三份契约可由 contract tests 直接验证，不再作为里程碑之外的隐式门禁；
- 新用户可以初始化空 V2 workspace；
- V2 build/test 不构建已归档的 Workflow Runner；
- 向 V2 传入旧格式 workspace 时明确返回 `UNSUPPORTED_WORKSPACE_VERSION`，不做修改。

## 4. M1：Design State Core

### 交付

- Node / NodeRevision；
- Relation / RelationRevision；
- ChangeSet 与单一活动 Working State；
- Release 与确定性一致性检查；
- Approval、epistemic、review 等仍被 V2 需要的状态轴；
- `ToolError`/`DomainError` 的统一错误类别。

### 完成条件

- 所有写操作都在 SQLite transaction 内完成；
- Schema 错误包含 path、expected、actual、retryable 和 suggestedAction；
- Domain 测试不加载任何模型或宿主代码；
- 从空 workspace 可以手动形成并发布最小设计树。

## 5. M2：无头 MCP 读取与上下文

### 交付

- `design_workspace_get`；
- `design_tree_get`；
- `design_node_get`；
- `design_query`；
- `design_relations_get`；
- `design_context_get`；
- `design_changeset_get`；
- `design_impact_get`。

### 完成条件

- 任意标准 MCP 客户端可以查询新 workspace；
- 工具同时返回结构化数据和简洁模型可读摘要；
- `design_context_get` 在预算内装配根路径、焦点、约束、决策、证据和候选差异；
- 读取工具无 UI 也可完成全部功能。

## 6. M3：Attention 与常驻 Sidecar

### 交付

- AttentionContext 持久化与 version；
- HostSessionBinding；
- Selected、Primary、Pinned、Scope 和 Agent Focus；
- 同会话自动恢复与跨会话恢复确认；
- Attention/Agent activity 事件；
- Sidecar 的树、焦点栏、Inspector 和活动显示。

### 完成条件

- 用户选择节点后，绑定会话的下一次 Agent 查询能够读取该焦点；
- 单击节点不触发模型调用或设计写入；
- 两个会话的焦点互不覆盖；
- 新会话不能静默继承旧焦点；
- Sidecar 重启后可以恢复设计状态和同会话 Attention。

## 7. M4：受控提案、单写者与授权

### 交付

- `changeset_begin`；
- `design_change_propose`；
- `design_change_revise`；
- `design_change_discard`；
- `changeset_validate`；
- ChangeSetWriteLease；
- ApprovalGrant；
- Adopt、Publish、Confirm Root 和 Delegation 的高权限工具。

### 完成条件

- Agent 的非法参数作为 `agent_recoverable` 返回并可在下一次工具调用修正；
- 同一时刻只有一个宿主会话能写活动 ChangeSet；
- Sidecar 可以显示 lease 所有者并让用户显式接管；
- 内容或版本变化后旧 Grant 立即失效；
- Agent 不能仅凭聊天文本完成高权限操作。

## 8. M5：Codex 参考宿主

### 交付

- TreeDiagram Codex 插件清单；
- Codex 托管的 stdio MCP Server 安装和启动配置；
- Initialize、Derive、Grill、Check、Unbox、Re-evaluate Skills；
- `SessionStart` 项目绑定、初始化诊断与 Sidecar 启动/打开能力；
- 独立于 Agent 会话的人类启动器，可选择已有项目、冷启动 Sidecar 并直接打开设计树，且误选目录时不得初始化新 workspace；
- 按项目隔离的 SQLite、动态 loopback 端口和幂等后台进程复用；
- Codex HostSessionRef 与 Attention 绑定；
- 在可用表面上的 MCP Apps UI 增强。

### 完成条件

- 用户不选择 Workflow 类型，只通过节点焦点和自然语言完成贯穿场景；
- Agent 可以多轮澄清、分批提案并修复可恢复工具错误；
- Sidecar 始终能完成嵌入式 UI 不可用时的全部人工操作；
- 插件完成一次安装和 Hook 信任后，新项目无需手动 npm、固定端口或显式 workspace 参数；
- 电脑重启后，用户无需创建或恢复 AI 会话即可打开任一已有项目的设计树；
- 两个同时打开的 Codex 项目拥有不同 workspaceId、数据库与 Sidecar 端口，同一项目重复启动只复用本项目进程；
- 所有 Codex 增强通过 capability detection 启用。

## 9. M6：Hermes 兼容门禁

### 交付

- Hermes stdio/HTTP MCP 配置样例；
- Hermes Skill 包装或安装说明；
- HostSessionBinding 适配；
- 无头与 Sidecar 贯穿测试；
- 跨宿主工具契约报告。

### 完成条件

- 不修改 Domain 或 MCP 工具语义即可完成读取、Attention、提案和确认；
- Hermes 和 Codex 对相同输入得到相同领域校验结果；
- 宿主差异只存在于 Host Adapter 和 UI 增强层；
- 通过后冻结首个跨宿主 MCP 工具版本。

## 10. 测试分层

- **Contract tests**：Schema、ToolError、MCP 输入输出兼容性；
- **Domain tests**：修订、ChangeSet、Release、权限、一致性；
- **Attention tests**：会话隔离、恢复、version 和过期；
- **Concurrency tests**：lease、接管、旧写入者冲突；
- **Authorization tests**：Grant digest/version/expiry/single-use；
- **Transport tests**：stdio 与 HTTP MCP 行为一致；
- **UI tests**：焦点、Scope、差异、确认和 Sidecar 恢复；
- **Host e2e**：Codex 贯穿场景与 Hermes 兼容门禁。

真实模型测试验证 Agent 能否使用工具；确定性领域正确性不得依赖真实模型测试。

## 11. 首版不进入

- 旧格式数据迁移或兼容读取；
- 多 Draft ChangeSet 和自动合并；
- 多用户远程协作；
- TreeDiagram 自己调用模型；
- 固定 Workflow 状态机；
- 仅某一个宿主可用的领域工具；
- 无目标绑定的长期授权 token。

## 12. 开工门禁（已并入 M0）

进入代码实现前只需补完三份精确契约：

1. V2 Domain Schema 与状态转换；
2. MCP Tool Contract 与 ToolError Contract；
3. Attention/Lease/ApprovalGrant 的存储和事务边界。

三份契约由 `docs/V2_CONTRACTS.md` 固化并纳入 M0 与 contract tests；不再讨论旧格式数据如何迁移。
