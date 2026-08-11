# Hermes 兼容与安装

TreeDiagram V2 的 Domain、SQLite 事务和 MCP 工具不依赖宿主。Hermes 只需要选择 stdio 或 HTTP 传输，并为每次调用使用稳定的宿主会话标识。

## 1. 前置准备

先在 TreeDiagram 仓库完成构建和 V2 workspace 初始化：

```bash
npm ci
npm run build
npm run workspace:init -- --workspace <V2_WORKSPACE> --name "My design"
```

TreeDiagram 不需要模型密钥，也不会自行调用模型。

## 2. 连接 MCP

Hermes 官方客户端同时支持本地 stdio 与 HTTP MCP，并从 `~/.hermes/config.yaml` 的 `mcp_servers` 读取配置。完整字段以 [Hermes MCP 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md) 为准。

### stdio

把 [`config.stdio.example.yaml`](../integrations/hermes/config.stdio.example.yaml) 合并进 `~/.hermes/config.yaml`，替换两个绝对路径占位符；或者执行：

```bash
hermes mcp add treediagram --command node --env TREEDIAGRAM_WORKSPACE=<V2_WORKSPACE> --args <TREE_DIAGRAM_REPO>/packages/mcp/dist/stdio.js
hermes mcp test treediagram
```

`--args` 必须放在命令最后。stdio 由 Hermes 管理子进程生命周期，不需要另外启动 Sidecar 才能使用无头工具。

### HTTP + Sidecar

先启动绑定目标 workspace 的 Sidecar：

```bash
npm start -- --workspace <V2_WORKSPACE>
hermes mcp add treediagram --url http://127.0.0.1:4317/mcp
hermes mcp test treediagram
```

等价配置见 [`config.http.example.yaml`](../integrations/hermes/config.http.example.yaml)。HTTP 与 Sidecar 共用同一个 `ToolService`，因此不会出现 REST 与 MCP 两套领域语义。

## 3. 安装 Skills

Hermes 支持标准 `SKILL.md` 目录。将 `plugins/treediagram/skills/` 下需要的 `treediagram-*` 目录复制到 `~/.hermes/skills/`，然后运行：

```bash
hermes skills list
```

在新会话中用 `/treediagram-initialize`、`/treediagram-derive`、`/treediagram-grill`、`/treediagram-check`、`/treediagram-unbox` 或 `/treediagram-reevaluate` 调用。Grill 会分轮追问用户直到形成共同理解；Check 承接原 Grill 的只读压力审查。Hermes 会把技能正文中的 `${HERMES_SESSION_ID}` 替换为当前会话 ID；这是 `HostSessionBinding` 的宿主适配层。技能格式与会话变量行为见 [Hermes Skills 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/creating-skills.md)。

Hermes 会把工具注册为 `mcp_treediagram_<tool-name>`；语义和结构化结果与原 MCP 名称相同。

## 4. 人工审批与 Sidecar

无头 Hermes 可以读取、管理 Attention、建立 ChangeSet、提出/修订/丢弃候选和运行确定性校验。以下动作必须由真实用户手势签发一次性 `ApprovalGrant`：

- adopt 候选；
- confirm root；
- publish Release；
- 扩大 delegation；
- 接管写 lease。

在浏览器打开：

```text
http://127.0.0.1:4317/?host=hermes&session=<HERMES_SESSION_ID>
```

Sidecar 是完整人工操作面，不依赖 Hermes 是否支持 MCP Apps。聊天中的“同意”不是 grant，Agent 不应生成或索取 token。

## 5. 跨宿主兼容报告

| 能力                            | Codex                   | Hermes                  | 共享语义来源                   |
| ------------------------------- | ----------------------- | ----------------------- | ------------------------------ |
| workspace/tree/query/context    | 原 MCP 工具名           | `mcp_treediagram_` 前缀 | `ToolService`                  |
| Attention 隔离与恢复            | Codex task ref          | `HERMES_SESSION_ID`     | `AttentionService`             |
| propose/revise/discard/validate | 相同参数与错误分类      | 相同参数与错误分类      | Domain + SQLite transaction    |
| adopt/publish/root/lease        | 用户手势 grant          | 用户手势 grant          | `ApprovalGrant` digest/version |
| 人工 UI                         | Sidecar；嵌入 UI 可增强 | Sidecar                 | `ui-core` + Sidecar API        |

确定性正确性不依赖真实模型。标准 MCP 客户端测试覆盖 stdio 与 HTTP 工具发现和调用；同一生命周期集成测试覆盖 Attention 隔离、lease 冲突、grant 过期/单次消费、校验与发布。
