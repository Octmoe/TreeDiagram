# TreeDiagram

> **项目正在进行 V2 架构转型。** 当前方向是“宿主聊天 Harness + TreeDiagram Skill/MCP + 常驻设计树”，
> 详见 [DESIGN_V2.md](./DESIGN_V2.md)。原 standalone Agent Harness 已完整冻结在
> `archive/v1-harness-baseline-2026-08-09`，归档说明见 [ARCHIVE.md](./ARCHIVE.md)。

TreeDiagram V2 是一个面向 AI Agent 协作的持久设计空间。宿主 Harness 负责聊天、推理与工具循环；
TreeDiagram 负责设计状态、共享注意力、确定性校验、ChangeSet、Release，以及让用户可以直接选择节点
来指示 Agent 工作的常驻树形界面。

下文记录的命令和界面描述仍对应已归档的 V1 实现，在 V2 迁移期间仅作为运行与迁移参考。

## 设计文档

- [V2 整体设计](./DESIGN_V2.md)：当前产品边界、Attention Context、Skill/MCP/UI 架构与迁移策略。
- [V1 归档说明](./ARCHIVE.md)：归档引用、恢复方式与资产处置。
- [V1 实现规格](./V1_SPEC.md)：已归档的首版范围、领域模型、工作流、架构与验收标准。
- [V1 设计探索与决策记录](./DESIGN.md)：已归档的产品共识、决策依赖和逐轮推演历史。
- [V1 详细实现设计](./IMPLEMENTATION_DESIGN.md)：已归档的技术栈、数据库、API、Agent 与 UI 契约。
- [V1 HTTP API 契约](./docs/API_CONTRACT.md)：已归档的逐路由权限、请求、响应与错误契约。
- [V1 M1–M5 计划](./IMPLEMENTATION_PLAN.md)：已归档的里程碑依赖、交付边界和完成定义。
- [V1 使用手册](./MANUAL.md)：已归档实现的运行、工作流与发布说明。

## 环境要求

- Node.js ≥ 24（`engines` 已锁定）
- npm（workspaces 单体仓库：`packages/*` + `apps/*`）

## 安装与构建

```bash
npm ci          # 干净安装（CI 门禁基线）
npm run build   # 构建 packages + server + web
```

## 初始化工作区

```bash
npm run workspace:init -- --path <dir> --name <project-name>
```

初始化在 `<dir>/.treediagram/` 下生成：

- `state.sqlite`：全部设计状态（节点/关系/ChangeSet/Release/事件/工作流运行）
- `workspace.json`：工作区元数据
- `admin-token` / `consumer-token`：两种访问令牌（只打印文件路径，不打印正文）

可选：载入演示数据 `node scripts/seed-demo.ts --workspace <dir>`。

## 运行

快捷启动（推荐）：一条命令完成「初始化（首次）→ 构建（如需）→ 启动服务」。

```bash
npm start                          # 默认工作区 ./workspace
npm start -- --workspace <dir>     # 指定工作区
npm start -- --fake                # 离线演示：确定性假模型，无需 OPENAI_API_KEY
npm start -- --build               # 强制重新构建
```

手动方式：

```bash
TREEDIAGRAM_WORKSPACE=<dir> npm run dev
# 或 node apps/server/dist/index.js --workspace <dir>
```

服务仅绑定 `127.0.0.1`，默认端口 4317。浏览器打开 `http://127.0.0.1:4317/`，
粘贴 admin token 进入编辑器（树浏览、节点/关系编辑、复核队列、工作流面板）。

环境变量：

| 变量                           | 默认            | 说明                                                                              |
| ------------------------------ | --------------- | --------------------------------------------------------------------------------- |
| `TREEDIAGRAM_WORKSPACE`        | —（必填）       | 工作区目录（或 `--workspace <dir>`）                                              |
| `TREEDIAGRAM_PORT`             | `4317`          | 监听端口                                                                          |
| `TREEDIAGRAM_MODEL`            | `gpt-5.6-terra` | Agent 工作流模型                                                                  |
| `OPENAI_API_KEY`               | —               | 真实模型调用凭证；未设置时写接口可用、Agent 工作流返回 422 `MODEL_NOT_CONFIGURED` |
| `OPENAI_BASE_URL`              | 官方端点        | OpenAI 兼容网关/代理端点                                                          |
| `TREEDIAGRAM_MODEL_CONFIG`     | 见下节          | 模型 JSON 配置文件路径（或 `--model-config <path>`）                              |
| `TREEDIAGRAM_MODEL_PROVIDER`   | —               | 设为 `fake` 使用确定性假模型（离线演示/调试）                                     |
| `TREEDIAGRAM_MODEL_TIMEOUT_MS` | `300000`        | 模型超时（10s–900s）                                                              |
| `TREEDIAGRAM_MAX_SOURCE_BYTES` | `2097152`       | source 上传上限（只可从默认下调）                                                 |
| `LOG_LEVEL`                    | `info`          | `debug/info/warn/error`                                                           |

## 模型配置（JSON 文件）

Agent 工作流的模型接入推荐使用 JSON 配置文件。默认路径
`<workspace>/.treediagram/model.json`（与 token 同目录，启动时自动加载）；
也可用 `--model-config <path>` 或 `TREEDIAGRAM_MODEL_CONFIG` 指定其他位置。

```json
{
  "provider": "openai",
  "apiKey": "sk-...",
  "baseUrl": "https://your-gateway.example.com/v1",
  "model": "gpt-5.6-terra",
  "timeoutMs": 300000,
  "outputTokens": {
    "readiness": 8192,
    "proposal": 16384,
    "initialize": 32768,
    "repair": 32768,
    "retryCeiling": 65536
  }
}
```

- `provider`：`openai`（默认，需 `apiKey`）或 `fake`（离线演示，不得再设 `apiKey/baseUrl`）；
- `baseUrl`：可选，指向任何 OpenAI 兼容端点（网关/代理/自托管）；
- `model`、`timeoutMs`：可选，覆盖对应环境变量；
- `outputTokens`：可选的阶段预算覆盖。默认 Initialize/修复为 32K，普通提案 16K，就绪评估 8K；
  provider 明确以 `max_output_tokens` 截断时自动把当次预算加倍重试一次，但不超过 `retryCeiling`；
- 合并优先级：**配置文件 > 环境变量 > 默认值**；配置文件只含部分字段时，其余字段回退到环境变量；
- 文件是敏感数据：启动日志只打印 provider 名称与 baseUrl，绝不打印 `apiKey`；
- 文件不合法（JSON 错误/未知字段/非法值）会在启动时给出带路径的明确错误并拒绝启动。

## 备份与恢复

所有状态都在 `<dir>/.treediagram/` 内。备份步骤：

1. 停止服务（保证 SQLite 无在途写事务）；
2. 复制 `.treediagram/state.sqlite` 与 `.treediagram/workspace.json`（token 文件按需）；
3. 恢复时放回原路径，重新启动服务即可。

重启恢复是设计内能力：开放 ChangeSet 与候选 head 原样保留；遗留 `running`
状态的 WorkflowRun 在启动时被标记 `failed(PROCESS_INTERRUPTED)`，可通过
`POST /api/v1/workflows/:id/resume` 从本地 checkpoint 幂等续跑（不依赖供应商会话）。

每个工作流先做独立的就绪评估。关键歧义、待决策和外部依赖会成为带稳定 ID、生命周期和
执行门位置的 `workflow_issue`，并在任何提案写入前进入 `waiting_user`。Workflow 面板会自动展开
任务对话；用户回答后，服务端以原始上下文、本地对话、Issue 账本和附件重新运行同一阶段。
HTTP 客户端可使用：

- `GET /api/v1/workflows/:id/messages` 读取对话、当前开放等待与 Issue 账本；
- `POST /api/v1/workflows/:id/respond` 提交幂等回答并继续；
- `POST /api/v1/workflows/:id/retry` 仅重试 `failed` 运行。

聊天回答不会隐式确认 root、发布 Release 或修改托管策略；这些仍是显式用户操作。
提案写入前还会投影到内存 WorkingSet 并运行一致性检查：新增的硬结构错误最多自动回修两次，
仍失败则整个提案不落库；需要用户判断的问题重新进入 Issue 门。Initialize 写入 tentative root 后
会停在“等待审批”，直到用户把根节点 revise 为 `user_confirmed` 并在面板触发重新检查。

Workflow 面板可展开“模型记录”：请求发出前即写入当前阶段（就绪评估、完整提案、自动修复）、
开始时间、模型与推理档位，完成后补充最终结构化响应、responseId 和 token
用量。记录只对 admin 开放，密钥字段会脱敏，源码/上下文/响应会截断，不包含模型内部思维链。
每次运行最多保留最近 50 条调用记录。

## 下游读取（consumer）

下游系统使用 consumer token 做只读增量同步：

- `GET /api/v1/status` 与 `GET /api/v1/events?after=<cursor>&limit=<n>` **始终可读**——
  用事件 cursor 轮询等待 `release.published`；
- `GET /api/v1/release/current`、`GET /api/v1/tree?view=release`、`GET /api/v1/query?view=release`
  仅在 project = `consistent` 时可用；`initializing` 返回 423 `DESIGN_NOT_INITIALIZED`，
  `reevaluating/blocked` 返回 423 `DESIGN_NOT_CONSISTENT`；
- working 视图、历史、写接口对 consumer 一律 403，无绕过路径。

详见 [API 契约 §2/§3.3](./docs/API_CONTRACT.md)。

## 测试与质量门禁

```bash
npm run format            # prettier
npm run typecheck         # 全部 tsconfig 严格检查
npm test                  # vitest：unit + integration（FakeModelProvider，确定性）
npm run test:e2e          # Playwright 贯穿场景；有 OPENAI_API_KEY 时追加真实模型 UI 闭环
npm run test:model-smoke  # 4 个真实 OpenAI 兼容端点测试（需 OPENAI_API_KEY）
```

验收状态：

- 单元 + 集成套件覆盖全部工作流，并以 FakeModelProvider 确定性验证；
- 6 个确定性 Playwright 场景通过；配置真实模型后，第 7 个场景会经浏览器和真实 server
  调用模型并完成 Derive → Adopt → Review → Publish；
- 贯穿验收（V1_SPEC §15 的 11 步 dogfooding 场景）由
  `tests/integration/m5-acceptance.test.ts` 全程通过 API 完成，无需直接编辑数据库；
- 5,000 节点 / 20,000 关系规模测试、工作区重启恢复测试通过（`tests/integration/m1-kernel.test.ts`）；
- 4 个真实 OpenAI 兼容端点测试覆盖：Initialize 就绪评估与完整投影、Core 全生命周期
  （Derive 等待/回答 → Grill → Unbox → Adopt → Re-evaluate → Publish）、HTTP API 闭环、
  在途请求取消；未提供 `OPENAI_API_KEY` 时自动跳过，设置后运行
  `npm run test:model-smoke` 复验当前模型行为。

## 仓库结构

```
packages/contracts   共享类型/枚举/schema（Single Source of Truth）
packages/core        SQLite 持久化、领域规则、服务层、Agent 工作流执行器
apps/server          Fastify HTTP API + 静态托管（仅 127.0.0.1）
apps/web             React 编辑器 UI
scripts/             工作区初始化 / demo 种子 / Release 校验
tests/               unit / integration / e2e / model-smoke
```
