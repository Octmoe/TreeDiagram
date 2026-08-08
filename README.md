# TreeDiagram

TreeDiagram 是一个面向独立创作者的设计 Agent Harness。它以“树形主结构 + 语义关系图”维护长期、可查询、可由 Agent 操作的设计状态，并提供 Initialize、Derive、Grill、Unbox 和 Re-evaluate 工作流。

当前阶段：**V1 实现完成**（M1–M5 里程碑全部交付，贯穿验收通过）。

## 设计文档

- [V1 实现规格](./V1_SPEC.md)：首版范围、领域模型、工作流、架构、接口与验收标准；实现以此为准。
- [设计探索与决策记录](./DESIGN.md)：产品共识、决策依赖和逐轮推演历史。
- [详细实现设计](./IMPLEMENTATION_DESIGN.md)：固定技术栈、目录、数据库、领域服务、API、Agent、UI 与测试契约。
- [HTTP API 精确契约](./docs/API_CONTRACT.md)：逐路由权限、请求、响应、分页、错误与事件载荷。
- [M1–M5 总体计划](./IMPLEMENTATION_PLAN.md)：里程碑依赖、交付边界和完成定义。

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
| `TREEDIAGRAM_MODEL_PROVIDER`   | —               | 设为 `fake` 使用确定性假模型（离线演示/调试）                                     |
| `TREEDIAGRAM_MODEL_TIMEOUT_MS` | `300000`        | 模型超时（10s–900s）                                                              |
| `TREEDIAGRAM_MAX_SOURCE_BYTES` | `2097152`       | source 上传上限（只可从默认下调）                                                 |
| `LOG_LEVEL`                    | `info`          | `debug/info/warn/error`                                                           |

## 备份与恢复

所有状态都在 `<dir>/.treediagram/` 内。备份步骤：

1. 停止服务（保证 SQLite 无在途写事务）；
2. 复制 `.treediagram/state.sqlite` 与 `.treediagram/workspace.json`（token 文件按需）；
3. 恢复时放回原路径，重新启动服务即可。

重启恢复是设计内能力：开放 ChangeSet 与候选 head 原样保留；遗留 `running`
状态的 WorkflowRun 在启动时被标记 `failed(PROCESS_INTERRUPTED)`，可通过
`POST /api/v1/workflows/:id/resume` 从本地 checkpoint 幂等续跑（不依赖供应商会话）。

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
npm run test:e2e          # Playwright 贯穿场景
npm run test:model-smoke  # 真实 OpenAI 冒烟（需 OPENAI_API_KEY）
```

验收状态：

- 单元 + 集成测试 113 个全部通过（FakeModelProvider 下所有工作流确定性通过）；
- Playwright 贯穿场景（token gate → 编辑 → adopt → 复核 → publish）通过；
- 贯穿验收（V1_SPEC §15 的 11 步 dogfooding 场景）由
  `tests/integration/m5-acceptance.test.ts` 全程通过 API 完成，无需直接编辑数据库；
- 5,000 节点 / 20,000 关系规模测试、工作区重启恢复测试通过（`tests/integration/m1-kernel.test.ts`）；
- 真实 OpenAI 冒烟：**因无 API key 未执行**（`describe.skipIf` 自动跳过；
  设置 `OPENAI_API_KEY` 后运行 `npm run test:model-smoke` 即可执行）。

## 仓库结构

```
packages/contracts   共享类型/枚举/schema（Single Source of Truth）
packages/core        SQLite 持久化、领域规则、服务层、Agent 工作流执行器
apps/server          Fastify HTTP API + 静态托管（仅 127.0.0.1）
apps/web             React 编辑器 UI
scripts/             工作区初始化 / demo 种子 / Release 校验
tests/               unit / integration / e2e / model-smoke
```
