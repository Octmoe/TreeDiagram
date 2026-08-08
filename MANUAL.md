# TreeDiagram 使用手册

面向使用者的完整指南：概念、快速上手、五个 Agent 工作流的用法、发布生命周期、
AI 托管、下游集成与故障处理。实现细节以 [V1_SPEC](./V1_SPEC.md) 与
[API 契约](./docs/API_CONTRACT.md) 为准；安装与配置见 [README](./README.md)。

---

## 1. 这套系统是什么

TreeDiagram 帮你把一个模糊的想法，逐步打磨成一棵**可查询、可审计、可发布**的设计树：

- 你（用户）和 AI Agent 共同编辑同一份设计；
- 一切修改都是**候选（candidate）**，不会直接污染已发布的稳定版本；
- 每个稳定版本叫 **Release**，下游系统只读 Release；
- Agent 可以初始化、推导、挑刺、换视角、做全树复核——但**永远不能**替你确认根部、
  不能越出你授权的托管子树、不能跳过复核直接发布。

## 2. 核心概念速览

| 概念                     | 一句话说明                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **节点（Node）**         | 设计的最小单元：`goal/constraint/claim/topic/question/option/decision/risk/evidence/validation_method` 十种类型 |
| **关系（Relation）**     | 节点间的语义边：`contains`（树结构）+ `supports/contradicts/addresses/selects/rejects/depends_on/...`           |
| **修订（Revision）**     | 节点的每次修改都产生新修订，历史永不覆盖                                                                        |
| **ChangeSet**            | 收集候选的"暂存区"，同一时刻只有一个 live ChangeSet                                                             |
| **root 角色**            | 设计的根基命题，永远只能由**用户**确认                                                                          |
| **审批状态**             | `draft → tentative → ai_confirmed / user_confirmed`，Agent 最高只能到 `ai_confirmed`                            |
| **认知状态**             | `assumed`（假设）/ `supported`（有证据）/ `refuted`（已证伪），仅 claim/constraint/risk 有                      |
| **复核项（ReviewItem）** | adopt 后系统列出的"受影响清单"，逐项裁决后才能发布                                                              |
| **Release**              | 一致、只读、可下游消费的快照；版本号递增                                                                        |
| **Project 状态**         | `initializing → consistent ⇄ reevaluating / blocked`                                                            |

## 3. 快速开始（10 分钟）

```bash
npm ci && npm start
```

1. 首次运行会自动初始化 `./workspace` 并提示 token 文件路径；
2. 把 `<workspace>/.treediagram/model.json` 配上 API key（见 README「模型配置」），
   或先用 `npm start -- --fake` 离线体验；
3. 打开 `http://127.0.0.1:4317/`，粘贴 **admin token** 进入编辑器；
4. 在 WorkflowPanel 选择 `initialize`，多选上传描述想法的 source 文件（可追加/移除），点「启动」；
5. 确认根部 → Adopt → 复核 → Publish，得到 Release 1。

## 4. 编辑器界面导览

| 区域                          | 功能                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| **TokenGate**                 | 启动页，粘贴 admin token                                                   |
| **TreePanel（左）**           | 按 Release/Working 视图浏览设计树，点击选中节点                            |
| **Inspector（中）**           | 选中节点的详情：概览 / 编辑（保存即产生候选修订）/ 历史 / 关系（入边出边） |
| **ChangeSetDrawer（右抽屉）** | live ChangeSet 状态、一致性预览、复核项裁决、Adopt / Abandon / Publish     |
| **WorkflowPanel（下）**       | 选择工作流类型 + focus 指令 → 启动；查看运行状态/步骤/摘要；取消在途运行   |

常用操作路径：

- **新建/修改节点**：Inspector 编辑 → 保存（写入候选，Release 不受影响）；
- **归档节点**：Inspector「归档」按钮（逻辑删除，非物理删除）；
- **查看候选与发布的差异**：ChangeSetDrawer → 一致性预览；
- **发布**：ChangeSetDrawer → Adopt → 逐项复核 → 自动 ready → 填摘要 → Publish。

## 5. 工作流详解

通用规则：

- 同一时刻只允许一个进行中的 WorkflowRun；
- 每次运行都显示**当前步骤**与**检查点**；失败/中断后可从本地 checkpoint 续跑；
- Agent 产出一律进入候选 ChangeSet，**不自动发布**（ai_managed 例外，见 §7）；
- 启动方式：WorkflowPanel 选类型、（derive/grill 需要先在树上选中目标节点）、
  可选填 focus 指令 →「启动」。对应 API：`POST /api/v1/workflows`。

### 5.1 Initialize — 从零冷启动

| 项             | 说明                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| **用途**       | 把一段原始描述变成初版设计树：提取命题 + 提出根部候选                            |
| **可用条件**   | project = `initializing`（全新工作区只有一次）                                   |
| **输入**       | 至少一个 source（`POST /api/v1/sources`，markdown 文本）                         |
| **产出**       | root 角色候选（tentative）+ 普通候选 + contains 结构；未确认细节保留为 `assumed` |
| **之后做什么** | 检查根部 → 把它 revise 成 `user_confirmed` → Adopt → 复核 → Publish Release 1    |

> UI 入口：WorkflowPanel 选择 `initialize` 后出现 source 暂存区——可多次多选追加
> markdown/纯文本文件、在列表中查看并移除（同名同大小自动去重）；启动时逐个上传
> 并以 `sourceAssetIds` 启动。空列表启动会被客户端拦截提示。

### 5.2 Derive — 顺向推导

| 项             | 说明                                                      |
| -------------- | --------------------------------------------------------- |
| **用途**       | 围绕选中节点展开：子命题、Option、Decision、约束分解      |
| **可用条件**   | project = `consistent`；需要目标节点                      |
| **产出**       | tentative 候选（节点 + 关系），挂在目标节点下             |
| **之后做什么** | 人工审查候选，保留/修改/归档，下一轮 Adopt 时统一进入复核 |

### 5.3 Grill — 对抗性审查

| 项             | 说明                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| **用途**       | 对选中子树"挑刺"：证据不足点、遗漏风险、跨分支张力（contradicts）                                      |
| **可用条件**   | project = `consistent`；需要目标节点                                                                   |
| **产出**       | question / risk / evidence / contradicts 候选；**revise 一律强制 draft**（Grill 无权直接改已确认内容） |
| **之后做什么** | 处理它提出的问题：补充证据、回答 question、化解或接受 contradicts                                      |

### 5.4 Unbox — 跳出边界

| 项             | 说明                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| **用途**       | 暂时拿掉若干约束，生成"如果……会怎样"的平行方向                                                        |
| **可用条件**   | project = `consistent`；无需目标节点；建议填 focus 指令（如"如果不是单机呢"）                         |
| **产出**       | 自动创建 `unbox_exploration` 容器（draft），替代方向挂在容器下；**root 角色会被剥离**，绝不自动 adopt |
| **之后做什么** | 对比替代方向；有价值的部分人工挑回主树                                                                |

### 5.5 Re-evaluate — 全树复核

| 项             | 说明                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **用途**       | adopt 之后，逐项复核受影响内容：仍有效（valid）、需修订（revise）、已证伪（refute）、被替代（supersede）；关系端点失效时**显式迁移**到新修订（绝不静默迁移） |
| **可用条件**   | live ChangeSet = `reevaluating`（或 project = `blocked`）；通常紧随 adopt                                                                                    |
| **产出**       | 分批裁决 + 迁移/替代修订；全部解决且一致性检查通过 → ChangeSet 自动 `ready`                                                                                  |
| **之后做什么** | 若有 `unknown` 裁决 → 复核项转 blocked，运行进入 `waiting_user`，人工裁决后 resume；ready 后 Publish                                                         |

## 6. 发布生命周期（最重要的一条主线）

```
编辑/Agent 写入候选（ChangeSet = open）
        │  Adopt（用户，或 ai_managed 自动）
        ▼
design.invalidated 事件；ChangeSet = reevaluating；下游读取 423 锁定
        │  Re-evaluate（Agent 分批复核）+ 人工裁决
        ▼
全部复核项解决 + 一致性检查通过 → ChangeSet = ready
        │  Publish（填 Release 摘要）
        ▼
Release N 发布；release.published 事件；下游闸门放开
```

关键性质：

- **候选不影响 Release**：发布前下游看到的永远是上一个稳定版本；
- **关系不静默迁移**：端点修订后，旧关系必须先显式迁移才能通过一致性检查；
- **根部变化触发全树复核**：改 root = 整棵树进复核集；
- **Publish 与事件是同一事务**：不会出现"Release 发了但事件丢了"。

## 7. AI 托管（ai_managed）

适合"这个分支我放心交给 Agent"的场景：

1. 在目标子树根节点上设置托管策略：`PUT /api/v1/nodes/:id/delegation`（`mode: ai_managed`；
   默认所有分支都是 `human_final`）；
2. Agent 在该子树内运行时可以把节点/关系确认为 `ai_confirmed`（记录 run ID + 策略 ID）；
3. 提案的影响闭包**完全在子树内** → 运行结束自动 Adopt 并进入 Re-evaluate；
   **越出子树** → 自动 Adopt 被拦下，运行转 `waiting_user` 等你裁决；
4. 铁律：AI 永远不能确认/修改 root，不能 `user_confirmed`，不能 Publish。

随时可撤销策略；历史 `ai_confirmed` 修订仍可追溯到当时的授权。

## 8. 复核项裁决语义

| 裁决               | 含义                                                              |
| ------------------ | ----------------------------------------------------------------- |
| `valid`            | 内容仍然成立（关系端点失效时需附带迁移）                          |
| `revise`           | 需要修订，系统已/将生成替代修订                                   |
| `refute`           | 已证伪，标记 `refuted`                                            |
| `supersede`        | 被新修订替代                                                      |
| `unknown`（block） | 无法判断 → 复核项 blocked，project 可能进入 blocked，需要人工介入 |

ChangeSetDrawer 里 pending 项有四个裁决按钮 + block；blocked 项可"解除阻塞（valid）"。
全部 pending/blocked 清零且一致性检查通过时，ChangeSet 自动转 ready。

## 9. 下游集成（consumer token）

```bash
# 轮询等待新 Release
GET /api/v1/events?after=<cursor>     # 始终可读；watch release.published
GET /api/v1/status                    # 始终可读
# 闸门放开（consistent）后读取
GET /api/v1/release/current
GET /api/v1/tree?view=release&depth=3
GET /api/v1/query?view=release&type=decision
```

- `reevaluating/blocked` 期间 release 读取返回 **423 `DESIGN_NOT_CONSISTENT`**——
  下游只需继续轮询 events；
- working 视图/历史/写接口对 consumer 一律 403，没有绕过路径。

## 10. 异常与恢复

| 情况            | 现象                                                    | 处理                                            |
| --------------- | ------------------------------------------------------- | ----------------------------------------------- |
| 模型问你问题    | run = `waiting_user`（summary 含 questionsForUser）     | 回答问题相关事项后 `POST /workflows/:id/resume` |
| 复核项 unknown  | 复核项 blocked，run = `waiting_user`                    | Drawer 里人工裁决后 resume                      |
| 自动 Adopt 越界 | run = `waiting_user`（autoAdoptBlocked）                | 人工 Adopt 或取消 run                           |
| 模型输出不合法  | run = `failed`（MODEL_OUTPUT_INVALID）                  | resume 会复用 checkpoint 重试或重新生成         |
| 服务进程重启    | 遗留 running run 自动标记 `failed(PROCESS_INTERRUPTED)` | resume 从本地 checkpoint 幂等续跑               |
| 不想继续        | —                                                       | 「取消」（不回滚已写入的提案，候选可再归档）    |
| 未配置模型      | 启动工作流 422 `MODEL_NOT_CONFIGURED`                   | 配 `model.json` / `OPENAI_API_KEY`，或 `--fake` |

> 提示：resume 目前走 API（`POST /api/v1/workflows/:id/resume`）；UI 面板展示状态与摘要。

## 11. 常见问题

**Q：Agent 改坏了怎么办？**
已发布内容永远不会被改坏——Agent 只写候选。Abandon 当前 ChangeSet 即回到上一个 Release。

**Q：为什么 adopt 后发布不了？**
还有 pending/blocked 复核项，或一致性检查有 blocking 问题（Drawer → 一致性预览查看具体条目）。

**Q：为什么关系报了"端点必须指向活动修订"？**
你修订了关系的端点节点。跑 Re-evaluate（或人工 revise 该关系）把端点显式迁到新修订。

**Q：模型配置错了启动不了？**
启动日志会给出带文件路径的具体错误（未知字段/非法 URL/缺少 apiKey 等），按提示修正 `model.json`。

**Q：数据在哪、怎么备份？**
全部在 `<workspace>/.treediagram/`。停服务后复制 `state.sqlite` + `workspace.json` 即完成备份。
