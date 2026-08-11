# TreeDiagram V2 使用手册

本手册面向源码安装用户，覆盖 Codex 插件安装、项目初始化、日常设计协作、GUI 审批、后台服务、数据备份和故障排查。

当前版本：`2.0.0-alpha.1`。

## 1. 先理解三个边界

TreeDiagram 不是另一个聊天机器人，也不自行调用模型。

1. **Codex/Agent 负责思考**：理解你的目标、追问、推导并调用工具。
2. **TreeDiagram 负责持久状态**：保存 Working State、候选变更、关系、Attention 与 Release。
3. **人负责高权限决定**：采用候选、确认根节点、接管写 lease 和发布 Release 都需要明确授权。

聊天中的一句“同意”不会直接改写设计树。Agent 必须提交结构化候选，你再在 GUI 中审查。

## 2. 环境要求

- Windows 10/11 为当前主要验证平台；
- Node.js 24 或更高版本；
- npm；
- Codex Desktop 或 Codex CLI；
- Git，用于获取和更新源码。

检查环境：

```powershell
node --version
npm --version
git --version
codex --version
```

如果系统找不到 Node.js、Git 或 Codex，先安装缺失依赖。不要让自动化脚本覆盖系统中已有的自定义安装。

## 3. 安装

### 3.1 让 Codex AI 安装

在 Codex 新任务中粘贴：

```text
请帮我安装 TreeDiagram V2：
1. 如果本机还没有源码，把 https://github.com/Octmoe/TreeDiagram 克隆到合适的开发目录；
2. 阅读仓库 README.md 和 MANUAL.md；
3. 检查 Node.js 24+、npm 与 Codex CLI；
4. 在仓库运行 npm.cmd run install:codex；
5. 验证 marketplace 和 treediagram 插件安装成功。
不要删除任何已有项目的 .treediagram 数据。遇到 Hook 信任、权限提升或系统级依赖安装时暂停让我确认。
```

AI 可以执行 Git、npm 和 Codex CLI，但操作仍受当前 Codex sandbox、审批策略与系统权限约束。TreeDiagram 的 `SessionStart` Hook 会运行本地命令，首次启用时应由你审查并信任。

### 3.2 手动安装

```powershell
git clone https://github.com/Octmoe/TreeDiagram.git
cd TreeDiagram
npm.cmd run install:codex
```

安装命令会：

1. 检查源码版本和依赖；
2. 在需要时运行冻结依赖安装；
3. 构建 V2 packages、Sidecar 与 UI；
4. 生成仅用于本机的 MCP 配置；
5. 注册仓库 marketplace；
6. 安装 `treediagram` 插件；
7. 恢复干净的源码 manifest，避免 cachebuster 污染 Git 工作区。

安装可能访问 npm registry。若已有 Sidecar 锁定 Windows 原生 SQLite DLL，脚本会尽量复用精确依赖；确实需要重装时会提示你先停止相关进程。

### 3.3 Codex CLI 不可用时

先准备运行时：

```powershell
npm.cmd run install:codex -- --no-codex
```

再到能够运行 Codex CLI 的终端执行：

```powershell
codex plugin marketplace add .
codex plugin add treediagram@treediagram-local
```

### 3.4 安装后的必要动作

1. 在 Codex 插件浏览器中确认 TreeDiagram 已安装且启用；
2. 审查并信任 `SessionStart` Hook；
3. **新建一个 Codex 任务**。

插件的 Skills、MCP 工具与 Hook 只会在安装后的新任务或新 CLI session 中加载。Codex CLI 可输入 `/plugins` 打开插件浏览器。

## 4. 第一次初始化项目

不要在 TreeDiagram 源码目录中替其他产品建立设计树。应先在 Codex 中打开真正要设计的目标项目。

新建任务后，Hook 会：

1. 把任务的 `cwd` 识别为项目根目录；
2. 创建或读取 `<项目>/.treediagram/workspace.json`；
3. 启动或复用该项目独立的 Sidecar；
4. 把包含动态端口和当前 session 的 GUI URL 注入任务上下文；
5. 让 stdio MCP 与 Sidecar 指向同一个 workspace。

然后对 Agent 说：

```text
请使用 TreeDiagram 初始化这个项目，把下面的想法整理成一个小而可审查的根设计：
<你的项目目标、用户、约束和当前不确定性>
```

Initialize 应只提出少量根部候选，不应一次生成整棵巨大设计树。你可以要求 Agent 缩小范围或分批提交。

如果目标不是从零设计，而是梳理已经存在的复杂实现、规格或产品形态，可以直接说：

```text
请使用 TreeDiagram Initialize 的已有复杂设计梳理模式。先从总体结构拆分，再分轮细化；补出只有结论部分可能缺失的假设与设计思路，并明确标记哪些内容是推测。最后标出矛盾、违反约束以及问题产生和缓解关系。
```

这个模式允许形成较完整的候选树，但仍按父级优先顺序分批写入：先总体结构，再细节拆分，再补推理链，最后进行整树问题复核。直接来自代码、文档或用户说明的事实会与 Agent 重建的假设分开；重建假设默认是待确认、认知状态为“假设”、复核状态为“需要复核”。

## 5. 日常与 Agent 协作

TreeDiagram 提供七个 Skills。

| Skill       | 什么时候使用               | 预期结果                             |
| ----------- | -------------------------- | ------------------------------------ |
| Initialize  | 新项目，或梳理已有复杂设计 | 建立小根设计，或多轮重建现有设计结构 |
| Derive      | 继续展开当前分支           | 提出子节点、关系或更精确的约束       |
| Grill       | 希望 AI 分轮追问你         | 先澄清隐含决定，经你确认后再形成候选 |
| Check       | 希望一次性审计当前焦点     | 返回证据缺口、矛盾、弱决策和风险     |
| Refactor    | 单个或整树复合节点需要拆分 | 拆出原子子节点，并交叉复核整棵树     |
| Unbox       | 当前方向过早收敛或过于普通 | 暴露框架假设，提出真正不同的方向     |
| Re-evaluate | 已采用变更影响旧结论       | 复查受影响节点并提出局部修复         |

可以直接自然语言调用：

```text
请围绕我在 TreeDiagram 中选中的节点继续 derive。
```

```text
Grill me：分轮追问我当前选中的方案，先不要写入候选。
```

```text
请 check 当前选中的候选，给出问题清单，不要修改设计。
```

```text
请 refactor 当前选中的复合节点，拆分时同步交叉复核整棵设计树。
```

```text
请 refactor 整棵设计树，拆分所有高置信复合节点；不明确的只报告。
```

如果想明确指定 Skill，也可以在支持的界面中使用 `@` 选择 TreeDiagram 或对应 Skill。

### 从快速推导转入结构化拆分

前期允许一个节点承载较粗的想法，以减少记录成本。节点变长本身不是拆分理由；当其中的两个以上部分需要独立批准、证据、约束、依赖或修改历史时，再使用 Refactor。

Refactor 默认一次只处理一个复合节点：保留原节点作为稳定的上位概括，拆出最多三个可独立审查的子节点，重接只属于某个子项的关系，并把投影后的结构与全部 Working 节点、关系和待处理候选交叉比较。发现不确定的重复或冲突时只报告，不会一次制造大量修复候选。

需要集中整理时，可以点击页面顶部的 **AI 整树拆分**。该模式只需发出一次 Agent 指令：它会扫描全部 Working 节点与待处理候选，按父级优先顺序逐个处理高置信复合节点，并在每个源节点后基于更新的投影树重新交叉复核。整树模式意味着用户明确接受较多候选，因此不设全树候选数量上限；候选仍显示在对应父节点下，并继续遵守父节点批准后子节点才能批准。语义不明确的节点不会被强行拆分，而是汇总为待确认项。

## 6. GUI 导览

Sidecar 默认是三栏工作台：

- **左栏：设计树**
  浏览 Working 节点、搜索、多选、查看候选投影和关系提示。
- **中栏：节点详情**
  查看正文、属性、历史、关系、根节点状态与 Attention 信息。
- **右栏：Working State**
  查看活动 ChangeSet、候选差异、审批依赖、采用/修订/丢弃、校验和发布。

顶部 Shared Focus 显示当前主焦点、已选数量、固定数量和 Agent 状态。界面支持深色与亮色主题。

顶部还提供两个整树级 AI 提示入口：**AI 梳理已有设计** 调用 Initialize 的重建模式，**AI 整树拆分** 调用 Refactor 清理已经进入设计树的复合节点。它们只复制明确的宿主聊天提示，不会在网页内部运行模型。

## 7. 选择节点与“Agent 可见”

点击 Working 节点或候选节点会更新 Attention，但不会自动调用模型。

“Agent 可见”准确含义是：

1. GUI 把选择写入该项目的共享 Attention；
2. Agent 调用 `attention_get` 读取 `primaryNodeId` 或 `primaryChangeId`；
3. Agent 再调用 `design_context_get` 获取完整结构化上下文。

候选和 Working 节点都可以成为主焦点。按住 Ctrl/⌘ 可以多选，用于比较或扩大读取范围。

新任务不会静默继承旧任务焦点。界面会提供可恢复焦点，只有你明确恢复后才复制到新 session。为处理浏览器标签页与 Codex session 不一致的情况，Agent 读取时也会解析同一项目最近一次明确的 Sidecar 选择。

## 8. 候选如何出现在树中

同一 ChangeSet 中尚未采用的候选节点，会依据候选 `contains` 关系投影到预期父节点下，并显示虚线与候选徽标。

- 能解析父节点：显示在对应树位置；
- 暂时没有父节点：显示在“待定位”区域；
- `supports`、`depends_on`、`constrains` 等普通语义关系显示关系数量提示；
- 问题关系使用明确方向：`contradicts`（矛盾）、`violates`（违反约束）、`causes`（导致问题）、`amplifies`（加剧）、`mitigates`（缓解）、`reveals`（由证据揭示）；
- 聚焦关系卡时，树会分别高亮起点和终点。

候选投影只是预览，不属于 Working State，也不会出现在已发布 Release 中。

## 9. 审批规则

审批遵循自上而下的单一路径：

1. 根候选可以直接批准；
2. 子候选只有在其唯一父节点已经进入 Working State 后才能批准；
3. 指向新子节点的 `contains` 随子节点一起批准或丢弃；
4. `supports`、`depends_on`、`constrains` 等语义关系单独审查；
5. 还有任何未处理候选时，不允许校验或发布。

这样可以避免用户同时理解“节点是否采用”和“它挂在哪里”两张审批卡。

高权限按钮使用短时、目标绑定、版本绑定、单次消费的 ApprovalGrant。不要复制、长期保存或复用授权 token。

## 10. ChangeSet 与 Release

一个 workspace 同时只有一个活动 ChangeSet。

典型流程：

```text
Agent 或用户建立 ChangeSet
  → 提出小批候选
  → 用户逐项采用、修订或丢弃
  → 全部候选处理完
  → 确定性校验
  → 用户发布 Release
```

Working State 是当前采用后的设计事实；Release 是不可变快照。候选不会污染上一个 Release。

写 lease 是可恢复的单写者租约，而不是永久锁：

- 当前会话每次成功写入都会续租；
- 两小时没有续租，或 lease 来自上一次系统启动时，它会变为 `reclaimable`；
- 新会话调用 `changeset_begin` 会原子接手这个过期 lease，保留原 ChangeSet、版本和全部候选；
- 仍然有效的 `foreign_active` lease 不能被 Agent 绕过。Agent 调用 `changeset_lease_handoff_request` 后，Sidecar 会显示请求用途和请求方；用户点击“交给此 Agent”才会签发并消费一次性授权、转移 lease。

Sidecar 会把过期 lease 显示为“旧会话写入权已失效”，与仍活跃的其他会话明确区分。

正常交接不需要修改 Sidecar URL，也不需要把 owner ID 复制给 Agent：

1. Agent 发现 `foreign_active`，创建 15 分钟有效的交接请求并暂停写入；
2. Sidecar 显示“Agent 请求写入权”、用途和请求方；
3. 用户点击“交给此 Agent”；
4. Agent 重新读取 `design_changeset_get`，确认 `leaseStatus.state = owned` 后继续。

请求会绑定申请时的 ChangeSet 版本和 lease owner。等待期间任一者变化，旧请求立即失效，Agent 必须重新读取并申请。

## 11. Sidecar 服务生命周期

Sidecar 是按项目运行的 loopback 后台进程：

- 只绑定 `127.0.0.1`；
- 关闭浏览器不会停止；
- 关闭单个 Codex 任务或 MCP 连接不会停止；
- 再次打开同一项目会健康检查并复用；
- 本地插件 generation 变化时会停止旧 Sidecar，并以相同项目数据启动更新后的进程；
- 电脑关机、进程退出或显式 Stop 会停止；
- 服务停止不会删除设计数据。

页面右上角的 **工作区操作** 菜单提供：

- **关闭工作区**：弹窗说明影响后停止当前 Sidecar，完整保留 `.treediagram`。稍后 Agent 再使用该项目时，可能自动触发启动流程；
- **归档并清空工作区**：先显示将要创建的绝对归档路径，并要求输入完整项目名称。确认后，Sidecar 退出，整个 `.treediagram` 被原子移动到 `<项目>/.treediagram-archive/<时间-工作区标识>/`。下次启动会建立新的空工作区。

“归档并清空”不会永久删除历史。完成页会再次显示归档路径；如需彻底删除，必须由用户稍后前往该路径手动删除。TreeDiagram 不提供远程或一键永久删除，以避免误操作。

查看状态：

```powershell
npm.cmd run treediagram:status -- --workspace H:\path\to\project
```

停止：

```powershell
npm.cmd run treediagram:stop -- --workspace H:\path\to\project
```

电脑重启后有两种恢复方式：

- 在目标项目中新建 Codex 任务，让 Hook 自动恢复；
- 不进入 AI，会话外直接打开现有设计树。

## 12. 不使用 AI，直接查看设计树

双击 TreeDiagram 源码根目录的 `Open TreeDiagram.cmd`，选择已有 `.treediagram` 的项目。

或运行：

```powershell
npm.cmd run treediagram:open -- --workspace H:\path\to\project
```

这个入口：

- 不启动 Codex；
- 不调用 Agent；
- 不运行 Initialize；
- 不创建新 ChangeSet；
- 拒绝没有现有 TreeDiagram workspace 的目录。

## 13. 项目隔离与数据位置

每个项目有自己的：

- `workspaceId`；
- `.treediagram/state-v2.sqlite`；
- `.treediagram/workspace.json`；
- Sidecar 端口和 `.treediagram/sidecar.json` 进程记录。

归档清空产生的历史位于该项目自己的 `.treediagram-archive/`，也不会与其他项目共享。

不同项目不会共享设计事实。同一项目的多个任务共享 Working State 和 Release，但 Attention 按宿主 session 管理，并需要显式恢复。

不要把一个项目的 `.treediagram` 目录复制到另一个正在使用的项目后同时启动两边。

## 14. 备份与恢复

备份前先停止项目 Sidecar：

```powershell
npm.cmd run treediagram:stop -- --workspace H:\path\to\project
```

然后复制整个 `<项目>/.treediagram/` 目录。恢复时放回原项目路径，再使用 Codex Hook 或 `treediagram:open` 启动。

不要只复制正在写入的 SQLite 主文件而遗漏 WAL/SHM 文件。

## 15. 更新、回滚与卸载

更新源码和插件：

```powershell
git pull
npm.cmd run update:codex
```

更新后必须新建任务。

回滚：

```powershell
git checkout <previous-tag>
npm.cmd run update:codex
```

卸载插件应在 Codex 的 `/plugins` 浏览器中完成。可先停止指定项目：

```powershell
npm.cmd run uninstall:codex -- --workspace H:\path\to\project
```

插件卸载和 Sidecar 停止都不会删除 `.treediagram`。

## 16. 独立运行与开发命令

构建并启动指定 workspace：

```powershell
npm.cmd run build
npm.cmd run workspace:init -- --workspace H:\path\to\project --name "My design"
npm.cmd start -- --workspace H:\path\to\project
```

填充演示数据是可选的：

```powershell
npm.cmd run seed:demo -- --workspace H:\path\to\project
```

手工启动 stdio MCP：

```powershell
$env:TREEDIAGRAM_WORKSPACE = "H:\path\to\project"
npm.cmd run mcp
```

开发本仓库插件：

```powershell
npm.cmd run try:codex
```

完整质量门禁：

```powershell
npm.cmd run release:verify
```

## 17. 常见问题

### 安装后看不到 Skills 或工具

先确认插件在 `/plugins` 中已安装并启用，然后新建任务。旧任务不会动态加载刚安装的插件内容。

### Hook 没有启动 Sidecar

确认：

- 当前任务打开的是目标项目目录；
- 已信任 TreeDiagram 的 `SessionStart` Hook；
- Node.js 24+ 可执行；
- 项目目录可写；
- 没有安全策略阻止本地命令。

也可以运行 `treediagram:open` 验证 Sidecar 本身是否可启动。

### 网页显示已选择，但 Agent 说没有焦点

1. 再点击一次目标 Working 节点或候选；
2. 确认网页和 Codex 打开的是同一个项目；
3. 要求 Agent 先调用 `attention_get`，再调用 `design_context_get`；
4. 若是新任务，先在界面确认恢复旧焦点。

“Agent 可见”不代表网页会主动向模型发送消息。

### 子候选的采用按钮不可用

先批准其父候选。父节点进入 Working State 后，子节点与它的 `contains` 挂载关系才能一起批准。

### 更新时出现 `better_sqlite3.node` 或 `EPERM`

Windows 正有进程使用 SQLite 原生 DLL。先停止相关项目的 Sidecar，必要时关闭仍使用旧运行时的 Codex 任务，再重新运行：

```powershell
npm.cmd run update:codex
```

### 电脑重启后网页打不开

端口不是固定的，旧书签可能失效。运行 `treediagram:open`，或在项目中新建 Codex 任务，让系统读取新的 Sidecar URL。

### 检测到旧格式 workspace

V2 会拒绝原地打开旧数据库，避免破坏数据。请在新目录初始化 V2；需要查看前代实现时使用 [归档入口](./ARCHIVE.md)。

## 18. 安全提醒

- TreeDiagram 不上传项目设计数据，但 npm 安装会访问配置的 registry。
- Sidecar 只监听 loopback，仍不应把动态端口转发到公网。
- 不要提交 `.treediagram`、SQLite 文件、`.mcp.json` 或 `runtime.local.json`。
- 不要绕过根节点确认、ApprovalGrant 或 lease 接管流程。
- Hook 与 MCP 继承 Codex 当前 sandbox 和审批策略，不拥有额外系统权限。

## 19. 进一步阅读

- [产品设计](./DESIGN_V2.md)
- [实现计划](./IMPLEMENTATION_PLAN_V2.md)
- [V2 精确契约](./docs/V2_CONTRACTS.md)
- [Hermes 兼容说明](./docs/HERMES_COMPATIBILITY.md)
- [发布指南](./docs/RELEASING.md)
- [OpenAI 官方插件说明](https://learn.chatgpt.com/docs/plugins)
