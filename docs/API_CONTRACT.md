# TreeDiagram HTTP API 契约

本文档是 TreeDiagram V1 HTTP 接口在**字段、权限、分页和错误细节**上的权威定义
（见 IMPLEMENTATION_DESIGN §0 的文档优先级）。接口形态与状态机语义以
IMPLEMENTATION_DESIGN §11 为准；schema 的机器可读实现位于
`packages/contracts/src/schemas/`，路由实现位于 `apps/server/src/routes/`。

- Base URL：`http://127.0.0.1:4317/api/v1`（服务仅绑定 loopback，绝不监听 `0.0.0.0`）
- 除 `GET /health` 外，所有请求与响应 body 均为 `application/json; charset=utf-8`
- 所有 route 的 body、params、query 与成功 response 都有 TypeBox schema；错误 response 使用共享的 `ErrorResponseSchema`

## 1. 通用响应信封

成功（HTTP 2xx）：

```json
{ "data": {}, "meta": { "requestId": "uuid" } }
```

失败（HTTP 4xx/5xx）：

```json
{
  "error": {
    "code": "DOMAIN_ERROR_CODE",
    "message": "human-readable message",
    "details": {},
    "requestId": "uuid"
  }
}
```

- `requestId` 为每次请求生成的 UUID，同时出现在结构化日志中，用于问题定位。
- `error.code` 是稳定机器可读标识（见 §4 映射表）；`error.message` 面向人，客户端不得依赖其内容做分支。
- `error.details` 携带结构化上下文（如 `STALE_BASE_REVISION` 时给出 `{ "expectedBaseRevisionId": ..., "actualTipRevisionId": ... }`）；无上下文时为空对象 `{}`。
- 500 响应**不得**包含堆栈、SQL、文件路径或设计正文。

## 2. 鉴权

### 2.1 机制

- `GET /api/v1/health` 无鉴权。
- 其他所有 `/api/v1/*` 需要 `Authorization: Bearer <token>`。
- token 在 workspace 初始化时生成，存放于 `<workspace>/.treediagram/admin-token` 与
  `<workspace>/.treediagram/consumer-token`（0600 权限）；数据库只保存 token 的 SHA-256。
  校验使用常数时间比较，避免时序侧信道。
- 鉴权结果为两种 scope：`admin`（全量）或 `consumer`（下游只读）。
- V1 **不接受 URL query token**（避免浏览器历史与 access log 泄露）；静态 UI shell
  首次进入显示 token 输入页，用户从 admin-token 文件粘贴，值只保存到当前 tab 的
  sessionStorage。
- 服务端日志必须 redact `Authorization` header；request serializer 只记录 URL
  pathname，不记录 query string。

### 2.2 Scope 矩阵

| 路由分组                                                              | admin | consumer               |
| --------------------------------------------------------------------- | ----- | ---------------------- |
| `GET /health`                                                         | 公开  | 公开                   |
| `GET /status` · `GET /events` · `GET /release/current`                | ✅    | ✅                     |
| `GET /tree` · `GET /query` · `GET /nodes/:id`（view=release）         | ✅    | ✅（仅 consistent 时） |
| `GET /tree` · `GET /query` · `GET /nodes/:id`（view=working）         | ✅    | ❌ 403                 |
| `GET /nodes/:id/history` · `GET /nodes/:id/relations`                 | ✅    | ❌ 403                 |
| 全部写接口（nodes/relations/sources/change-set/delegation/workflows） | ✅    | ❌ 403                 |
| `GET /project` · `GET /change-set/*` · `GET /workflows*`              | ✅    | ❌ 403                 |

- consumer 对 release 视图的读取还有第二道闸门：project 状态非 `consistent` 时返回
  **423 `DESIGN_NOT_CONSISTENT`**（见 §3.3）。consumer 不存在绕过闸门读取历史
  Release 或 working view 的路径。
- 越权访问返回 403 `FORBIDDEN`；token 缺失或错误返回 401 `AUTH_REQUIRED`。

## 3. 状态码与错误映射

### 3.1 状态码总表

| 状态码 | 含义                                                     |
| ------ | -------------------------------------------------------- |
| 200    | 查询/同步操作成功                                        |
| 201    | 创建成功（POST nodes / relations / sources / revisions） |
| 202    | WorkflowRun 已启动（POST /workflows）                    |
| 400    | JSON Schema 不合法                                       |
| 401    | token 缺失或错误                                         |
| 403    | token scope 不允许该操作                                 |
| 404    | 资源不存在                                               |
| 409    | 当前 project/changeSet 状态不允许                        |
| 422    | 领域规则不满足                                           |
| 423    | 下游读取因 initializing/reevaluating/blocked 被锁定      |
| 500    | 未预期错误                                               |

### 3.2 DomainError → HTTP 映射

| DomainError code                  | HTTP | 典型场景                                        |
| --------------------------------- | ---- | ----------------------------------------------- |
| `VALIDATION_FAILED`               | 400  | body/params/query 不满足 JSON Schema            |
| `AUTH_REQUIRED`                   | 401  | 无 token 或 token 未匹配任何 scope              |
| `FORBIDDEN`                       | 403  | consumer 访问 admin-only 路由                   |
| `NOT_FOUND`                       | 404  | 节点/关系/ChangeSet/WorkflowRun/Source 不存在   |
| `STALE_BASE_REVISION`             | 409  | revise 时 baseRevisionId 不是当前 tip           |
| `INVALID_STATE_TRANSITION`        | 409  | 对当前状态不允许的变更（如对已归档节点 revise） |
| `CHANGE_SET_ALREADY_EXISTS`       | 409  | 已存在 live ChangeSet 时再次隐式/显式开启       |
| `WORKFLOW_ALREADY_RUNNING`        | 409  | 已有 running/paused 的 WorkflowRun              |
| `WORKFLOW_NOT_RESUMABLE`          | 409  | resume 一个非 paused/failed 状态的 run          |
| `WORKFLOW_NOT_AVAILABLE`          | 409  | 当前 project 状态下该工作流种类不可用           |
| `ROOT_REQUIRES_USER_CONFIRMATION` | 422  | 尝试以非 user_confirmed 方式确认根节点          |
| `AI_SCOPE_VIOLATION`              | 422  | AI 写入超出其 ChangeSet 范围或确认权限          |
| `RELATION_ENDPOINT_INVALID`       | 422  | 关系端点违反端点矩阵或指向不存在的实体          |
| `DESIGN_INCONSISTENT`             | 422  | publish 时一致性检查存在 blocking 问题          |
| `MODEL_NOT_CONFIGURED`            | 422  | 启动 Agent 工作流但未配置模型                   |
| `MODEL_OUTPUT_INVALID`            | 422  | 模型输出未通过 schema 校验（同步暴露时）        |
| `DESIGN_NOT_INITIALIZED`          | 423  | 下游读取时 project=initializing                 |
| `DESIGN_NOT_CONSISTENT`           | 423  | 下游读取时 project=reevaluating/blocked         |
| `CORRUPT_PERSISTED_DATA`          | 500  | 持久化数据无法解析（含迁移/索引损坏）           |
| 未捕获异常                        | 500  | `INTERNAL_ERROR`，不含堆栈                      |

模型侧的 `MODEL_REFUSED` / `MODEL_PROVIDER_FAILED` 在异步工作流中记录到
WorkflowRun（state=failed），HTTP 创建响应仍为 202；仅在校验前置失败时同步返回。

### 3.3 下游读取锁定（423）

`GET /release/current` 以及 consumer scope 的 release 视图读取遵循闸门：

| project 状态 | admin release 读取 | consumer release 读取        |
| ------------ | ------------------ | ---------------------------- |
| consistent   | 200                | 200                          |
| initializing | 200                | 423 `DESIGN_NOT_INITIALIZED` |
| reevaluating | 200                | 423 `DESIGN_NOT_CONSISTENT`  |
| blocked      | 200                | 423 `DESIGN_NOT_CONSISTENT`  |

`GET /status` 与 `GET /events` 对 admin/consumer **始终可读**（200），供下游轮询等待
闸门放开。admin 的 working view 与 history 不受 423 影响。

## 4. 分页与游标

- 列表接口（`GET /query`、`GET /workflows`）使用不透明 cursor 分页：
  请求带 `cursor`（上一次响应的 `nextCursor`），响应带 `nextCursor`
  （`null` 表示没有更多）。cursor 对客户端不透明，不得解析或构造。
- `limit` 缺省与上限：`GET /query` 默认 50、上限 200；`GET /workflows` 默认 20、上限 100。
- `GET /events` 使用单调递增事件 id 做增量同步：`after=<lastSeenEventId>`，
  返回 id 严格大于 after 的事件，按 id 升序，最多 `limit` 条（默认 100，上限 1000）。

## 5. 视图语义

`tree` / `query` / `nodes/:id` / `nodes/:id/relations` 接受 `view` 参数：

- `view=release`：当前已发布 Release 的快照（只读）。
- `view=working`：admin 工作视图——Release 基线叠加 live ChangeSet 中已 adopt 的
  候选修订后的投影。

`view` 参数为**必填**（无默认值），避免客户端误读视图。consumer 传
`view=working` 一律 403。

## 6. Route 清单

schema 名称均指 `packages/contracts/src/schemas/` 中的导出。响应均包裹在
§1 的成功信封中，下表 `Response` 列指 `data` 字段的 schema。

### 6.1 健康与项目

| Method | Path       | Scope | Query/Body | Response                      | 备注              |
| ------ | ---------- | ----- | ---------- | ----------------------------- | ----------------- |
| GET    | `/health`  | 公开  | —          | `HealthResponseSchema`        | `{ ok, version }` |
| GET    | `/project` | admin | —          | `ProjectSummarySchema`        |                   |
| GET    | `/status`  | 两者  | —          | `ProjectStatusResponseSchema` | consumer 始终可读 |

### 6.2 Source

| Method | Path           | Scope | Body/Params                 | Response                  | 备注                                                                                          |
| ------ | -------------- | ----- | --------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| POST   | `/sources`     | admin | `CreateSourceRequestSchema` | `SourceAssetSchema` (201) | 仅 text/markdown；默认上限 2 MiB（`TREEDIAGRAM_MAX_SOURCE_BYTES` 可下调，不可无限）；超限 400 |
| GET    | `/sources`     | admin | —                           | `SourceAssetMetaSchema[]` | 列表不含正文                                                                                  |
| GET    | `/sources/:id` | admin | `IdParamsSchema`            | `SourceAssetSchema`       | 含正文                                                                                        |

### 6.3 树与查询

| Method | Path                   | Scope | Query                      | Response                      | 备注                                                           |
| ------ | ---------------------- | ----- | -------------------------- | ----------------------------- | -------------------------------------------------------------- |
| GET    | `/tree`                | 两者* | `TreeQuerySchema`          | `TreeResponseSchema`          | `view` 必填；`parentNodeId=null` 表示根层；`depth` 1–10 默认 1 |
| GET    | `/query`               | 两者* | `QueryNodesQuerySchema`    | `QueryNodesResponseSchema`    | `text` 走 FTS；cursor 分页                                     |
| GET    | `/nodes/:id`           | 两者* | `NodeViewQuerySchema`      | `NodeDetailSchema`            | `view` 必填                                                    |
| GET    | `/nodes/:id/history`   | admin | —                          | `NodeHistoryResponseSchema`   | 全部修订，含已归档                                             |
| GET    | `/nodes/:id/relations` | admin | `NodeRelationsQuerySchema` | `NodeRelationsResponseSchema` | `direction` 默认 both                                          |

\* consumer 仅限 `view=release` 且 project=consistent（见 §2.2、§3.3）。

### 6.4 候选节点/关系（写）

| Method | Path                       | Scope | Body                          | Response                     | 备注                                                            |
| ------ | -------------------------- | ----- | ----------------------------- | ---------------------------- | --------------------------------------------------------------- |
| POST   | `/nodes`                   | admin | `CreateNodeRequestSchema`     | `NodeDetailSchema` (201)     | 创建候选节点（进 live ChangeSet，无则开启）                     |
| POST   | `/nodes/:id/revisions`     | admin | `ReviseNodeRequestSchema`     | `NodeDetailSchema` (201)     | `baseRevisionId` 必须为当前 tip，否则 409 `STALE_BASE_REVISION` |
| POST   | `/nodes/:id/archive`       | admin | —                             | `NodeSchema` (200)           | 逻辑归档，历史可溯                                              |
| POST   | `/relations`               | admin | `CreateRelationRequestSchema` | `RelationDetailSchema` (201) | 端点经端点矩阵校验，违反 422 `RELATION_ENDPOINT_INVALID`        |
| POST   | `/relations/:id/revisions` | admin | `ReviseRelationRequestSchema` | `RelationDetailSchema` (201) | 同上                                                            |
| POST   | `/relations/:id/archive`   | admin | —                             | `RelationSchema` (200)       | 逻辑归档                                                        |

**禁止 HTTP DELETE 物理删除节点/关系**；对节点/关系路径的 DELETE 返回 404。

### 6.5 ChangeSet

| Method | Path                        | Scope | Body                             | Response                         | 备注                                                                                                                         |
| ------ | --------------------------- | ----- | -------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/change-set/current`       | admin | —                                | `ChangeSetCurrentResponseSchema` | 无 live ChangeSet 时 `data.changeSet=null`                                                                                   |
| GET    | `/change-set/review-items`  | admin | —                                | `ReviewItemsResponseSchema`      |                                                                                                                              |
| POST   | `/change-set/adopt`         | admin | —                                | `ChangeSetCurrentResponseSchema` | 候选修订生效进 working view；产生 review items；可能置 project=blocked                                                       |
| POST   | `/change-set/abandon`       | admin | —                                | `ChangeSetCurrentResponseSchema` | 放弃 live ChangeSet 全部候选                                                                                                 |
| POST   | `/change-set/check`         | admin | —                                | `CheckConsistencyResponseSchema` | 运行一致性检查器，不落库状态迁移                                                                                             |
| POST   | `/change-set/publish`       | admin | `PublishReleaseRequestSchema`    | `ReleaseSchema` (201)            | 仅 checker 通过且 status=ready；违反 422 `DESIGN_INCONSISTENT` / 409 `INVALID_STATE_TRANSITION`；UI 不得提供隐藏参数强制发布 |
| POST   | `/review-items/:id/resolve` | admin | `ResolveReviewItemRequestSchema` | `ReviewItemSchema`               |                                                                                                                              |
| POST   | `/review-items/:id/block`   | admin | `BlockReviewItemRequestSchema`   | `ReviewItemSchema`               |                                                                                                                              |

### 6.6 托管（Delegation）

| Method | Path                    | Scope | Body                         | Response                     | 备注                         |
| ------ | ----------------------- | ----- | ---------------------------- | ---------------------------- | ---------------------------- |
| GET    | `/nodes/:id/delegation` | admin | —                            | `DelegationResolutionSchema` | 解析后的有效托管（沿祖先链） |
| PUT    | `/nodes/:id/delegation` | admin | `SetDelegationRequestSchema` | `DelegationPolicySchema`     | 幂等设置本节点策略           |
| DELETE | `/nodes/:id/delegation` | admin | —                            | 204 无 body                  | 仅撤销策略，不删除历史记录   |

### 6.7 Workflow

| Method | Path                    | Scope | Body/Query                   | Response                             | 备注                                                      |
| ------ | ----------------------- | ----- | ---------------------------- | ------------------------------------ | --------------------------------------------------------- |
| POST   | `/workflows`            | admin | `StartWorkflowRequestSchema` | `WorkflowRunSchema` (202)            | 已有 running/paused run 时 409 `WORKFLOW_ALREADY_RUNNING` |
| GET    | `/workflows/:id`        | admin | —                            | `WorkflowRunSchema`                  |                                                           |
| POST   | `/workflows/:id/resume` | admin | —                            | `WorkflowRunSchema` (202)            | 非 paused/failed 时 409 `WORKFLOW_NOT_RESUMABLE`          |
| POST   | `/workflows/:id/cancel` | admin | —                            | `WorkflowRunSchema` (200)            |                                                           |
| GET    | `/workflows`            | admin | `WorkflowListQuerySchema`    | `WorkflowRunSchema[]` + `nextCursor` | cursor 分页                                               |

`WorkflowRun.checkpoint.modelCalls` 是管理员诊断轨迹：provider 请求发出前即追加 running
记录，完成/失败/取消时原位补齐终态、最终结构化响应、responseId 与 usage。请求和响应只保存
脱敏、限长预览；密钥字段不回显，长 `contentText` 单字段截断，且不包含 provider 内部 reasoning。
它是工作区本地 checkpoint 数据，不写入 Pino 请求日志，也不向 consumer 开放。
单个 WorkflowRun 最多保留最近 50 条模型调用轨迹。

### 6.8 下游 Release 与事件

| Method | Path               | Scope | Query               | Response                       | 备注                                                 |
| ------ | ------------------ | ----- | ------------------- | ------------------------------ | ---------------------------------------------------- |
| GET    | `/release/current` | 两者  | —                   | `ReleaseCurrentResponseSchema` | 闸门见 §3.3；无已发布 Release 时 `data.release=null` |
| GET    | `/events`          | 两者  | `EventsQuerySchema` | `EventsResponseSchema`         | 增量同步，见 §4                                      |

## 7. 实现约束

- 路由注册顺序：鉴权 preHandler 先于 schema 校验；schema 校验失败返回 400
  `VALIDATION_FAILED`，details 中给出 ajv 错误数组（不含输入原文中的设计正文）。
- 所有写路由在单个 SQLite 事务内完成「领域校验 → 写入 → 事件追加」；
  事件追加与状态变更同事务提交，不存在无事件的状态迁移。
- 响应序列化以 schema 为准：不在 schema 中的字段不得泄露（尤其内部 id 映射、
  token 哈希、模型 prompt/响应原文）。
- 请求体大小上限：默认 1 MiB（source 上传单独按 §6.2 限制），超限返回 400。
