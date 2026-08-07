# TreeDiagram

TreeDiagram 是一个面向独立创作者的设计 Agent Harness。它以“树形主结构 + 语义关系图”维护长期、可查询、可由 Agent 操作的设计状态，并提供 Derive、Grill、Unbox 和 Re-evaluate 工作流。

当前阶段：**V1 设计基线完成，尚未开始实现。**

## 设计文档

- [V1 实现规格](./V1_SPEC.md)：首版范围、领域模型、工作流、架构、接口与验收标准；实现以此为准。
- [设计探索与决策记录](./DESIGN.md)：产品共识、决策依赖和逐轮推演历史。
- [详细实现设计](./IMPLEMENTATION_DESIGN.md)：固定技术栈、目录、数据库、领域服务、API、Agent、UI 与测试契约。
- [HTTP API 精确契约](./docs/API_CONTRACT.md)：逐路由权限、请求、响应、分页、错误与事件载荷。
- [M1–M5 总体计划](./IMPLEMENTATION_PLAN.md)：里程碑依赖、交付边界和完成定义；任务级拆分由执行 Agent 自行规划。

V1 严格止于设计，通过一致 Release、只读接口和持久变更事件与后续规划及实现框架衔接。
