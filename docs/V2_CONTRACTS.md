# TreeDiagram V2 精确契约

> 本文是 `IMPLEMENTATION_PLAN_V2.md` 的 M0 开工门禁，也是代码与测试的验收基线。

## 1. Domain 与状态转换

- Workspace 格式固定为 `treediagram-v2`、版本 `2`；其他格式或版本只读检测后返回
  `UNSUPPORTED_WORKSPACE_VERSION`，不得迁移或改写。
- 每个逻辑 Node/Relation 使用不可变 Revision；Working Head 指向已采用的最新 Revision，Release 保存
  发布时的 Revision ID 快照。
- 每个 Workspace 最多一个 `open|ready` ChangeSet。候选 DesignChange 独立经历
  `proposed -> adopted|discarded`；采用会原子写入 Revision 与 Working Head，未采用候选不进入 Release。
- ChangeSet 在所有已采用内容通过一致性检查后可进入 `ready`；发布后进入 `published` 并释放 lease。
- 根节点定义为带 `root` role 的 Node；首个 Release 必须恰有一个 `user_confirmed` 的 goal/claim/constraint
  根节点。V2.0 首版保持单根以降低歧义。
- 删除采用 tombstone 表达，不物理删除 Node/Relation/Revision；历史 Release 永远可重建。

## 2. MCP Tool 与 ToolError

- 所有工具返回 `{ok,data,summary}` 或 `{ok:false,error}`；MCP transport 失败仅用于协议或进程故障。
- 读工具：`design_workspace_get`、`design_tree_get`、`design_node_get`、`design_query`、
  `design_relations_get`、`design_context_get`、`design_changeset_get`、`design_impact_get`。
- Attention 工具：`attention_get`、`attention_set`、`attention_pin`、`attention_clear`、
  `attention_agent_focus_set`。
- 写工具：`changeset_begin`、`design_change_propose`、`design_change_revise`、
  `design_change_discard`、`changeset_validate`。
- 高权限工具：`changeset_adopt`、`design_release_publish`、`design_root_change_confirm`、
  `delegation_policy_set`；必须提交未消费、未过期且 digest/version 匹配的 ApprovalGrant token。
- 错误类别严格为 `agent_recoverable`、`user_input_required`、`state_conflict`、
  `permission_required`、`infrastructure_failure`。Schema 错误必须给出字段 path、expected、actual、
  retryable 与 suggestedAction。

## 3. Attention、Lease 与 Grant 事务边界

- Attention 写入身份为 `workspaceId + hostKind + hostSessionRef + clientRef`，因此各 Sidecar 标签页仍可独立恢复。Agent 读取使用命名共享投影（Codex 为 `codex-agent`，Hermes 为 `hermes-agent`）：在当前 workspace 内选取同一 hostKind 最近更新的命名通道，即使 Agent 与页面的 host session 不同也能读到用户最后标记的焦点；绝不跨 workspace。`primaryNodeId/selectedNodeIds` 表示 Working 节点焦点，`primaryChangeId/selectedChangeIds` 表示候选焦点。更新使用 version CAS；选择只写 Attention 表与高频事件，不触碰设计表、ChangeSet 或模型。
- `attention_get` 是 Agent 读取用户明确目标的权威入口；`design_context_get` 必须直接返回 `selectedChanges`，不得要求 Agent 从整个 ChangeSet 猜测用户选中了哪一项。
- 同一 host session 自动读取原 context；新 session 只能列出恢复候选，并在用户明确操作后复制，不能复用 ID。
- ChangeSetWriteLease 与所有候选写操作在同一 SQLite transaction 内校验；版本或 owner 不符返回
  `state_conflict`。接管只更换 owner，不删除候选。
- ApprovalGrant 保存 token hash，不保存明文；绑定 action、target digest、expected version、可选 host session
  与过期时间。消费 Grant 与高权限副作用在同一 transaction；任何目标内容或版本变化都使旧 Grant 失效。
- Sidecar 是本地可信的人机审批表面：只有明确按钮操作可签发 Grant。MCP Agent 工具不能自行签发 Grant。

## 4. 确定性一致性最小集

- 恰有一个有效、用户确认的根；contains 无环且每个节点最多一个 contains 父节点；Relation endpoint 存在；
  Node/Relation review 不得为 required/blocked；blocking question 与无证据 supported 状态阻止发布。
- 检查器只读取 materialized Working Head；所有结果包含稳定 code、severity、entityId/path 与可操作说明。
