import {
  APPROVAL_STATES,
  EPISTEMIC_STATES,
  NODE_TYPES,
  RELATION_TYPES,
  REVIEW_STATES,
} from '@treediagram/contracts';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  readOnly: boolean;
  approval?: 'required';
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false as const,
});
const string = { type: 'string' };
const integer = { type: 'integer', minimum: 0 };
const identity = {
  hostKind: string,
  hostSessionRef: string,
  clientRef: string,
};
const enumeration = (values: readonly string[]) => ({ enum: [...values] });
const openRecord = { type: 'object' as const, additionalProperties: {} };
const revisionContent = {
  displayTitle: { type: 'string', minLength: 1, maxLength: 240 },
  contentText: { type: 'string', maxLength: 50000 },
  roles: {
    type: 'array',
    items: { type: 'string', minLength: 1, maxLength: 64 },
    maxItems: 32,
    uniqueItems: true,
  },
  attributes: openRecord,
  approvalState: enumeration(APPROVAL_STATES),
  epistemicState: { anyOf: [enumeration(EPISTEMIC_STATES), { type: 'null' }] },
  reviewState: enumeration(REVIEW_STATES),
};
const changePayload = {
  description:
    'Payload shape depends on operation: create_node requires nodeType plus all revision content fields; revise_node requires all revision content fields; create_relation requires relationType, sourceNodeId, and targetNodeId; revise_relation requires rationale; remove operations require an empty object.',
  anyOf: [
    object({ nodeType: enumeration(NODE_TYPES), ...revisionContent }, [
      'nodeType',
      'displayTitle',
      'contentText',
      'roles',
      'attributes',
    ]),
    object(revisionContent, ['displayTitle', 'contentText', 'roles', 'attributes']),
    object(
      {
        relationType: enumeration(RELATION_TYPES),
        sourceNodeId: string,
        targetNodeId: string,
        rationale: { type: 'string', maxLength: 5000 },
        reviewState: enumeration(REVIEW_STATES),
      },
      ['relationType', 'sourceNodeId', 'targetNodeId'],
    ),
    object(
      {
        rationale: { type: 'string', maxLength: 5000 },
        reviewState: enumeration(REVIEW_STATES),
      },
      ['rationale'],
    ),
    object({}),
  ],
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'design_workspace_get',
    description: '读取 V2 workspace 摘要、Release 与一致性状态。',
    inputSchema: object({}),
    readOnly: true,
  },
  {
    name: 'design_tree_get',
    description: '读取 working 或 release 设计树与 contains 层级。',
    inputSchema: object({ view: { enum: ['working', 'release'] } }),
    readOnly: true,
  },
  {
    name: 'design_node_get',
    description: '读取单个节点的当前修订和直接关系。',
    inputSchema: object({ nodeId: string, view: { enum: ['working', 'release'] } }, ['nodeId']),
    readOnly: true,
  },
  {
    name: 'design_query',
    description: '按标题、正文或 role 搜索节点。',
    inputSchema: object({ query: string, view: { enum: ['working', 'release'] }, limit: integer }, [
      'query',
    ]),
    readOnly: true,
  },
  {
    name: 'design_relations_get',
    description: '读取全部关系或某个节点的直接关系。',
    inputSchema: object({ nodeId: string, view: { enum: ['working', 'release'] } }),
    readOnly: true,
  },
  {
    name: 'design_context_get',
    description:
      '按当前项目最近一次 Agent 可见 Attention 或显式节点范围装配上下文；即使 Sidecar 与 Agent 的任务会话标识不同，也会直接返回用户最后选中的候选变更。',
    inputSchema: object({
      ...identity,
      nodeIds: { type: 'array', items: string },
      maxTokens: { type: 'integer', minimum: 256, maximum: 32000 },
    }),
    readOnly: true,
  },
  {
    name: 'design_changeset_get',
    description:
      '读取活动或指定 ChangeSet、候选差异和 lease；传入当前 hostSessionRef 时会明确区分活跃外部 lease 与可安全恢复的过期 lease。',
    inputSchema: object({ changeSetId: string, hostSessionRef: string }),
    readOnly: true,
  },
  {
    name: 'design_impact_get',
    description: '计算节点变更的确定性影响闭包。',
    inputSchema: object({ nodeIds: { type: 'array', items: string, minItems: 1 } }, ['nodeIds']),
    readOnly: true,
  },

  {
    name: 'attention_get',
    description:
      '读取当前项目中用户最近明确标记为“Agent 可见”的节点与候选焦点。读取会跨同项目的 Codex 任务会话解析最新 Sidecar 选择，但绝不跨项目；Agent 在处理指向性请求前必须先调用，并优先遵循 primaryNodeId 或 primaryChangeId。',
    inputSchema: object(identity, Object.keys(identity)),
    readOnly: true,
  },
  {
    name: 'attention_set',
    description:
      '更新当前会话的 Agent 可见焦点，并成为该项目供 Agent 读取的最新共享焦点；只更新 Attention，不修改设计事实。',
    inputSchema: object(
      {
        ...identity,
        primaryNodeId: { type: ['string', 'null'] },
        primaryChangeId: { type: ['string', 'null'] },
        selectedNodeIds: { type: 'array', items: string },
        selectedChangeIds: { type: 'array', items: string },
        pinnedNodeIds: { type: 'array', items: string },
        scope: { enum: ['node', 'subtree', 'related', 'comparison'] },
        intentHint: { type: ['string', 'null'] },
        expectedVersion: integer,
      },
      Object.keys(identity),
    ),
    readOnly: false,
  },
  {
    name: 'attention_pin',
    description: '把节点固定到当前宿主会话上下文。',
    inputSchema: object(
      {
        ...identity,
        nodeIds: { type: 'array', items: string, minItems: 1 },
        expectedVersion: integer,
      },
      [...Object.keys(identity), 'nodeIds'],
    ),
    readOnly: false,
  },
  {
    name: 'attention_clear',
    description: '清空当前 Attention，不影响设计事实。',
    inputSchema: object({ ...identity, expectedVersion: integer }, Object.keys(identity)),
    readOnly: false,
  },
  {
    name: 'attention_agent_focus_set',
    description: '公开 Agent 本轮正在读取、提案或校验的位置；不记录私有推理。',
    inputSchema: object(
      {
        hostSessionRef: string,
        nodeIds: { type: 'array', items: string },
        phase: { enum: ['reading', 'proposing', 'validating', 'idle'] },
        summary: string,
        complete: { type: 'boolean' },
      },
      ['hostSessionRef', 'nodeIds', 'phase', 'summary'],
    ),
    readOnly: false,
  },

  {
    name: 'changeset_begin',
    description:
      '创建活动 ChangeSet 并获取当前宿主会话的单写者 lease；若现有 lease 已过期、属于上次系统启动或缺失，则保留全部候选并原子恢复，仍有效的其他会话 lease 不会被绕过。',
    inputSchema: object({ hostSessionRef: string, title: string, description: string }, [
      'hostSessionRef',
      'title',
    ]),
    readOnly: false,
  },
  {
    name: 'changeset_lease_handoff_request',
    description:
      '当活动 ChangeSet 由仍有效的其他会话持有时，向 Sidecar 创建短时、版本绑定的写入权交接请求；该请求本身不会转移 lease。',
    inputSchema: object({ hostSessionRef: string, changeSetId: string, purpose: string }, [
      'hostSessionRef',
      'changeSetId',
      'purpose',
    ]),
    readOnly: false,
  },
  {
    name: 'design_change_propose',
    description: '提出一个小步节点或关系候选；字段错误可修复，不直接改 Working State。',
    inputSchema: object(
      {
        hostSessionRef: string,
        changeSetId: string,
        expectedChangeSetVersion: integer,
        operation: {
          enum: [
            'create_node',
            'revise_node',
            'remove_node',
            'create_relation',
            'revise_relation',
            'remove_relation',
          ],
        },
        entityId: string,
        baseRevisionId: string,
        payload: changePayload,
        summary: string,
      },
      [
        'hostSessionRef',
        'changeSetId',
        'expectedChangeSetVersion',
        'operation',
        'payload',
        'summary',
      ],
    ),
    readOnly: false,
  },
  {
    name: 'design_change_revise',
    description: '修正现有 proposed 候选，不新增重复候选。',
    inputSchema: object(
      {
        hostSessionRef: string,
        changeId: string,
        expectedChangeSetVersion: integer,
        payload: changePayload,
        summary: string,
      },
      ['hostSessionRef', 'changeId', 'expectedChangeSetVersion', 'payload', 'summary'],
    ),
    readOnly: false,
  },
  {
    name: 'design_change_discard',
    description: '丢弃一个尚未采用的候选。',
    inputSchema: object(
      { hostSessionRef: string, changeId: string, expectedChangeSetVersion: integer },
      ['hostSessionRef', 'changeId', 'expectedChangeSetVersion'],
    ),
    readOnly: false,
  },
  {
    name: 'changeset_validate',
    description: '对已采用 Working State 运行确定性一致性检查。',
    inputSchema: object(
      { hostSessionRef: string, changeSetId: string, expectedChangeSetVersion: integer },
      ['hostSessionRef', 'changeSetId', 'expectedChangeSetVersion'],
    ),
    readOnly: false,
  },

  {
    name: 'changeset_adopt',
    description:
      '消费用户签发的 ApprovalGrant 并采用候选；采用新子节点时会原子采用其唯一 contains 挂载。',
    inputSchema: object({ hostSessionRef: string, changeId: string, approvalToken: string }, [
      'hostSessionRef',
      'changeId',
      'approvalToken',
    ]),
    readOnly: false,
    approval: 'required',
  },
  {
    name: 'design_release_publish',
    description: '消费目标绑定 Grant 并发布一致的 Working State。',
    inputSchema: object(
      { hostSessionRef: string, changeSetId: string, approvalToken: string, summary: string },
      ['hostSessionRef', 'changeSetId', 'approvalToken'],
    ),
    readOnly: false,
    approval: 'required',
  },
  {
    name: 'design_root_change_confirm',
    description: '消费 Grant，把当前 root 修订标记为用户确认。',
    inputSchema: object({ hostSessionRef: string, nodeId: string, approvalToken: string }, [
      'hostSessionRef',
      'nodeId',
      'approvalToken',
    ]),
    readOnly: false,
    approval: 'required',
  },
  {
    name: 'delegation_policy_set',
    description: '设置节点托管策略；扩大到 agent_managed 时必须消费 Grant。',
    inputSchema: object(
      {
        hostSessionRef: string,
        nodeId: string,
        mode: { enum: ['human_final', 'agent_managed'] },
        approvalToken: string,
      },
      ['hostSessionRef', 'nodeId', 'mode'],
    ),
    readOnly: false,
    approval: 'required',
  },
  {
    name: 'changeset_lease_takeover',
    description: '消费用户 Grant 并显式接管活动 ChangeSet 写入权。',
    inputSchema: object({ hostSessionRef: string, changeSetId: string, approvalToken: string }, [
      'hostSessionRef',
      'changeSetId',
      'approvalToken',
    ]),
    readOnly: false,
    approval: 'required',
  },
];
